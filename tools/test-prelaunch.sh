#!/usr/bin/env bash
# Checks Prelaunch's list merge: lists come from players.json, every other setting is kept.
# Usage: tools/test-prelaunch.sh path/to/if-prelaunch.jar
set -e
jar="$1"; t=$(mktemp -d); mkdir -p "$t/combatradar"; cp "$jar" "$t/if-prelaunch.jar"
printf '{\n  "radarSize": 0.9,\n  "allyPlayers": [\n    "OldFriend"\n  ],\n  "enemyPlayers": [],\n  "showYLevel": true\n}\n' > "$t/combatradar/config.json"
printf '{\n  "allyPlayers": ["Alice", "Bob"],\n  "enemyPlayers": ["Mallory"]\n}\n' > "$t/combatradar/players.json"
java -jar "$t/if-prelaunch.jar"   # no pack URL = skip packwiz, merge only
c=$(cat "$t/combatradar/config.json"); rm -rf "$t"
grep -q '"allyPlayers": \["Alice", "Bob"\]' <<<"$c"
grep -q '"enemyPlayers": \["Mallory"\]' <<<"$c"
grep -q '"radarSize": 0.9' <<<"$c" && grep -q '"showYLevel": true' <<<"$c"
! grep -q OldFriend <<<"$c"
echo "prelaunch merge: ok"
