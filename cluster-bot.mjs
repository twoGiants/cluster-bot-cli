#!/usr/bin/env node
import { execFileSync } from "child_process";

// --- Constants ---
function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Error: ${name} is not set. See README.md for setup.`);
    process.exit(1);
  }
  return v;
}
const KEEPASS_DB = requireEnv("CLUSTER_BOT_KEEPASS_DB");
const KEEPASS_ENTRY = requireEnv("CLUSTER_BOT_KEEPASS_ENTRY");
const SLACK_WORKSPACE = requireEnv("CLUSTER_BOT_SLACK_WORKSPACE");
const KNOWN_BOT_USER = requireEnv("CLUSTER_BOT_KNOWN_BOT_USER");
const POLL_INTERVAL =
  parseInt(process.env.CLUSTER_BOT_POLL_INTERVAL || "10") * 1000;
const POLL_TIMEOUT =
  parseInt(process.env.CLUSTER_BOT_POLL_TIMEOUT || "300") * 1000;
const CACHE_TTL = parseInt(process.env.CLUSTER_BOT_CACHE_TTL || "3600");
const KEYRING_KEY = process.env.CLUSTER_BOT_KEYRING_KEY || "cluster-bot-cookie";

// --- Helpers ---
function die(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Cookie cache (kernel keyring) ---
function readCache() {
  try {
    const id = execFileSync("keyctl", ["request", "user", KEYRING_KEY], {
      stdio: "pipe",
    })
      .toString()
      .trim();
    const cookie = execFileSync("keyctl", ["print", id], { stdio: "pipe" })
      .toString()
      .trim();
    if (cookie) {
      execFileSync("keyctl", ["timeout", id, String(CACHE_TTL)], {
        stdio: "pipe",
      });
      console.info(`Using cached cookie (keyring TTL reset to ${CACHE_TTL}s)`);
      return cookie;
    }
  } catch (e) {
    const msg = e.message?.split("\n")[0] || "unknown error";
    if (msg.includes("request"))
      console.info(`No cached cookie in keyring, reading from KeePass...`);
    else if (msg.includes("print"))
      console.error(
        `Keyring key found but failed to read value: ${msg}. Reading from KeePass...`,
      );
    else if (msg.includes("timeout"))
      console.error(
        `Keyring key found but failed to reset TTL: ${msg}. Reading from KeePass...`,
      );
    else
      console.info(
        `Keyring cache unavailable (${msg}), reading from KeePass...`,
      );
  }
  return null;
}

function writeCache(cookie) {
  try {
    const id = execFileSync(
      "keyctl",
      ["add", "user", KEYRING_KEY, cookie, "@u"],
      { stdio: "pipe" },
    )
      .toString()
      .trim();
    execFileSync("keyctl", ["timeout", id, String(CACHE_TTL)], {
      stdio: "pipe",
    });
    console.info(`Cookie cached in kernel keyring (TTL ${CACHE_TTL}s)`);
  } catch (e) {
    console.error(`Failed to cache cookie in keyring: ${e.message}`);
  }
}

// --- KeePass ---
function getCookie() {
  const cached = readCache();
  if (cached) return cached;
  try {
    const cookie = execFileSync(
      "keepassxc-cli",
      ["show", "-s", "-a", "Password", KEEPASS_DB, KEEPASS_ENTRY],
      { stdio: ["inherit", "pipe", "inherit"] },
    )
      .toString()
      .trim();
    writeCache(cookie);
    return cookie;
  } catch {
    die("Failed to read cookie from KeePass. Is the database available?");
  }
}

// --- Token ---
async function getToken(cookie) {
  const res = await fetch(`https://${SLACK_WORKSPACE}/`, {
    headers: { Cookie: `d=${cookie}` },
    redirect: "follow",
  });
  const match = (await res.text()).match(/xoxc-[a-zA-Z0-9-]+/);
  if (!match) die("Failed to derive token from cookie. Cookie may be expired.");
  return match[0];
}

// --- Slack API ---
async function slackApi(method, params, token, cookie) {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Cookie: `d=${cookie}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json();
  if (!data.ok) {
    if (data.error === "invalid_auth")
      die("Cookie expired or invalid. Update it in KeePass.");
    die(`Slack API ${method}: ${data.error}`);
  }
  return data;
}

// --- Discovery ---
async function verifyAuth(token, cookie) {
  const data = await slackApi("auth.test", {}, token, cookie);
  return data.user_id;
}

async function discoverBot(token, cookie) {
  try {
    const data = await slackApi(
      "users.info",
      { user: KNOWN_BOT_USER },
      token,
      cookie,
    );
    if (data.user.is_bot && !data.user.deleted) return KNOWN_BOT_USER;
  } catch (e) {
    if (
      e.message?.includes("invalid_auth") ||
      e.message?.includes("Cookie expired")
    )
      throw e;
  }
  // Fallback: search for cluster-bot
  let cursor = "";
  do {
    const data = await slackApi(
      "users.list",
      { limit: "200", cursor },
      token,
      cookie,
    );
    for (const u of data.members) {
      if (u.is_bot && !u.deleted && u.name === "cluster-bot") return u.id;
    }
    cursor = data.response_metadata?.next_cursor || "";
  } while (cursor);
  die("Could not find cluster-bot user. The bot may have been reinstalled.");
}

async function discoverChannel(botUser, token, cookie) {
  const data = await slackApi(
    "conversations.open",
    { users: botUser },
    token,
    cookie,
  );
  return data.channel.id;
}

// --- Command ---
async function sendCommand(channel, text, token, cookie) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Cookie: `d=${cookie}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel, text }),
  });
  const data = await res.json();
  if (!data.ok) {
    if (data.error === "invalid_auth")
      die("Cookie expired or invalid. Update it in KeePass.");
    die(`Failed to send message: ${data.error}`);
  }
  return data.ts;
}

async function pollResponse(channel, botUser, sentTs, token, cookie) {
  const deadline = Date.now() + POLL_TIMEOUT;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL);
    const data = await slackApi(
      "conversations.history",
      { channel, oldest: sentTs, limit: "10", inclusive: "false" },
      token,
      cookie,
    );
    for (const msg of data.messages || []) {
      if (msg.user === botUser && parseFloat(msg.ts) > parseFloat(sentTs))
        return msg.text;
    }
  }
  die("Bot did not respond within timeout. Check Slack directly.");
}

// --- Output ---
function formatOutput(text) {
  return text
    .replace(/<([^|>]+)\|([^>]+)>/g, "$1") // <url|label> -> url
    .replace(/<([^>]+)>/g, "$1") // <url> -> url
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\*([^*]+)\*/g, "$1"); // *bold* -> bold
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.log(
      "Usage: cluster-bot <command>\nExamples:\n  cluster-bot list\n  cluster-bot auth\n  cluster-bot rosa create 4.22.8 8h\n  cluster-bot done\n  cluster-bot help",
    );
    process.exit(0);
  }

  const cookie = getCookie();
  const token = await getToken(cookie);
  await verifyAuth(token, cookie);
  const botUser = await discoverBot(token, cookie);
  const channel = await discoverChannel(botUser, token, cookie);
  const sentTs = await sendCommand(channel, args.join(" "), token, cookie);
  const response = await pollResponse(channel, botUser, sentTs, token, cookie);
  console.log(formatOutput(response));
}

main();
