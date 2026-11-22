// FreeCorporation - FcCore.js
// Shared core for FreeCorporation JsMacros scripts. JsMacros 1.9.x / MC 1.20+.
// Use:  const fc = require("../lib/FcCore.js");   (path relative to the calling script)
//       fc.run(() => { ... fc.walkTo(x, z); fc.wait(5); if (fc.quit()) return; });
//
// What it guarantees that the old copy-pasted code did not:
//   - one latched stop key that every wait/walk/look checks
//   - every wait/walk/look has a timeout or quit check (no endless loops)
//   - run() always releases held keys, even on error
// Reads only own position, rotation, inventory, hunger: allowed by server rules.
// Calls below were taken from working scripts (McUtilityFile.js, sorter3.js);
// re-check against jsmacros.wagyourtail.xyz if you change JsMacros version.

let quitKey = "key.keyboard.j";
let quitLatched = false;
const held = new Set(); // key names currently held by us

function setQuitKey(k) { quitKey = k; quitLatched = false; }

// True once the quit key has been pressed; stays true until setQuitKey().
function quit() {
  if (!quitLatched && KeyBind.getPressedKeys().contains(quitKey)) quitLatched = true;
  return quitLatched;
}

// KeyBind.key takes key names like "key.keyboard.w" / "key.mouse.right".
function key(k, down) {
  KeyBind.key(k, down);
  if (down) held.add(k); else held.delete(k);
}

// Releases every held key. Returns the list so a caller can press them again (pause/resume).
function releaseAll() {
  const was = Array.from(held);
  held.forEach(k => KeyBind.key(k, false));
  held.clear();
  return was;
}

// Waits n ticks. Re-presses held keys that something unpressed (GUI open, etc).
// Returns false if the stop key was hit.
function wait(n) {
  for (let i = 0; i < (n === undefined ? 1 : n); i++) {
    if (quit()) return false;
    if (held.size) {
      const down = KeyBind.getPressedKeys();
      held.forEach(k => { if (!down.contains(k)) KeyBind.key(k, true); });
    }
    Client.waitTick(1);
  }
  return true;
}

// Polls cond() each tick. true = cond met; false = timeout or stop key.
function waitUntil(cond, timeoutTicks) {
  const t = timeoutTicks === undefined ? 100 : timeoutTicks;
  for (let i = 0; i < t; i++) {
    if (cond()) return true;
    if (!wait(1)) return false;
  }
  return cond();
}

function wrap180(a) { return ((a + 540) % 360) - 180; }

// Turns gradually toward a world point (step = max degrees per tick) so the
// camera never snaps. Gets the target angles by letting the game compute them
// with lookAt(x,y,z), then restoring and interpolating, so we never hand-roll
// yaw/pitch sign conventions. Verify in game once: getYaw() must update right after lookAt.
function lookAt(x, y, z, step) {
  const s = step === undefined ? 12 : step;
  const p = Player.getPlayer();
  const y0 = p.getYaw(), p0 = p.getPitch();
  p.lookAt(x, y, z);
  const y1 = p.getYaw(), p1 = p.getPitch();
  p.lookAt(y0, p0);
  const dy = wrap180(y1 - y0), dp = p1 - p0;
  const steps = Math.ceil(Math.max(Math.abs(dy), Math.abs(dp)) / s);
  for (let i = 1; i <= steps; i++) {
    p.lookAt(wrap180(y0 + dy * i / steps), p0 + dp * i / steps);
    if (!wait(1)) return false;
  }
  p.lookAt(y1, p1);
  return true;
}

// Walks forward to (x,z). Done when within tol, or when we have passed the
// point (distance grows again while already close: the old walkTo looped forever
// in that case). Gives up after timeoutTicks. Returns true if it arrived.
// onTick (optional) runs once per tick while walking, for the caller's safety checks.
// ponytail: no obstacle handling; the caller supplies a clear straight path.
function walkTo(x, z, tol, timeoutTicks, onTick) {
  const tl = tol === undefined ? 0.1 : tol;
  const t = timeoutTicks === undefined ? 200 : timeoutTicks;
  let best = Infinity, arrived = false;
  try {
    for (let i = 0; i < t && !arrived; i++) {
      const p = Player.getPlayer();
      const d = Math.hypot(p.getX() - x, p.getZ() - z);
      if (d <= tl || (best < 0.5 && d > best + 0.05)) { arrived = true; break; }
      best = Math.min(best, d);
      p.lookAt(x, p.getY() + p.getEyeHeight(), z); // level pitch, face the point
      key("key.keyboard.w", true);
      if (!wait(1)) break;
      if (onTick) onTick();
    }
  } finally {
    key("key.keyboard.w", false);
  }
  return arrived;
}

// Blocks until a container GUI is open (chest etc). Returns inventory or null.
function waitContainer(timeoutTicks) {
  const ok = waitUntil(() => {
    const inv = Player.openInventory();
    return inv && inv.isContainer();
  }, timeoutTicks === undefined ? 30 : timeoutTicks);
  if (!ok) return null;
  wait(4); // let slot contents arrive from the server
  return Player.openInventory();
}

// Display name of an item stack with colour codes and odd spaces stripped.
// Returns "" for air/null.
function itemName(item) {
  if (!item || item.getItemId() === "minecraft:air") return "";
  const n = item.getName();
  const raw = (n && typeof n.getString === "function") ? n.getString() : n + "";
  return raw.replace(/§[0-9a-fk-or]/gi, "").replace(/[ \s]+/g, " ").trim();
}

// Eats until full when food level < minFood. Swaps the first food stack found
// in the inventory into the held hotbar slot, eats, swaps back.
// Call only on solid ground: inventory ops release sneak (see SKILL.md section 7).
function eatIfHungry(minFood) {
  const p = Player.getPlayer();
  if (p.getFoodLevel() >= (minFood === undefined ? 14 : minFood)) return false;
  const inv = Player.openInventory();
  const hand = inv.getSelectedHotbarSlotIndex() + 36;
  let from = -1;
  if (p.getMainHand().isFood()) from = hand;
  else for (let s = 9; s <= 44 && from < 0; s++) if (inv.getSlot(s).isFood()) from = s;
  if (from < 0) return false;
  const swapped = from !== hand;
  if (swapped) { inv.swap(hand, from); wait(5); }
  inv.close();
  wait(5);
  key("key.mouse.right", true);
  waitUntil(() => p.getFoodLevel() >= 20 || !p.getMainHand().isFood(), 200);
  key("key.mouse.right", false);
  if (swapped) { const i2 = Player.openInventory(); i2.swap(hand, from); wait(5); i2.close(); }
  return true;
}

// Actionbar progress bar with rolling ETA (ported from tree_farm_builder.js).
// const pr = fc.progress("Quarry", totalUnits);  pr.add(n);  (add draws the bar)
function progress(label, total) {
  let cur = 0;
  const times = []; // timestamps of the last 20 add() calls
  function draw() {
    if (!(total > 0)) return;
    const ratio = Math.min(1, cur / total);
    const filled = Math.round(ratio * 20);
    let eta = "ETA: --";
    if (times.length >= 2) {
      const ms = (times[times.length - 1] - times[0]) / (times.length - 1) * (total - cur);
      eta = "ETA: " + Math.floor(ms / 3600000) + "h " + Math.floor(ms / 60000) % 60 + "m";
    }
    Chat.actionbar(label + ": [" + "█".repeat(filled).padEnd(20, "░") + "] "
      + Math.floor(ratio * 100) + "% " + cur + "/" + total + " | " + eta);
  }
  return {
    add(n) { cur += n === undefined ? 1 : n; times.push(Date.now()); if (times.length > 20) times.shift(); draw(); },
    set(n) { cur = n; draw(); },
    draw,
  };
}

// Runs fn, always releasing keys afterwards and reporting errors in chat.
function run(fn) {
  try { fn(); }
  catch (e) { Chat.log("§c[FcCore] error: " + e); }
  finally { releaseAll(); Chat.log("§7[FcCore] stopped, keys released."); }
}

module.exports = {
  setQuitKey, quit, key, releaseAll, wait, waitUntil,
  lookAt, walkTo, waitContainer, itemName, eatIfHungry, progress, run,
};
