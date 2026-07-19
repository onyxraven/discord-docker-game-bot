// Example plugin: player count + liveness from a JSON status file the game
// server rewrites periodically, shaped like:
//   {"timestamp": 1784473685, "player_count": 3}
//
// Wire it up with labels on the game service:
//   discord.restart.plugin=/opt/games/json-status.js
//   discord.restart.status-file=/opt/games/mygame/status.json
//
// Plugin interface (see src/lib.js): export players(entry) -> count|null and
// optionally alive(entry, sinceEpochSec) -> bool. entry.labels carries the
// service's full label map, which is how a plugin reads its own arguments.
// Files are imported once per bot process - restart the bot after editing.

import { readFileSync } from 'node:fs';

const STALE_SECONDS = Math.max(1, Number(process.env.STALE_SECONDS || 600));

function readStatus(entry) {
  const file = entry?.labels?.['discord.restart.status-file'];
  if (!file) throw new Error('missing discord.restart.status-file label');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null; // missing or mid-write
  }
}

// Data is only trusted if written after minTs.
function freshStatus(entry, minTs) {
  const status = readStatus(entry);
  return status && Number(status.timestamp) >= minTs ? status : null;
}

export async function players(entry) {
  const now = Math.floor(Date.now() / 1000);
  return freshStatus(entry, now - STALE_SECONDS)?.player_count ?? 0;
}

export async function alive(entry, sinceEpochSec) {
  const now = Math.floor(Date.now() / 1000);
  return freshStatus(entry, sinceEpochSec ?? now - STALE_SECONDS) !== null;
}
