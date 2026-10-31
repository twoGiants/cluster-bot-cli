# cluster-bot CLI

Command-line interface for a Slack bot. Send commands and get responses without opening Slack.

## Prerequisites

- Node.js 18+
- `keepassxc-cli` on PATH
- `keyctl` (keyutils, included in Fedora/RHEL)

## Setup

### 1. Get your Slack session cookie

- Open your Slack workspace in a browser
- DevTools (F12) > Application > Cookies > `app.slack.com`
- Copy the `d` cookie value (starts with `xoxd-`)

### 2. Store cookie in KeePass

Create an entry in your KeePass database and paste the cookie value into the **Password** field.

### 3. Set environment variables

Add to your `~/.zshrc` (or equivalent):

```bash
export CLUSTER_BOT_KEEPASS_DB="$HOME/path/to/your/database.kdbx"
export CLUSTER_BOT_KEEPASS_ENTRY="path/to/entry"
export CLUSTER_BOT_SLACK_WORKSPACE="your-workspace.slack.com"
export CLUSTER_BOT_KNOWN_BOT_USER="UXXXXXXXXXX"
```

To find the bot user ID, search for the bot in Slack, click its profile, and copy the Member ID.

### 4. (Optional) Symlink to PATH

```bash
ln -s "$(pwd)/cluster-bot.mjs" ~/.local/bin/cluster-bot
```

## Usage

```bash
cluster-bot list
cluster-bot auth
cluster-bot rosa create 4.19 8h
cluster-bot done
cluster-bot help
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `CLUSTER_BOT_KEEPASS_DB` | Yes | - | Path to KeePass database |
| `CLUSTER_BOT_KEEPASS_ENTRY` | Yes | - | KeePass entry path containing the cookie |
| `CLUSTER_BOT_SLACK_WORKSPACE` | Yes | - | Slack workspace hostname |
| `CLUSTER_BOT_KNOWN_BOT_USER` | Yes | - | Slack bot user ID |
| `CLUSTER_BOT_POLL_INTERVAL` | No | `10` | Seconds between response polls |
| `CLUSTER_BOT_POLL_TIMEOUT` | No | `300` | Max seconds to wait for bot response |
| `CLUSTER_BOT_CACHE_TTL` | No | `3600` | Seconds to cache the cookie (avoids re-entering KeePass password) |
| `CLUSTER_BOT_KEYRING_KEY` | No | `cluster-bot-cookie` | Key name in the kernel keyring |

## How It Works

1. Reads your Slack session cookie from KeePass (prompts for master password)
2. Derives a session token from the cookie
3. Verifies authentication and discovers the bot's DM channel
4. Sends your command as a Slack message
5. Polls for the bot's response and prints it

The session cookie is valid for ~2 years. The token is derived fresh each run.
If the bot is reinstalled with a new user ID, the script auto-discovers it.

The cookie is cached in the Linux kernel keyring (`keyctl`) for 1 hour by default.
Stored in kernel memory (never touches disk), per-user session, cleared on logout.
Each run resets the timer, so the cache stays alive as long as you keep using it.
