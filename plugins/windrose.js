// Windrose status probe — a discord restart bot plugin (interface documented
// in /opt/discordbot/app/lib.js): player count + liveness from windrose_plus's
// server_status.json (a single JSON snapshot rewritten on every tick.beat),
// falling back to the newest tick.beat event in the newest logs/*.log file
// when the snapshot is missing, stale, or caught mid-write.
//
// Wired up via compose labels on the windrose service:
//   discord.restart.plugin=/opt/gsm/windrose.js
//   discord.restart.windrose=/opt/gsm/windrose/windrose_plus_data/server_status.json
// The second label is this plugin's own argument, read from the labels on the
// entry the loader passes in; it defaults to that same path when omitted.
//
// Also runnable standalone for ad-hoc checks:
//   node windrose.js [--alive] [status_file]
// (--alive exits 0/1; honors RESTARTED_AT and STALE_SECONDS from the env)

import {
  closeSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_STATUS_FILE = '/opt/gsm/windrose/windrose_plus_data/server_status.json';
const STALE_SECONDS = Math.max(1, Number(process.env.STALE_SECONDS || 600));
const TAIL_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Plugin interface

export async function players(entry) {
  return windrosePlayerCount(statusFileFor(entry));
}

export async function alive(entry, sinceEpochSec) {
  return windroseAlive(statusFileFor(entry), sinceEpochSec);
}

function statusFileFor(entry) {
  return entry?.labels?.['discord.restart.windrose'] || DEFAULT_STATUS_FILE;
}

// ---------------------------------------------------------------------------
// Probe internals

function readTail(file, bytes = TAIL_BYTES) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function parseJsonLines(text) {
  return text
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((o) => o !== null && typeof o === 'object');
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// -> {ts, count} | null
function lastSnapshot(statusFile) {
  let text;
  try {
    text = readFileSync(statusFile, 'utf8');
  } catch {
    return null;
  }
  let snap;
  try {
    snap = JSON.parse(text);
  } catch {
    // legacy multi-snapshot JSON-lines file: last complete record wins
    const objs = parseJsonLines(text).filter((o) => o.timestamp != null || o.server != null);
    snap = objs.at(-1);
  }
  if (!snap || typeof snap !== 'object') return null;
  return {
    ts: num(snap.timestamp),
    count: Math.max(
      num(snap.server?.player_count),
      Array.isArray(snap.players) ? snap.players.length : 0,
    ),
  };
}

// -> {ts, count} | null
function lastTickBeat(logDir) {
  let newest = null;
  try {
    for (const f of readdirSync(logDir)) {
      if (!f.endsWith('.log')) continue;
      const p = join(logDir, f);
      const mtime = statSync(p).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { p, mtime };
    }
  } catch {
    return null;
  }
  if (!newest) return null;
  let text;
  try {
    text = readTail(newest.p);
  } catch {
    return null;
  }
  const beat = parseJsonLines(text).filter((o) => o.ev === 'tick.beat').at(-1);
  return beat ? { ts: num(beat.ts_unix), count: num(beat.payload?.player_count) } : null;
}

// Freshest source with ts >= minTs; null when neither qualifies (server
// assumed down).
function windroseStatus(statusFile, minTs) {
  const snap = lastSnapshot(statusFile);
  if (snap && snap.ts >= minTs) return snap;
  const beat = lastTickBeat(join(dirname(statusFile), 'logs'));
  if (beat && beat.ts >= minTs) return beat;
  return null;
}

function windrosePlayerCount(statusFile) {
  const now = Math.floor(Date.now() / 1000);
  return windroseStatus(statusFile, now - STALE_SECONDS)?.count ?? 0;
}

// sinceEpochSec: only data written after this instant counts (post-restart
// liveness); omit for plain "is it fresh" liveness.
function windroseAlive(statusFile, sinceEpochSec) {
  const now = Math.floor(Date.now() / 1000);
  return windroseStatus(statusFile, sinceEpochSec ?? now - STALE_SECONDS) !== null;
}

// ---------------------------------------------------------------------------
// Standalone CLI

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const aliveMode = args[0] === '--alive';
  if (aliveMode) args.shift();
  const file = args[0] || DEFAULT_STATUS_FILE;
  if (aliveMode) {
    const since = process.env.RESTARTED_AT ? Number(process.env.RESTARTED_AT) : undefined;
    process.exit(windroseAlive(file, since) ? 0 : 1);
  }
  console.log(windrosePlayerCount(file));
}
