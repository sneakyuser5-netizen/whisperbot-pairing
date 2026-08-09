#!/usr/bin/env node
require("dotenv").config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const fs = require("fs");
const path = require("path");

// Node version check (Baileys + many deps expect Node >= 20)
const nodeMajor = Number(process.versions.node.split(".")[0] || 0);
if (nodeMajor < 20) {
  console.error(
    `Node ${process.versions.node} detected — this project requires Node >= 20. Please upgrade Node.`
  );
  process.exit(1);
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PINO_LEVEL = process.env.PINO_LEVEL || "silent"; // set to 'debug' while debugging
const PAIRING_THROTTLE_MS = 30 * 1000; // 30s cooldown per phone to avoid rapid re-requests

if (!TELEGRAM_BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN is missing.");
  process.exit(1);
}

const SESSIONS_DIR = path.join(__dirname, "sessions");

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const sessions = new Map(); // phone -> { sock, chatId }
const lastPairRequest = new Map(); // phone -> timestamp of last /pair request

/* =========================
   TELEGRAM API
========================= */

async function telegram(method, data = {}) {
  // Node 20+ has global fetch
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });

  const json = await res.json().catch(() => null);
  if (!json || json.ok === false) {
    const errMsg = (json && json.description) || `Telegram API error (no JSON or ok=false). HTTP ${res.status}`;
    const e = new Error(errMsg);
    e.raw = json;
    throw e;
  }

  return json.result;
}

async function sendTelegramMessage(chatId, text) {
  try {
    return await telegram("sendMessage", { chat_id: chatId, text });
  } catch (err) {
    // Log but don't throw — Telegram failures shouldn't crash the pairing flow
    console.error("Failed to send Telegram message:", err.message || err);
  }
}

/* =========================
   PHONE NORMALIZATION
========================= */

function normalizePhone(input) {
  if (!input) return null;
  const phone = String(input).replace(/[^\d]/g, "");
  if (phone.length < 7 || phone.length > 15) return null;
  return phone;
}

/* =========================
   WHATSAPP PAIRING
========================= */

async function createPairingSession(phone, chatId) {
  if (sessions.has(phone)) {
    await sendTelegramMessage(chatId, "⚠️ A pairing session is already active for this number.");
    return;
  }

  const now = Date.now();
  const last = lastPairRequest.get(phone) || 0;
  if (now - last < PAIRING_THROTTLE_MS) {
    await sendTelegramMessage(chatId, "⏱️ Please wait a moment before requesting another pairing code for this number.");
    return;
  }
  lastPairRequest.set(phone, now);

  const sessionPath = path.join(SESSIONS_DIR, phone);

  // Load/create auth state
  let state, saveCreds;
  try {
    ({ state, saveCreds } = await useMultiFileAuthState(sessionPath));
  } catch (err) {
    console.error("useMultiFileAuthState error:", err);
    await sendTelegramMessage(chatId, "❌ Unable to initialize session storage for pairing.");
    return;
  }

  // If we already have credentials registered, avoid requesting a code
  if (state?.creds?.registered) {
    await sendTelegramMessage(chatId, `ℹ️ +${phone} is already paired with this session.`);
    return;
  }

  // Create socket
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: PINO_LEVEL }),
    browser: ["WhisperBot", "Chrome", "1.0.0"],
  });

  sessions.set(phone, { sock, chatId });

  // Persist credentials updates
  sock.ev.on("creds.update", saveCreds);

  // Connection updates — log everything to help diagnose rejects
  sock.ev.on("connection.update", async (update) => {
    try {
      console.log("connection.update:", JSON.stringify(update, null, 2));
    } catch (e) {
      console.log("connection.update (unstringifiable):", update);
    }

    const { connection, lastDisconnect } = update;

    if (connection === "open") {
      console.log(`✅ WhatsApp connected: ${phone}`);
      await sendTelegramMessage(chatId, `✅ WhatsApp account +${phone} has been successfully connected.`);
      return;
    }

    if (connection === "close") {
      // lastDisconnect may contain structured error info
      const statusCode = lastDisconnect?.error?.output?.statusCode ?? lastDisconnect?.error?.status ?? null;
      const reasonText = lastDisconnect?.error?.message || JSON.stringify(lastDisconnect?.error || {}).slice(0, 200);

      console.log(`WhatsApp session closed for ${phone}. statusCode=${statusCode} reason=${reasonText}`);

      sessions.delete(phone);

      if (statusCode === DisconnectReason.loggedOut) {
        await sendTelegramMessage(chatId, `❌ WhatsApp rejected the pairing session for +${phone}. Please request a new code.`);
      } else {
        await sendTelegramMessage(chatId, `⚠️ WhatsApp pairing session for +${phone} was closed. Please request a new code.`);
      }
    }
  });

  // Wait for socket to become 'open' — wait up to 30s and abort if still not open
  const waitForOpen = () =>
    new Promise((resolve) => {
      let resolved = false;
      const TIMEOUT_MS = 30_000; // 30 seconds
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          sock.ev.off("connection.update", listener);
          resolve(false); // not open
        }
      }, TIMEOUT_MS);

      const listener = (update) => {
        if (update?.connection === "open" && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          sock.ev.off("connection.update", listener);
          resolve(true); // open
        }
      };

      sock.ev.on("connection.update", listener);
    });

  const opened = await waitForOpen();
  if (!opened) {
    console.warn("Socket did not reach 'open' within 30s — aborting pairing request. Please try /pair again.");
    await sendTelegramMessage(chatId, "❌ Could not establish connection to WhatsApp to request pairing code. Please try /pair again in a few seconds.");
    sessions.delete(phone);
    try {
      sock.ev.removeAllListeners();
    } catch (e) {}
    try {
      if (sock?.ws?.close) sock.ws.close();
    } catch (e) {}
    return;
  }

  // Recheck registration state in case it changed
  if (state?.creds?.registered) {
    await sendTelegramMessage(chatId, `ℹ️ +${phone} is already paired with this session.`);
    return;
  }

  // Request a single pairing code (socket is open)
  try {
    const code = await sock.requestPairingCode(phone);
    console.log(`PAIRING CODE for ${phone}: ${code}`);

    await sendTelegramMessage(
      chatId,
      `🔐 WhatsApp Pairing Code\n\nNumber: +${phone}\n\nCode: ${code}\n\n` +
        `Open WhatsApp → Linked Devices → Link a device → Link with phone number, then enter this code.\n\n` +
        `⚠️ The code is private. Do not share it.`
    );
  } catch (err) {
    console.error(`Pairing error for ${phone}:`, err && err.stack ? err.stack : err);
    sessions.delete(phone);

    // provide concise reason to Telegram (full trace stays in console)
    const msg = err?.message || "Unable to generate a WhatsApp pairing code.";
    await sendTelegramMessage(chatId, `❌ Unable to generate a WhatsApp pairing code: ${msg}`);
  }
}

/* =========================
   TELEGRAM POLLING
========================= */

let telegramOffset = 0;

async function pollTelegram() {
  while (true) {
    try {
      const updates = await telegram("getUpdates", { offset: telegramOffset, timeout: 30 });

      // updates is an array (may be empty)
      for (const update of updates || []) {
        telegramOffset = update.update_id + 1;
        const message = update.message;
        if (!message?.text) continue;

        const chatId = message.chat.id;
        const text = message.text.trim();

        if (text === "/start") {
          await sendTelegramMessage(
            chatId,
            "🤖 WhisperBot Pairing\n\nUse:\n/pair 237XXXXXXXXX\n\nA WhatsApp pairing code will be generated for you."
          );
          continue;
        }

        if (text.startsWith("/pair")) {
          const parts = text.split(/\s+/);
          const phone = normalizePhone(parts[1]);

          if (!phone) {
            await sendTelegramMessage(chatId, "📌 Usage:\n/pair 237XXXXXXXXX");
            continue;
          }

          await sendTelegramMessage(chatId, `⏳ Connecting WhatsApp +${phone}...`);

          // fire and forget pairing but await to catch immediate errors
          try {
            await createPairingSession(phone, chatId);
          } catch (err) {
            console.error("createPairingSession thrown:", err);
            await sendTelegramMessage(chatId, `❌ Error while creating pairing session: ${err.message || err}`);
          }

          continue;
        }
      }
    } catch (err) {
      // Network / Telegram errors — log and backoff
      console.error("Telegram polling error:", err && err.message ? err.message : err);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

/* =========================
   SHUTDOWN
========================= */

async function shutdown() {
  console.log("Shutting down — closing WhatsApp sockets...");
  for (const [phone, { sock }] of sessions.entries()) {
    try {
      await sock.logout().catch(() => undefined);
      sock.ev.removeAllListeners();
      // attempt a proper close if available
      if (typeof sock.ws === "object" && typeof sock.ws.close === "function") {
        try {
          sock.ws.close();
        } catch (e) {}
      }
    } catch (err) {
      // non-fatal
    }
    sessions.delete(phone);
  }
  process.exit(0);
}

process.on("SIGINT", () => {
  console.log("SIGINT received");
  shutdown();
});
process.on("SIGTERM", () => {
  console.log("SIGTERM received");
  shutdown();
});

/* =========================
   START
========================= */

async function main() {
  console.log("================================");
  console.log("🤖 WhisperBot Pairing Service");
  console.log("================================");
  console.log("Telegram bot: connected");

  await pollTelegram();
}

main().catch((err) => {
  console.error("FATAL ERROR:", err && err.stack ? err.stack : err);
  process.exit(1);
});
