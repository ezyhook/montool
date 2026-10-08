# montool — Telegram Server Monitor (Bun + grammy)

A full port of a Python server-monitoring script to **Bun** + **grammy**.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- Linux (reads `/proc/stat`, `/proc/meminfo`, `/proc/net/dev`, etc.)
- `/etc/telegram-auth.conf` — config file (see below)

## Quick start

```bash
git clone https://github.com/ezyhook/montool.git
cd montool
bun install
# minimal config: Telegram bot token + chat id
CONFIG_FILE=./telegram-auth.conf bun run index.ts   # dev run (see first-run below)
```

For a server, use the installer — it builds from this checkout, creates the
config on first run, and installs a systemd service:

```bash
# interactive (prompts for token + chat id if no config exists yet)
sudo ./install.sh

# or non-interactive
sudo BOT_TOKEN=123:abc CHAT_ID=-1001234567890 ./install.sh
```

## First run (no config yet)

Only `BOT_TOKEN` and `CHAT_ID` are required to start; everything else has
sensible defaults. There are three ways to provide a config:

1. `./install.sh` generates `/etc/telegram-auth.conf` for you (prompts or env).
2. Copy `config.example.conf` to `/etc/telegram-auth.conf` and edit it.
3. Point the app at any file with `CONFIG_FILE=/path/to.conf` (env vars also
   work as a fallback for individual keys).

If both `BOT_TOKEN` and `CHAT_ID` are missing the app exits with a clear error.

## Scripts

| Script | Purpose |
|---|---|
| `install.sh` | Build from the checkout, create config on first run, install the systemd service (`install.sh --remove` to uninstall) |
| `update.sh` | Rebuild from the checkout and restart the service (run after `git pull`) |
| `add-agent.sh` | Register an agent in the leader's `DISPATCH_MAP`: `add-agent.sh THREAD_ID URL` |
| `setup-login-alerts.sh` | Optional SSH login / failed-login Telegram alerts via PAM (`--remove` to uninstall) |

## /etc/telegram-auth.conf

```ini
BOT_TOKEN=1234567890:AAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
CHAT_ID=-1001234567890
THREAD_ID=42

# Host label and public IP (used in messages)
lable=my-server
ip4=1.2.3.4

# Role: 1 = leader (polling), 0 = agent (HTTP)
ENABLE_POLLING=1
SEND_WELCOME=0

# Agent map: { "thread_id": "http://agent-host:9797" }
DISPATCH_MAP={"123": "http://10.0.0.2:9797"}

# Authentication between leader and agents
AGENT_SECRET=changeme
AGENT_BIND=0.0.0.0:9797

# Traffic interface (empty = autodetect)
NET_IFACE=eth0

# DDoS detector
DDOS_ENABLED=1
DDOS_IFACE=eth0
DDOS_INTERVAL=5
DDOS_PPS=100000
DDOS_BPS=104857600
DDOS_CT=0.80
DDOS_TOPN=1000
DDOS_SYN=500
DDOS_COOLDOWN=60

# Agent healthcheck
HEALTH_INTERVAL_SEC=30
DOWN_ALERT_REPEAT_MIN=0
HEALTH_TIMEOUT=5
```

## Dependencies

| Package | Purpose |
|---|---|
| `grammy` | Telegram Bot API |
| `classic-level` | LevelDB (metrics and traffic storage) |
| `sharp` | SVG → PNG rendering (graphs are built as plain SVG, no native deps) |

## File layout

```
index.ts        — entry point, grammy bot, HTTP agent
config.ts       — loads /etc/telegram-auth.conf
db.ts           — LevelDB wrappers
telegram.ts     — send_text / send_image / keyboards
quota.ts        — monthly traffic counter, quota_set/reset
graphs.ts       — PNG graph rendering
monitor.ts      — CPU/RAM/DISK/SWAP/OOM/miners
net.ts          — per-interface traffic collection
ddos.ts         — DDoS detector
healthcheck.ts  — HTTP agent polling
handler.ts      — handles all /commands
```

## Modes

**Leader** (`ENABLE_POLLING=1`): receives updates via grammy long-polling and
routes commands to agents through `DISPATCH_MAP`.

**Agent** (`ENABLE_POLLING=0`): starts an HTTP server on `AGENT_BIND` and
listens on `/handle` and `/health`.

> Note: an agent/leader must run on a host whose `/proc` reflects the machine
> you want to monitor. Running under Docker monitors the container unless you
> pass `--pid=host --network=host` and mount the host `/proc`.

## Docker

```bash
docker run -d \
  --name montool \
  -v /etc/telegram-auth.conf:/etc/telegram-auth.conf:ro \
  -v $(pwd)/net_total.ldb:/app/net_total.ldb \
  -v $(pwd)/sysmetrics.ldb:/app/sysmetrics.ldb \
  --read-only \
  --tmpfs /tmp \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  montool
```

```yaml
services:
  app:
    build: .
    container_name: montool
    volumes:
      - /etc/telegram-auth.conf:/etc/telegram-auth.conf:ro
      - ./net_total.ldb:/app/net_total.ldb
      - ./sysmetrics.ldb:/app/sysmetrics.ldb
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
```
