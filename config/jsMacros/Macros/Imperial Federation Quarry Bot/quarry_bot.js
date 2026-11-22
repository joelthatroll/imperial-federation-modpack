// Imperial Federation Quarry Bot - quarry_bot.js   JsMacros 1.9.x / MC 1.20+. Needs FcCore.js in this same folder.
//
// Mines out a rectangle, 2 layers at a time, from where you stand down to a Y you choose.
//   1. Stand on one corner of the area, press K.
//   2. Stand on the opposite corner, press K.
//   3. Type the lowest Y to dig in chat, just the number (it is not sent to the server). "cancel" stops.
// It starts on the corner you stand on and mines the layer you stand in (feet + head) first.
// Stop: J. Pause/resume: P.
//
// Carry: a pickaxe WITH silk touch (for ores) and one WITHOUT silk touch (fortune is best) for
// everything else. Optional: a shovel (dirt/sand/gravel), torches, cobblestone/deepslate (plugs
// missing floors), food. Spares anywhere in the inventory are swapped in when one breaks.
// The bot never reads blocks: the server refuses ores dug without silk touch, says so in chat, and
// the bot re-digs that block with the silk pick.
// A full inventory doesn't stop it (new drops stay on the floor). If it gets stuck it plugs the
// cell ahead and uses /logout. You walk it out at the end.

const fc = require("./FcCore.js");

// ============================== CONFIG ==============================
const CONFIG = {
  MARK_KEY: "key.keyboard.k",
  QUIT_KEY: "key.keyboard.j",
  PAUSE_KEY: "key.keyboard.p",
  GROUP: "",            // chat group for alerts ("/g <GROUP> ..."). "" = alerts only in your own chat
  ROW_AXIS: "z",        // rows run along this axis

  // Hold times = the tool's mining ticks + 6: always breaks the target, too short to break the
  // block behind it too. Don't pad these: a longer hold digs into the floor or the block behind.
  // The _HASTE values are used while you have the Haste effect.
  BREAK_TICKS: 8, BREAK_TICKS_HASTE: 7,             // E5 pickaxe on stone
  DEEP_BELOW_Y: 0,                                  // below this Y blocks are deepslate (harder)
  BREAK_TICKS_DEEP: 9, BREAK_TICKS_DEEP_HASTE: 8,   // E5 pickaxe on deepslate
  SHOVEL_ABOVE_Y: 67,                               // blocks at/above this Y are dug with the shovel
  SHOVEL_TICKS: 8, SHOVEL_TICKS_HASTE: 7,

  STUCK_TRIES: 6,       // re-digs of a cell before going round it (portal blocks etc.)
  WALK_TICKS: 14,       // ticks to wait for a step to succeed
  MAX_FLOOR_FIXES: 16,  // missing floors to patch per layer before giving up
  TORCH_RADIUS: 11,     // place a torch when none is within this many blocks
  EAT_BELOW: 14,

  SLOT: { PICK: 0, SILK: 1, SHOVEL: 2, FILL: 3, TORCH: 4 },   // hotbar slots, sorted for you
  FILL: ["minecraft:cobblestone", "minecraft:cobbled_deepslate", "minecraft:deepslate"],
  TORCH: "minecraft:torch",
};
// ============================ END CONFIG ============================

const C = CONFIG, S = C.SLOT;
const ATTACK = "key.mouse.left", USE = "key.mouse.right", JUMP = "key.keyboard.space",
  SNEAK = "key.keyboard.left.shift", SPRINT = "key.keyboard.left.control";
const STOP = new Error("STOP"), BLOCKED = new Error("BLOCKED");

// ---------------------------- geometry ----------------------------
// The area in (a, b) cells: a = along ROW_AXIS (rows run this way), b = across.
function makeGeom(A, B, bottomY) {
  const alongZ = C.ROW_AXIS === "z";
  const [aA, aB] = alongZ ? [A.z, B.z] : [A.x, B.x], [bA, bB] = alongZ ? [A.x, B.x] : [A.z, B.z];
  return {
    aMin: Math.min(aA, aB), aMax: Math.max(aA, aB), bMin: Math.min(bA, bB), bMax: Math.max(bA, bB),
    topY: null, bottomY,
    toWorld: (a, b) => alongZ ? { x: b, z: a } : { x: a, z: b },
    fromWorld: (x, z) => alongZ ? { a: z, b: x } : { a: x, b: z },
  };
}
// Feet Y of pass p (cells yF and yF+1 get mined), and how many passes from topY down to bottomY.
const passFeetY = (g, p) => Math.max(g.bottomY, g.topY - 1 - 2 * p);
const passCount = g => Math.ceil((g.topY - g.bottomY + 1) / 2);

// Snake through every cell, starting on corner `start`: a row along a, step across b, row back.
function snake(g, start) {
  const db = start.b === g.bMin ? 1 : -1, cells = [];
  let from = start.a, to = start.a === g.aMin ? g.aMax : g.aMin;
  for (let b = start.b; b >= g.bMin && b <= g.bMax; b += db) {
    const da = Math.sign(to - from) || 1;
    for (let a = from; ; a += da) { cells.push({ a, b }); if (a === to) break; }
    [from, to] = [to, from];
  }
  return cells;
}

// Breadth-first path over a set of "a,b" keys. Returns cells from -> to, or null.
function pathThrough(open, from, to) {
  const key = c => c.a + "," + c.b;
  const prev = new Map([[key(from), null]]);
  const q = [from];
  while (q.length) {
    const c = q.shift();
    if (c.a === to.a && c.b === to.b) {
      const out = [];
      for (let kk = key(c); kk; kk = prev.get(kk)) { const [a, b] = kk.split(",").map(Number); out.push({ a, b }); }
      return out.reverse();
    }
    for (const n of [{ a: c.a + 1, b: c.b }, { a: c.a - 1, b: c.b }, { a: c.a, b: c.b + 1 }, { a: c.a, b: c.b - 1 }]) {
      const kk = key(n);
      if (!prev.has(kk) && open.has(kk)) { prev.set(kk, key(c)); q.push(n); }
    }
  }
  return null;
}

const needsTorch = (torches, cell, r) => !torches.some(t => Math.abs(t.a - cell.a) + Math.abs(t.b - cell.b) < r);

// ---------------------------- run state ----------------------------
let g = null;                                   // set once the area is picked
const cleared = new Set(), blocked = new Set(); // "a,b" cells of the current layer
let torches = [], ctx = {}, inHazard = false, lastPos = null, mined = 0;
let oreRefused = false, floorFixes = 0, passHeadDone = false, torchesOut = false, fullWarned = false;

const k = c => c.a + "," + c.b;
const P = () => Player.getPlayer();
const wpos = c => g.toWorld(c.a, c.b);
const pressed = key => KeyBind.getPressedKeys().contains(key);

function alertGroup(msg) {
  const p = P(), text = msg + " @ " + Math.floor(p.getX()) + "," + Math.floor(p.getY()) + "," + Math.floor(p.getZ());
  if (!C.GROUP) { Chat.log("§e[IF Quarry] " + text); return; }
  try { Chat.say("/g " + C.GROUP + " " + text); } catch (e) {}
}

// ---------------------------- waiting ----------------------------
function checkPause() {
  if (!pressed(C.PAUSE_KEY)) return;
  const keys = fc.releaseAll();
  Chat.log("§e[IF Quarry] paused. Press P again to resume.");
  while (pressed(C.PAUSE_KEY)) Client.waitTick(1);
  while (!pressed(C.PAUSE_KEY)) { if (fc.quit()) throw STOP; Client.waitTick(1); }
  while (pressed(C.PAUSE_KEY)) Client.waitTick(1);
  keys.forEach(kk => fc.key(kk, true));
  lastPos = null; // you may have moved the player by hand
  Chat.log("§a[IF Quarry] resumed.");
}

// Once per game tick: pause key, and a big jump in position means teleported or respawned.
function tick() {
  checkPause();
  if (inHazard) return;
  const p = P(), x = p.getX(), y = p.getY(), z = p.getZ();
  if (lastPos && (Math.abs(x - lastPos.x) > 8 || Math.abs(y - lastPos.y) > 8 || Math.abs(z - lastPos.z) > 8)) {
    alertGroup("teleported or respawned, stopping");
    throw STOP;
  }
  lastPos = { x, y, z };
}

function W(n) {
  for (let i = 0; i < Math.max(1, n || 1); i++) { if (!fc.wait(1)) throw STOP; tick(); }
}

function until(cond, ticks) {
  for (let i = 0; i < ticks; i++) { if (cond()) return true; W(1); }
  return cond();
}

// ---------------------------- inventory ----------------------------
const isAir = it => !it || it.getItemId() === "minecraft:air";
const silky = it => { try { return !!it.hasEnchantment("minecraft:silk_touch"); } catch (e) { return false; } };

// Does this stack belong in hotbar slot `role`?
function roleMatch(role, it) {
  if (isAir(it)) return false;
  const id = String(it.getItemId());
  switch (role) {
    case "PICK": return id.endsWith("_pickaxe") && !silky(it);
    case "SILK": return id.endsWith("_pickaxe") && silky(it);
    case "SHOVEL": return id.endsWith("_shovel");
    case "FILL": return C.FILL.includes(id);
    case "TORCH": return id === C.TORCH;
  }
  return false;
}

function roleCount(role) {
  const it = Player.openInventory().getSlot(36 + S[role]);
  return roleMatch(role, it) ? it.getCount() : 0;
}

function sel(slot) { Player.openInventory().setSelectedHotbarSlotIndex(slot); }

function invSlots(inv, fn) {
  for (let s = 0; s < inv.getTotalSlots(); s++) {
    const loc = inv.getLocation(s);
    if (loc === "main" || loc === "hotbar") fn(inv.getSlot(s));
  }
}
function countId(id) { let n = 0; invSlots(Player.openInventory(), it => { if (!isAir(it) && it.getItemId() === id) n += it.getCount(); }); return n; }
function freeSlots() { let n = 0; invSlots(Player.openInventory(), it => { if (isAir(it)) n++; }); return n; }

// Put the right item in every hotbar role slot, from anywhere in the inventory.
function arrangeHotbar() {
  const inv = Player.openInventory();
  const roleAt = {};
  for (const r in S) roleAt[36 + S[r]] = r;
  const sources = [];
  for (let s = 36; s <= 44; s++) sources.push(s); // hotbar first
  for (let s = 9; s <= 35; s++) sources.push(s);
  for (const r of ["PICK", "SILK", "SHOVEL", "TORCH", "FILL"]) {
    const hs = 36 + S[r];
    if (roleMatch(r, inv.getSlot(hs))) continue;
    for (const s of sources) {
      if (s === hs) continue;
      const it = inv.getSlot(s);
      if (roleAt[s] && roleMatch(roleAt[s], it)) continue; // already right in its own slot
      if (roleMatch(r, it)) { inv.swap(hs, s); W(3); break; }
    }
  }
  // fill slot: swap a nearly-empty stack for the biggest fill stack in the main inventory
  const hs = 36 + S.FILL, cur = inv.getSlot(hs);
  let best = -1, bestN = roleMatch("FILL", cur) && cur.getCount() >= 16 ? Infinity : (roleMatch("FILL", cur) ? cur.getCount() : 0);
  for (let s = 9; s <= 35; s++) {
    const it = inv.getSlot(s);
    if (roleMatch("FILL", it) && it.getCount() > bestN) { best = s; bestN = it.getCount(); }
  }
  if (best >= 0) { inv.swap(hs, best); W(3); }
  inv.close(); W(2);
}

// ---------------------------- block actions ----------------------------
function haste() {
  try {
    const fx = P().getStatusEffects();
    for (let i = 0; i < fx.size(); i++) if (String(fx.get(i).getId()) === "minecraft:haste") return true;
  } catch (e) {}
  return false;
}
const shovelTicks = () => haste() ? C.SHOVEL_TICKS_HASTE : C.SHOVEL_TICKS;
function ticksFor(y) {
  const h = haste();
  if (y >= C.SHOVEL_ABOVE_Y) return h ? C.SHOVEL_TICKS_HASTE : C.SHOVEL_TICKS;
  if (y < C.DEEP_BELOW_Y) return h ? C.BREAK_TICKS_DEEP_HASTE : C.BREAK_TICKS_DEEP;
  return h ? C.BREAK_TICKS_HASTE : C.BREAK_TICKS;
}

function aim(x, y, z) { if (!fc.lookAt(x, y, z, 25)) throw STOP; }
function placeOnce() { fc.key(USE, true); W(1); fc.key(USE, false); W(1); }

// Hold time for the silk pick on an ore, from Minecraft's formula (30 x hardness / speed,
// speed = tier + efficiency^2 + 1) plus 6. The same block again means the last hold fell short: +4.
const TIER = { wooden: 2, stone: 4, iron: 6, golden: 12, diamond: 8, netherite: 9 };
let lastSilk = { key: null, n: 0 };
function silkHold(bx, by, bz) {
  const key = bx + "," + by + "," + bz;
  lastSilk = lastSilk.key === key ? { key, n: lastSilk.n + 1 } : { key, n: 0 };
  const it = Player.openInventory().getSlot(36 + S.SILK);
  let eff = 0;
  try { const e = it.getEnchantment("minecraft:efficiency"); eff = e ? e.getLevel() : 0; } catch (e) {}
  const tier = TIER[(String(it.getItemId()).match(/:(\w+?)_pickaxe$/) || [])[1]] || 6;
  const hardness = by < C.DEEP_BELOW_Y ? 4.5 : 3;
  const hold = Math.ceil(30 * hardness / (tier + (eff ? eff * eff + 1 : 0))) + 6 + 4 * lastSilk.n;
  Chat.log("§7[IF Quarry] ore at " + key + ": silk touch, holding " + hold + " ticks");
  return hold;
}

// Hold attack on block (bx,by,bz). Tool and time chosen by Y unless given. Does not release attack.
// Holding attack on air breaks whatever is behind it, so only dig cells known to be solid.
// at (optional): [x, y, z] point to aim at instead of the block's own face.
function dig(bx, by, bz, ticks, slot, at) {
  if (by > g.topY) return;
  fc.key(ATTACK, false); // let go while turning, or the hold runs long
  let use = slot !== undefined ? slot : (by >= C.SHOVEL_ABOVE_Y ? S.SHOVEL : S.PICK);
  if (oreRefused) { oreRefused = false; use = S.SILK; }
  for (const r of ["PICK", "SHOVEL", "SILK"]) if (use === S[r] && !roleCount(r)) arrangeHotbar();
  if (use === S.SHOVEL && !roleCount("SHOVEL")) use = S.PICK; // no shovel: the pickaxe does it
  sel(use);
  if (at) aim(at[0], at[1], at[2]); else aimAtBlock(bx, by, bz);
  fc.key(ATTACK, true);
  W(use === S.SILK ? silkHold(bx, by, bz) : ticks !== undefined ? ticks : use === S.SHOVEL ? shovelTicks() : ticksFor(by));
  if (oreRefused && use !== S.SILK) { oreRefused = false; dig(bx, by, bz, undefined, S.SILK, at); }
}

// Aim so the crosshair can only touch this block: the side face across from us, its top if it is
// below our feet, or top/bottom if it is in our own column.
function aimAtBlock(bx, by, bz) {
  const p = P(), ex = p.getX(), ey = p.getY() + p.getEyeHeight(), ez = p.getZ();
  if (Math.floor(ex) === bx && Math.floor(ez) === bz) { aim(ex, by < ey ? by + 1 : by, ez); return; }
  if (by + 1 <= p.getY() + 0.6) { aim(bx + 0.5, by + 1, bz + 0.5); return; }
  const inside = (v, lo) => Math.min(lo + 0.98, Math.max(lo + 0.02, v));
  aim(inside(ex, bx), by + 0.5, inside(ez, bz));
}

const passLayers = yF => passHeadDone ? [yF] : [yF + 1, yF];
function digCell(w, yF) {
  for (const y of passLayers(yF)) dig(w.x, y, w.z);
  fc.key(ATTACK, false);
}

function walkTo(w, tol, ticks) {
  const ok = fc.walkTo(w.x + 0.5, w.z + 0.5, tol, ticks, tick);
  if (fc.quit()) throw STOP;
  return ok;
}
const walkCell = (c, tol) => walkTo(wpos(c), tol || 0.2, 60);

// Get into cell c from prev. Walking in is the check that the blocks are gone; where we stopped
// says why we couldn't: leaning out over an edge = no floor (place one), stopped by a wall = jump
// at it to see whether the feet or head block is left, and re-dig that one.
function moveInto(c, prev, yF) {
  const w = wpos(c);
  const done = () => { if (!cleared.has(k(c))) { cleared.add(k(c)); mined += 2; } };
  if (!cleared.has(k(c))) digCell(w, yF);
  const tries = { feet: 0, head: 0 };
  let bridgeMisses = 0;
  for (let n = 0; ; n++) {
    if (walkTo(w, 0.15, C.WALK_TICKS)) { done(); return; }
    cleared.delete(k(c));
    const pw = wpos(prev);
    if (leaningOut(pw, w)) {
      if (floorFixes >= C.MAX_FLOOR_FIXES) hazard("FLOOR MISSING at cell " + k(c) + " (patched " + floorFixes + " already this layer)");
      let placed;
      try { placed = bridgeFloor(pw, w, yF); } finally { fc.key(SNEAK, false); }
      if (!placed) {
        if (bridgeMisses++ < 1) continue; // often the floor is there and the walk stopped short
        hazard("FLOOR MISSING at cell " + k(c) + " and no fill block would place");
      }
      floorFixes++;
      Chat.log("[IF Quarry] placed a missing floor at cell " + k(c));
      continue;
    }
    if (n >= C.STUCK_TRIES) throw BLOCKED; // unbreakable (portal...): the sweep goes round it
    const what = feetOrHead(pw, w, yF);
    if (what === "clear") { done(); return; }
    redig(w, what === "feet" ? yF : yF + 1, tries, what);
  }
}

// After a walk from cell pw toward w stopped short: leaning out over an edge?
function leaningOut(pw, w) {
  const u = { x: Math.sign(w.x - pw.x), z: Math.sign(w.z - pw.z) }, p = P();
  return (p.getX() - (pw.x + 0.5)) * u.x + (p.getZ() - (pw.z + 0.5)) * u.z >= 0.5;
}

// Crouched at the edge of pw over cell w whose floor is missing: place a fill block into it the way
// a player bridges. The fill count dropping proves it went in. Placing into water/lava plugs it.
function bridgeFloor(pw, w, yF) {
  const u = { x: Math.sign(w.x - pw.x), z: Math.sign(w.z - pw.z) }, side = { x: u.z, z: u.x };
  const cx = w.x + 0.5, cz = w.z + 0.5, y = yF - 0.5;
  const aims = [[pw.x + 0.5 + u.x * 0.5, y, pw.z + 0.5 + u.z * 0.5], [cx + u.x * 0.5, y, cz + u.z * 0.5],
                [cx + side.x * 0.5, y, cz + side.z * 0.5], [cx - side.x * 0.5, y, cz - side.z * 0.5], [cx, yF - 1, cz]];
  fc.key(SNEAK, true);
  for (const a of aims) {
    if (!roleCount("FILL")) arrangeHotbar();
    if (!roleCount("FILL")) return false;
    const id = Player.openInventory().getSlot(36 + S.FILL).getItemId();
    const before = countId(id);
    sel(S.FILL);
    aim(a[0], a[1], a[2]);
    placeOnce();
    if (until(() => countId(id) < before, 6)) return true;
  }
  return false;
}

// Re-dig a block we know is there. Odd tries use the shovel (sand/gravel); each pickaxe try holds
// 4 ticks longer, never long enough to carry on into the block behind.
function redig(w, y, tries, what) {
  const n = tries[what]++, shovel = n % 2 === 1;
  dig(w.x, y, w.z, (shovel ? shovelTicks() : ticksFor(y)) + 4 * Math.floor(n / 2), shovel ? S.SHOVEL : S.PICK);
  fc.key(ATTACK, false);
}

// A wall stopped us walking from pw into w. Jump at it: standing on it = feet block, else head.
// Returns "feet", "head", or "clear". Ends back in the middle of pw.
function feetOrHead(pw, w, yF) {
  walkTo(pw, 0.15, 40);
  fc.key(JUMP, true);
  let inside;
  try { inside = walkTo(w, 0.15, 16); } finally { fc.key(JUMP, false); }
  W(12); // land before reading Y
  const climbed = P().getY() >= yF + 0.9;
  if (inside && !climbed) return "clear";
  walkTo(pw, 0.15, 40);
  return climbed ? "feet" : "head";
}

function maybeTorch(c, yF) {
  if (torchesOut || !needsTorch(torches, c, C.TORCH_RADIUS)) return;
  if (!roleCount("TORCH")) { arrangeHotbar(); if (!roleCount("TORCH")) { torchesOut = true; alertGroup("out of torches, mining on without"); return; } }
  const w = wpos(c);
  sel(S.TORCH); aim(w.x + 0.5, yF, w.z + 0.5); placeOnce();
  torches.push({ a: c.a, b: c.b });
}

// ---------------------------- hazards ----------------------------
function plugAhead() {
  if (!ctx.ahead) return;
  if (!roleCount("FILL")) arrangeHotbar();
  if (!roleCount("FILL")) return;
  sel(S.FILL);
  aim(ctx.ahead.x + 0.5, ctx.ahead.y, ctx.ahead.z + 0.5); placeOnce();
  aim(ctx.ahead.x + 0.5, ctx.ahead.y + 1, ctx.ahead.z + 0.5); placeOnce();
}

// Stuck or danger: plug the cell ahead, alert, log out.
function hazard(reason) {
  if (inHazard) return;
  inHazard = true;
  const leaning = fc.releaseAll().indexOf(SNEAK) >= 0;
  if (leaning) fc.key(SNEAK, true); // sneak holds us at an edge: keep it until we're back in our cell
  Chat.log("§c[IF Quarry] HAZARD: " + reason);
  try {
    try { plugAhead(); } catch (e) {}
    if (leaning) { try { if (ctx.cell) walkCell(ctx.cell, 0.15); } catch (e) {} fc.key(SNEAK, false); }
    alertGroup(reason);
  } finally {
    logOut();
  }
  throw STOP;
}

// CivMC's /logout is a 10 s countdown that cancels if we move: keep re-sending it until we're out.
// Press the stop key to cancel and take over.
function logOut() {
  fc.releaseAll();
  for (let i = 0; i < 8; i++) {
    try { Chat.say("/logout"); } catch (e) { return; }
    for (let t = 0; t < 240; t++) {
      Client.waitTick(1);
      if (!Player.getPlayer() || fc.quit()) return;
    }
  }
}

// ---------------------------- quarry ----------------------------
function quarry() {
  const p = P(), here = g.fromWorld(Math.floor(p.getX()), Math.floor(p.getZ()));
  const onCorner = (here.a === g.aMin || here.a === g.aMax) && (here.b === g.bMin || here.b === g.bMax);
  if (!onCorner) { Chat.log("§c[IF Quarry] stand on a corner of the area, in the layer you want mined first."); return; }
  const feetY = Math.round(p.getY());
  g.topY = feetY + 1; // head height
  if (feetY < g.bottomY) { Chat.log("§c[IF Quarry] you are already below y " + g.bottomY + "."); return; }
  const cells = snake(g, here);
  const passes = passCount(g);
  Chat.log("[IF Quarry] mining y " + feetY + " down to y " + g.bottomY + " (" + passes + " double layers)");
  let idx = 0;
  for (let pass = 0; pass < passes; pass++) {
    digDown(cells[idx], passFeetY(g, pass));
    // ponytail: if the far end was blocked the pass ends short and the next layers start from
    // there, so the cells past it are skipped below too. Fine for a stray portal block.
    idx = sweep(cells, pass, idx, pass % 2 ? -1 : 1);
  }
  ctx = { cell: cells[idx] };
  alertGroup("quarry finished: ~" + mined + " blocks. Walk me out.");
}

// Stand in the middle of cell c and dig straight down until our feet are at yT.
function digDown(c, yT) {
  ctx = { cell: c };
  const w = wpos(c);
  for (let i = 0; i < 3; i++) { // dead centre: 0.2 off and our feet still rest on the next block
    W(4);
    if (Math.hypot(P().getX() - (w.x + 0.5), P().getZ() - (w.z + 0.5)) <= 0.12) break;
    walkTo(w, 0.08, 30);
  }
  for (let fy = Math.round(P().getY()); fy > yT; fy--) {
    dig(w.x, fy - 1, w.z); fc.key(ATTACK, false);
    if (!until(() => P().getY() < fy - 0.5, 30)) hazard("STUCK digging down at y=" + (fy - 1));
  }
  W(4); // land
}

function sweep(cells, pass, idx, dir) {
  const yF = passFeetY(g, pass);
  passHeadDone = pass > 0 && yF + 1 >= passFeetY(g, pass - 1); // odd depth: last layer's top is already dug
  floorFixes = 0;
  cleared.clear(); blocked.clear(); torches = [];
  let prev = cells[idx], steps = 0, end = idx;
  const at = c => {
    ctx = { cell: c };
    for (const r of ["PICK", "SILK"]) {
      if (!roleCount(r)) { arrangeHotbar(); if (!roleCount(r)) { alertGroup("out of " + (r === "SILK" ? "silk touch " : "") + "pickaxes, stopping"); throw STOP; } }
    }
    if (++steps % 20 === 0) fc.eatIfHungry(C.EAT_BELOW);
    if (!fullWarned && freeSlots() === 0) { fullWarned = true; alertGroup("inventory full, mining on (new drops stay on the floor)"); }
    // never torch the two ends: the next pass digs straight down there
    if (c !== cells[0] && c !== cells[cells.length - 1]) maybeTorch(c, yF);
  };
  cleared.add(k(prev));
  at(prev);
  for (let i = idx + dir; i >= 0 && i < cells.length; i += dir) {
    try {
      stepInto(cells[i], prev, yF);
    } catch (e) {
      if (e !== BLOCKED) throw e;
      i = routeAround(cells, i, dir, yF, prev);
      if (i < 0) break; // nothing left to reach this way
    }
    prev = cells[i]; end = i;
    at(prev);
  }
  return end;
}

function stepInto(c, from, yF) {
  ctx = { cell: from, ahead: { x: wpos(c).x, y: yF, z: wpos(c).z } };
  speedMoveInto(c, from, yF);
}

// cells[i] is blocked: find the next cell past it, get there through this layer, return its index.
// -1 = none left this way.
function routeAround(cells, i, dir, yF, from) {
  for (let tries = 0; tries < 20; tries++) {
    blocked.add(k(cells[i]));
    let j = i;
    while (j >= 0 && j < cells.length && blocked.has(k(cells[j]))) j += dir;
    if (j < 0 || j >= cells.length) return -1;
    const path = detour(from, cells[j]);
    if (!path) hazard("STUCK: no way round the blocked cells to " + k(cells[j]));
    Chat.log("§e[IF Quarry] can't get into " + Array.from(blocked).join(" ") + ": going round (" + (path.length - 1) + " steps)");
    let n = 1;
    try {
      for (; n < path.length; n++) {
        const s = path[n];
        if (cleared.has(k(s))) { if (!walkCell(s, 0.2)) throw BLOCKED; }
        else stepInto(s, path[n - 1], yF);
      }
      return j;
    } catch (e) {
      if (e !== BLOCKED) throw e;
      blocked.add(k(path[n]));
      from = path[n - 1];
    }
  }
  hazard("STUCK: too many blocked cells around " + k(from));
}

// Shortest way round: through cleared cells unless that is 4x longer than digging through.
function detour(from, to) {
  const open = new Set();
  for (let a = g.aMin; a <= g.aMax; a++) for (let b = g.bMin; b <= g.bMax; b++) if (!blocked.has(a + "," + b)) open.add(a + "," + b);
  const dug = pathThrough(open, from, to);
  const walk = pathThrough(new Set(Array.from(cleared).concat(k(to))), from, to);
  return walk && (!dug || walk.length <= 4 * dug.length) ? walk : dug;
}

// Nothing is assumed solid (parts may be mined already), so walk at the cell first and only dig
// what stops us: the head block (aimed at eye level, so it can't reach the floor), then the feet
// block, then moveInto works out which is left.
// ponytail: an air head block near a row end can take one head block just outside the area.
function speedMoveInto(c, prev, yF) {
  const w = wpos(c);
  const ok = () => { cleared.add(k(c)); mined += 2; };
  if (speedWalk(w)) return ok();
  const p = P();
  dig(w.x, yF + 1, w.z, undefined, undefined, [w.x + 0.5, p.getY() + p.getEyeHeight(), w.z + 0.5]); fc.key(ATTACK, false);
  if (speedWalk(w)) return ok();
  dig(w.x, yF, w.z); fc.key(ATTACK, false);
  if (speedWalk(w)) return ok();
  cleared.add(k(c)); // so moveInto doesn't dig both blocks blind
  moveInto(c, prev, yF);
}

// Sprint at cell w's middle. true = got there (or ran past it).
function speedWalk(w) {
  const x = w.x + 0.5, z = w.z + 0.5;
  let best = Infinity, still = 0;
  try {
    for (let t = 0; t < 40; t++) {
      const p = P(), d = Math.hypot(p.getX() - x, p.getZ() - z);
      if (d <= 0.15 || (best < 0.5 && d > best + 0.05)) return true;
      still = d > best - 0.02 ? still + 1 : 0;
      if (still >= 3) return false;
      best = Math.min(best, d);
      p.lookAt(x, p.getY() + p.getEyeHeight(), z);
      fc.key("key.keyboard.w", true); fc.key(SPRINT, true);
      W(1);
    }
    return false;
  } finally { fc.key("key.keyboard.w", false); fc.key(SPRINT, false); }
}

// ---------------------------- picking the area ----------------------------
function here() {
  const p = P();
  return { x: Math.floor(p.getX()), y: Math.floor(p.getY()), z: Math.floor(p.getZ()) };
}

function waitMark(what) {
  Chat.log("[IF Quarry] stand on " + what + " and press K");
  while (!pressed(C.MARK_KEY)) if (!fc.wait(1)) throw STOP;
  while (pressed(C.MARK_KEY)) if (!fc.wait(1)) throw STOP;
  const h = here();
  Chat.log("§a[IF Quarry] " + what + ": " + h.x + ", " + h.z);
  return h;
}

// Next chat line you type, kept off the server.
function askChat() {
  let typed = null;
  const l = JsMacros.on("SendMessage", true, JavaWrapper.methodToJava(e => {
    if (typed === null) { typed = String(e.message || "").trim(); e.cancel(); }
  }));
  try { while (typed === null) if (!fc.wait(1)) throw STOP; }
  finally { JsMacros.off(l); }
  return typed;
}

function main() {
  fc.setQuitKey(C.QUIT_KEY);
  arrangeHotbar();
  if (!roleCount("SILK")) { Chat.log("§c[IF Quarry] no silk touch pickaxe in your inventory"); return; }
  if (!roleCount("PICK")) { Chat.log("§c[IF Quarry] no pickaxe without silk touch in your inventory (fortune is best)"); return; }
  const a = waitMark("corner 1"), b = waitMark("corner 2");
  const feet = here().y;
  Chat.log("[IF Quarry] area " + (Math.abs(a.x - b.x) + 1) + " x " + (Math.abs(a.z - b.z) + 1) +
    ". Type the lowest Y to dig (" + feet + " down to -64), or cancel:");
  let y;
  for (;;) {
    const t = askChat();
    if (/^cancel$/i.test(t)) { Chat.log("[IF Quarry] cancelled"); return; }
    y = Number(t);
    if (Number.isInteger(y) && y >= -64 && y <= feet) break;
    Chat.log("§c[IF Quarry] \"" + t + "\" isn't a Y from " + feet + " to -64. Try again:");
  }
  Chat.log("§a[IF Quarry] digging y " + feet + " to " + y + ". Stay on this corner.");
  g = makeGeom(a, b, y);
  quarry();
}

if (typeof JsMacros === "undefined") {
  module.exports = { makeGeom, snake, passFeetY, passCount, pathThrough }; // node tests
} else fc.run(() => {
  // The server's "...without a silk touch pickaxe" message is how ores are recognised (see dig)
  let listener = null;
  try {
    listener = JsMacros.on("RecvMessage", JavaWrapper.methodToJava(e => {
      if (e.text && /without a silk touch pickaxe/i.test(String(e.text.getString()))) oreRefused = true;
    }));
  } catch (e) { Chat.log("§e[IF Quarry] can't listen to chat (" + e + "): ores the server refuses will end in STUCK"); }
  try { main(); }
  catch (e) {
    if (e !== STOP) { Chat.log("§c[IF Quarry] ERROR: " + e); alertGroup("script error: " + e); }
    else alertGroup("stopped: ~" + mined + " blocks");
  }
  finally { if (listener) JsMacros.off(listener); }
});
