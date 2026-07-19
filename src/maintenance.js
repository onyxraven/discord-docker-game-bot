// Unattended maintenance restart of a labeled compose service, sharing the
// bot's config (.env), service discovery, player checks, and liveness wait.
// Run from host cron via the bot container:
//   docker compose exec -T bot node src/maintenance.js <service> [--pull] [--force]

//
// Waits while players are online (MAINT_MAX_ATTEMPTS x MAINT_RETRY_SECONDS),
// then restarts (--pull: pull + recreate instead), then waits for the service
// to come back up. Announcements go to DISCORD_CHANNEL_ID using the bot token
// over plain REST — the gateway bot process is untouched.
//
// Exit codes: 0 restarted, 1 skipped-or-failed, 2 usage/config error.

import { REST, Routes } from 'discord.js';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  composeCmd, composeFilesFromEnv, discoverServices, fence, need, playerCount, waitForUp,
} from './lib.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const name = args.find((a) => !a.startsWith('--'));
if (!name) {
  console.error('usage: node maintenance.js <service> [--pull] [--force]');
  process.exit(2);
}

const TOKEN = need('DISCORD_TOKEN');
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '';
const RETRY = Math.max(1, Number(process.env.MAINT_RETRY_SECONDS || 300));
const MAX_ATTEMPTS = Math.max(1, Number(process.env.MAINT_MAX_ATTEMPTS || 6));
const UP_TIMEOUT = Math.max(0, Number(process.env.MAINT_UP_TIMEOUT_SECONDS || 300));

const log = (msg) => console.log(`${new Date().toISOString()} [${name}] ${msg}`);

const rest = new REST().setToken(TOKEN);
async function announce(content) {
  if (!CHANNEL_ID) return;
  try {
    await rest.post(Routes.channelMessages(CHANNEL_ID), { body: { content } });
  } catch (err) {
    log(`announce failed (non-fatal): ${err.message}`);
  }
}

const entry = discoverServices(composeFilesFromEnv())[name];
if (!entry) {
  console.error(`unknown service ${name} — no discord.restart.enable=true label found for it`);
  process.exit(2);
}

async function occupiedCount() {
  try {
    return await playerCount(entry);
  } catch (err) {
    log(`player check failed, treating as unknown: ${err.message}`);
    return null;
  }
}

let count = await occupiedCount();
let attempt = 0;
while (count > 0 && attempt < MAX_ATTEMPTS) {
  attempt += 1;
  log(`attempt ${attempt}/${MAX_ATTEMPTS}: ${count} player(s) online — waiting ${RETRY}s`);
  await announce(
    `⚠️ **${name}** maintenance restart incoming in ${RETRY}s — ${count} player(s) online, waiting for them to leave.`,
  );
  await sleep(RETRY * 1000);
  count = await occupiedCount();
}

if (count > 0 && !flags.has('--force')) {
  log(`still occupied after ${attempt} attempts — skipping`);
  await announce(
    `⚠️ **${name}** players still online after ${Math.round((MAX_ATTEMPTS * RETRY) / 60)} min — skipping today's maintenance restart. The server might get stale and need a manual restart.`,
  );
  process.exit(1);
}

const why = count > 0 ? `${count} player(s) online, forced` : count === null ? 'player check unavailable' : 'server empty';
const restartedAt = Math.floor(Date.now() / 1000);
log(`restarting (${why})`);
await announce(`🔄 **${name}** maintenance restart starting (${why}).`);
try {
  if (flags.has('--pull')) {
    await composeCmd(entry, ['pull', entry.svc], 45 * 60_000);
    await composeCmd(entry, ['up', '-d', '--force-recreate', entry.svc], 10 * 60_000);
  } else {
    await composeCmd(entry, ['restart', entry.svc], 10 * 60_000);
  }
} catch (err) {
  log(`restart FAILED: ${err.message}`);
  await announce(`❌ **${name}** maintenance restart FAILED: ${fence(err)}`);
  process.exit(1);
}
log('restart OK');

const up = await waitForUp(entry, UP_TIMEOUT * 1000, restartedAt);
if (up === null) {
  log('no liveness check configured — done');
  await announce(`✅ **${name}** maintenance restart done.`);
} else if (up) {
  log('confirmed up');
  await announce(`✅ **${name}** is back up after the maintenance restart.`);
} else {
  log(`not confirmed up within ${UP_TIMEOUT}s`);
  await announce(`⚠️ **${name}** restarted but not confirmed up after ${UP_TIMEOUT}s — may still be loading.`);
}
