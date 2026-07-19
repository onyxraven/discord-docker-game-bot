// Shared pieces for the discord restart bot (index.js) and the unattended
// maintenance runner (maintenance.js): compose-label service discovery,
// player checks, compose actions, and the liveness wait.
//
// Plugin interface: the discord.restart.plugin label names an ESM file that
// is imported dynamically (once per process — edits need a bot restart) and
// may export:
//   players(entry) -> count | null        player check   (async ok)
//   alive(entry, sinceEpochSec) -> bool   liveness check (async ok; only data
//                                          newer than sinceEpochSec counts)
// The entry carries the service's full label map as entry.labels, so a plugin
// can read its own arguments from labels (e.g. discord.restart.<plugin-arg>).

import { GameDig } from 'gamedig';
import spawn from 'nano-spawn';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';

export function need(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

export function composeFilesFromEnv() {
  return need('COMPOSE_FILES').split(',').map((s) => s.trim()).filter(Boolean);
}

function normalizeLabels(labels) {
  if (!labels) return {};
  if (Array.isArray(labels)) {
    return Object.fromEntries(
      labels.map((l) => {
        const s = String(l);
        const i = s.indexOf('=');
        return i < 0 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)];
      }),
    );
  }
  return Object.fromEntries(Object.entries(labels).map(([k, v]) => [k, String(v)]));
}

export function discoverServices(composeFiles) {
  const services = {};
  for (const file of composeFiles) {
    let doc;
    try {
      doc = parseYaml(readFileSync(file, 'utf8'));
    } catch (err) {
      console.error(`skipping ${file}: ${err.message}`);
      continue;
    }
    for (const [svc, def] of Object.entries(doc?.services ?? {})) {
      const labels = normalizeLabels(def?.labels);
      if (labels['discord.restart.enable'] !== 'true') continue;
      const name = labels['discord.restart.name'] || svc;
      services[name] = {
        file,
        svc,
        labels,
        gamedig: labels['discord.restart.gamedig'] || null,
        plugin: labels['discord.restart.plugin'] || null,
        checkCmd: labels['discord.restart.check'] || null,
        upCheck: labels['discord.restart.upcheck'] || null,
      };
    }
  }
  return services;
}

function gamedigQuery(entry) {
  const [type, host, port] = entry.gamedig.split(':');
  return GameDig.query({
    type,
    host: host || '127.0.0.1',
    port: port ? Number(port) : undefined,
    socketTimeout: 5000,
  });
}

// Dynamic import caches by URL, so each plugin file is loaded once per
// process; a throwing import (bad path, syntax error) surfaces to the caller.
function loadPlugin(entry) {
  return import(pathToFileURL(entry.plugin).href);
}

export async function playerCount(entry) {
  if (entry.gamedig) {
    const state = await gamedigQuery(entry);
    return state.players?.length ?? state.numplayers ?? 0;
  }
  if (entry.plugin) {
    const mod = await loadPlugin(entry);
    if (typeof mod.players !== 'function') {
      throw new Error(`plugin ${entry.plugin} does not export players()`);
    }
    return await mod.players(entry);
  }
  if (entry.checkCmd) {
    const { stdout } = await spawn('/bin/sh', ['-c', entry.checkCmd], { timeout: 30_000 });
    const n = parseInt(stdout.trim(), 10);
    if (Number.isNaN(n)) throw new Error(`check command output not a number: ${stdout.trim()}`);
    return n;
  }
  return null;
}

export function composeCmd(entry, args, timeoutMs) {
  return spawn('docker', ['compose', '-f', entry.file, ...args], { timeout: timeoutMs });
}

export function fence(err) {
  const text = (err.stderr || err.stdout || err.message || 'unknown error').toString().slice(-1500);
  return '```\n' + text + '\n```';
}

// Wait until the service looks up again: the upcheck label command (run with
// RESTARTED_AT=sinceEpochSec exported, so it can require data newer than the
// restart), else the plugin's alive() with the same contract, else a
// successful gamedig query. Returns true/false, or null when the entry has no
// way to check liveness.
export async function waitForUp(entry, timeoutMs, sinceEpochSec) {
  const plugin = entry.plugin ? await loadPlugin(entry).catch(() => null) : null;
  const pluginAlive = typeof plugin?.alive === 'function' ? plugin.alive : null;
  if (!entry.upCheck && !pluginAlive && !entry.gamedig) return null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (entry.upCheck) {
        await spawn('/bin/sh', ['-c', entry.upCheck], {
          timeout: 30_000,
          env: { ...process.env, RESTARTED_AT: String(sinceEpochSec) },
        });
      } else if (pluginAlive) {
        if (!(await pluginAlive(entry, sinceEpochSec))) throw new Error('not up yet');
      } else {
        await gamedigQuery(entry);
      }
      return true;
    } catch {
      // not up yet
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(10_000, remaining));
  }
}
