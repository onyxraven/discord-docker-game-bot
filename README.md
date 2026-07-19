# discord-restart-bot

A small Discord bot for self-hosted game servers running under docker
compose: members of an allowed role can pull the latest image and restart a
server with a slash command — but only when nobody is playing (unless they
force it). A companion maintenance runner does the same thing unattended from
cron, waiting for the server to empty first.

- **`/restart service [force]`** — warns the channel, checks players, then
  `docker compose pull` + `up -d --force-recreate`, and confirms the server
  came back up. Role-gated.
- **`/players service`** — current player count. Open to everyone.
- **Maintenance runner** — `node src/maintenance.js <service> [--pull]
  [--force]` from cron: waits (with Discord announcements) while players are
  online, restarts, confirms liveness, and reports the outcome to a channel.
- **Config lives in your compose files** — services opt in with labels; the
  bot's own config is a small `.env`.
- **Player checks**: [gamedig](https://github.com/gamedig/node-gamedig)
  queries, a tiny JS plugin interface, or any shell command that prints a
  number.

## Quick start

1. Create a Discord application (<https://discord.com/developers/applications>):
   Bot → Reset Token (no privileged intents needed), then install it to your
   server with scopes `bot` + `applications.commands`.
2. On the docker host:

```bash
mkdir /opt/discord-restart-bot && cd /opt/discord-restart-bot
curl -fsSLO https://raw.githubusercontent.com/onyxraven/discord-restart-bot/main/examples/docker-compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/onyxraven/discord-restart-bot/main/.env.example
# fill in .env: token, guild ID, role IDs, and your compose file paths
# edit docker-compose.yml: mount your compose project dirs (read-only)
docker compose up -d
docker compose logs -f   # "ready as MyBot#1234; services: valheim, ..."
```

3. Label a game service in your own compose file and restart the bot to pick
   up the new slash-command choice:

```yaml
services:
  valheim:
    image: gameservermanagers/gameserver:vh
    network_mode: host
    labels:
      - "discord.restart.enable=true"
      - "discord.restart.gamedig=valheim:127.0.0.1:2457"
```

The image is published as `ghcr.io/onyxraven/discord-restart-bot:latest`
(also `:main` and semver tags on releases).

## Labels

Add to any service in a compose file listed in `COMPOSE_FILES` (see
[examples/game-service-labels.yml](examples/game-service-labels.yml)):

| Label | Required | Meaning |
| --- | --- | --- |
| `discord.restart.enable=true` | yes | opt this service in |
| `discord.restart.name=<name>` | no | slash-command choice name (default: service key) |
| `discord.restart.gamedig=<type>:<host>:<port>` | no | player check via gamedig; query success doubles as the liveness check |
| `discord.restart.plugin=<path>` | no | JS plugin exporting `players()` / `alive()` (see below) |
| `discord.restart.check=<command>` | no | player check: shell command printing a number |
| `discord.restart.upcheck=<command>` | no | liveness check: exits 0 once the server is up; gets `RESTARTED_AT=<epoch>` in its environment |

Player-check precedence: `gamedig`, else `plugin`, else `check`, else no check
(restarts proceed unguarded). Liveness precedence: `upcheck`, else
`plugin.alive`, else `gamedig`; with none, results say "restarted" without
confirming the server came back.

Label edits are picked up per-command; the slash-command *choices* list
refreshes on bot restart.

## Plugins

`discord.restart.plugin=<path>` names an ESM file imported in-process (once
per bot process — restart the bot after editing it; maintenance runs are
fresh processes and always get the latest):

```js
export async function players(entry) { ... }             // -> count | null
export async function alive(entry, sinceEpochSec) { ... } // -> bool; only data
                                                          // newer than sinceEpochSec counts
```

`entry.labels` carries the service's full label map, so plugins define their
own argument labels. See
[examples/plugins/json-status.js](examples/plugins/json-status.js) for a
complete example reading a status file the game server rewrites periodically.
Plugin files must be reachable inside the container (mount them read-only,
like the compose dirs).

## Unattended maintenance

Run the maintenance runner from host cron via the bot container so it shares
the bot's config (see [examples/maintenance.cron](examples/maintenance.cron)):

```
docker compose -f /opt/discord-restart-bot/docker-compose.yml exec -T bot \
  node src/maintenance.js <service> [--pull] [--force]
```

It waits while players are online (`MAINT_MAX_ATTEMPTS` ×
`MAINT_RETRY_SECONDS`, announcing each attempt to `DISCORD_CHANNEL_ID`), then
`docker compose restart` (or pull + recreate with `--pull`), then waits for
liveness. Exit codes: `0` restarted, `1` skipped or failed, `2` usage/config
error.

## Environment

See [.env.example](.env.example). `DISCORD_TOKEN`, `DISCORD_GUILD_ID`,
`DISCORD_ROLE_IDS`, and `COMPOSE_FILES` are required; the rest have sane
defaults.

## Security notes

- The docker socket mount is **root-equivalent access to the host**. The bot
  only ever runs fixed `docker compose` argv against labeled services, but
  keep `DISCORD_ROLE_IDS` tight, and don't add `check`/`upcheck` commands or
  plugins you wouldn't run as root.
- `/players` is intentionally read-only and open to everyone; everything that
  mutates state is role-gated.
- Keep `.env` out of version control (it holds your bot token).

## License

[MIT](LICENSE)
