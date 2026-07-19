// Discord bot: role-gated `docker compose pull` + restart of labeled services.
//
// Services opt in via labels in their own compose file:
//   discord.restart.enable=true
//   discord.restart.name=valheim                    (optional alias, defaults to service key)
//   discord.restart.gamedig=valheim:127.0.0.1:2457  (optional player check: type:host[:port])
//   discord.restart.plugin=/path/to/plugin.js     (optional: JS plugin exporting players()/alive(),
//                                                    dynamically imported — see lib.js; the plugin
//                                                    reads its own args from the service labels)
//   discord.restart.check=/path/to/players.sh    (optional player check: command printing a number)
//   discord.restart.upcheck=/path/to/alive.sh       (optional liveness check: exits 0 when up;
//                                                    plugin/gamedig services get this for free)
//
// Bot config comes from the environment (.env via compose): see .env.example
// Shared logic lives in lib.js; maintenance.js is the unattended cron runner.

import {
  Client,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  composeCmd, composeFilesFromEnv, discoverServices, fence, need, playerCount, waitForUp,
} from './lib.js';

const TOKEN = need('DISCORD_TOKEN');
const GUILD_ID = need('DISCORD_GUILD_ID');
const ROLE_IDS = need('DISCORD_ROLE_IDS').split(',').map((s) => s.trim()).filter(Boolean);
const COMPOSE_FILES = composeFilesFromEnv();
const WARN_DELAY = Math.max(0, Number(process.env.WARN_DELAY_SECONDS || 0));
const UP_TIMEOUT = Math.max(0, Number(process.env.MAINT_UP_TIMEOUT_SECONDS || 300));

// ---------------------------------------------------------------------------
// Busy tracking: one restart per service at a time. Entries carry their start
// time and expire after BUSY_TTL_MS, so a wedged or crashed restart can't
// lock a service out until the next bot restart.

const BUSY_TTL_MS = 60 * 60_000; // pull (45m) + up (10m) + slack
const busy = new Map(); // name -> epoch ms the restart started

function isBusy(name) {
  const startedAt = busy.get(name);
  if (startedAt === undefined) return false;
  if (Date.now() - startedAt > BUSY_TTL_MS) {
    console.warn(`clearing stale busy entry for ${name} (started ${new Date(startedAt).toISOString()})`);
    busy.delete(name);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Command handlers

function memberHasRole(interaction) {
  const roles = interaction.member?.roles;
  if (!roles) return false;
  const ids = Array.isArray(roles) ? roles : [...roles.cache.keys()];
  return ids.some((id) => ROLE_IDS.includes(id));
}

// Re-reads compose files so label edits apply without a bot restart (the
// slash-command choices list only refreshes on bot restart, though).
function resolveService(interaction) {
  const name = interaction.options.getString('service');
  return { name, entry: discoverServices(COMPOSE_FILES)[name] };
}

async function handlePlayers(interaction) {
  await interaction.deferReply();
  const { name, entry } = resolveService(interaction);
  if (!entry) {
    await interaction.editReply(`Unknown service **${name}** — was it removed from the compose file?`);
    return;
  }
  try {
    const count = await playerCount(entry);
    await interaction.editReply(
      count === null
        ? `**${name}** has no player check configured.`
        : `**${name}**: ${count} player(s) online.`,
    );
  } catch (err) {
    await interaction.editReply(`Player check for **${name}** failed: ${fence(err)}`);
  }
}

// -> string note to append to the warning, or null to abort the restart.
async function playersGate(interaction, name, entry, force) {
  let count;
  try {
    count = await playerCount(entry);
  } catch (err) {
    console.error(`player check for ${name} failed:`, err.message);
    return ' (player check failed, proceeding)';
  }
  if (count === null || count === 0) return '';
  if (!force) {
    await interaction.editReply(
      `🚫 Not restarting **${name}** — ${count} player(s) online. Use \`force: True\` to restart anyway.`,
    );
    return null;
  }
  return ` (${count} player(s) online, forced)`;
}

// Completion messages go through channel.send: image pulls can outlive the
// 15-minute interaction token.
async function pullAndRestart(interaction, name, entry) {
  const restartedAt = Math.floor(Date.now() / 1000);
  try {
    await composeCmd(entry, ['pull', entry.svc], 45 * 60_000);
  } catch (err) {
    await interaction.channel.send(`❌ Pull failed for **${name}**: ${fence(err)}`);
    return;
  }
  try {
    await composeCmd(entry, ['up', '-d', '--force-recreate', entry.svc], 10 * 60_000);
  } catch (err) {
    await interaction.channel.send(`❌ Restart failed for **${name}**: ${fence(err)}`);
    return;
  }

  const up = await waitForUp(entry, UP_TIMEOUT * 1000, restartedAt);
  if (up === null) {
    await interaction.channel.send(`✅ **${name}** pulled and restarted.`);
  } else if (up) {
    await interaction.channel.send(`✅ **${name}** pulled, restarted, and back up.`);
  } else {
    await interaction.channel.send(
      `⚠️ **${name}** restarted but not confirmed up after ${UP_TIMEOUT}s — may still be loading.`,
    );
  }
}

async function handleRestart(interaction) {
  if (!memberHasRole(interaction)) {
    await interaction.reply({
      content: 'You do not have permission to restart servers.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply();
  const { name, entry } = resolveService(interaction);
  if (!entry) {
    await interaction.editReply(`Unknown service **${name}** — was it removed from the compose file?`);
    return;
  }
  if (isBusy(name)) {
    await interaction.editReply(`**${name}** is already being restarted, hold on.`);
    return;
  }

  const force = interaction.options.getBoolean('force') ?? false;
  const checkNote = await playersGate(interaction, name, entry, force);
  if (checkNote === null) return;

  busy.set(name, Date.now());
  try {
    await interaction.editReply(
      `⚠️ **${name}** is being updated and restarted${WARN_DELAY ? ` in ${WARN_DELAY}s` : ''} — requested by ${interaction.user}${checkNote}`,
    );
    if (WARN_DELAY) await sleep(WARN_DELAY * 1000);
    await pullAndRestart(interaction, name, entry);
  } finally {
    busy.delete(name);
  }
}

// ---------------------------------------------------------------------------
// Wiring

const handlers = {
  players: handlePlayers, // open to everyone
  restart: handleRestart, // role-gated
};

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  const services = discoverServices(COMPOSE_FILES);
  const names = Object.keys(services);
  if (names.length === 0) {
    console.warn('no services labeled discord.restart.enable=true were found');
  }
  const choices = names.slice(0, 25).map((n) => ({ name: n, value: n }));

  const commands = [
    new SlashCommandBuilder()
      .setName('restart')
      .setDescription('Pull the latest image and restart a game server')
      .addStringOption((o) =>
        o.setName('service').setDescription('Service to restart').setRequired(true).addChoices(...choices))
      .addBooleanOption((o) =>
        o.setName('force').setDescription('Restart even if players are online')),
    new SlashCommandBuilder()
      .setName('players')
      .setDescription('Check how many players are online')
      .addStringOption((o) =>
        o.setName('service').setDescription('Service to check').setRequired(true).addChoices(...choices)),
  ].map((c) => c.toJSON());

  const rest = new REST().setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.application.id, GUILD_ID), { body: commands });
  console.log(`ready as ${client.user.tag}; services: ${names.join(', ') || '(none)'}`);
});

client.on('interactionCreate', (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const handler = handlers[interaction.commandName];
  if (!handler) return;
  handler(interaction).catch((err) => {
    console.error(`${interaction.commandName} handler failed:`, err);
  });
});

process.on('SIGTERM', () => client.destroy().then(() => process.exit(0)));
process.on('SIGINT', () => client.destroy().then(() => process.exit(0)));

client.login(TOKEN);
