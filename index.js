require("dotenv").config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const fs = require("fs");
const path = require("path");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_BOT_TOKEN) {
    console.error("❌ TELEGRAM_BOT_TOKEN is missing.");
    process.exit(1);
}

const SESSIONS_DIR = path.join(__dirname, "sessions");

if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

const sessions = new Map();

/* =========================
   TELEGRAM API
========================= */

async function telegram(method, data = {}) {
    const response = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(data)
        }
    );

    const result = await response.json();

    if (!result.ok) {
        throw new Error(
            result.description || "Telegram API request failed"
        );
    }

    return result.result;
}

async function sendTelegramMessage(chatId, text) {
    return telegram("sendMessage", {
        chat_id: chatId,
        text
    });
}

/* =========================
   PHONE NORMALIZATION
========================= */

function normalizePhone(input) {
    if (!input) return null;

    const phone = String(input).replace(/[^\d]/g, "");

    if (phone.length < 7 || phone.length > 15) {
        return null;
    }

    return phone;
}

/* =========================
   WHATSAPP PAIRING
========================= */

async function createPairingSession(phone, chatId) {

    if (sessions.has(phone)) {
        await sendTelegramMessage(
            chatId,
            "⚠️ A pairing session is already active for this number."
        );
        return;
    }

    const sessionPath = path.join(
        SESSIONS_DIR,
        phone
    );

    /*
     * Load existing authentication state.
     */
    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(sessionPath);

    /*
     * ONLY ONE WhatsApp socket.
     */
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({
            level: "silent"
        }),
        browser: [
            "WhisperBot",
            "Chrome",
            "1.0.0"
        ]
    });

    sessions.set(phone, {
        sock,
        chatId
    });

    sock.ev.on(
        "creds.update",
        saveCreds
    );

    sock.ev.on(
        "connection.update",
        async update => {

            const {
                connection,
                lastDisconnect
            } = update;

            if (connection === "open") {

                console.log(
                    `✅ WhatsApp connected: ${phone}`
                );

                await sendTelegramMessage(
                    chatId,
                    `✅ WhatsApp account +${phone} has been successfully connected.`
                );

                return;
            }

            if (connection === "close") {

                const statusCode =
                    lastDisconnect
                        ?.error
                        ?.output
                        ?.statusCode;

                console.log(
                    `WhatsApp session closed: ${phone} (${statusCode})`
                );

                sessions.delete(phone);

                /*
                 * 401 = logged out / authentication failure
                 * 405 = connection rejected/closed
                 */
                if (
                    statusCode ===
                    DisconnectReason.loggedOut
                ) {

                    await sendTelegramMessage(
                        chatId,
                        `❌ WhatsApp rejected the pairing session for +${phone}. Please request a new code.`
                    );

                } else {

                    await sendTelegramMessage(
                        chatId,
                        `⚠️ WhatsApp pairing session for +${phone} was closed. Please request a new code.`
                    );
                }
            }
        }
    );

    /*
     * Give WhatsApp time to establish
     * the WebSocket connection.
     */
    await new Promise(
        resolve => setTimeout(resolve, 3000)
    );

    /*
     * If credentials already exist,
     * don't generate another pairing code.
     */
    if (sock.authState.creds.registered) {

        await sendTelegramMessage(
            chatId,
            `ℹ️ +${phone} is already paired with this session.`
        );

        return;
    }

    try {

        /*
         * Generate ONE pairing code.
         */
        const code =
            await sock.requestPairingCode(phone);

        console.log(
            `PAIRING CODE for ${phone}: ${code}`
        );

        /*
         * Send the code immediately to Telegram.
         */
        await sendTelegramMessage(
            chatId,
            `🔐 WhatsApp Pairing Code\n\n` +
            `Number: +${phone}\n\n` +
            `Code: ${code}\n\n` +
            `Open WhatsApp → Linked Devices → Link a device → Link with phone number, then enter this code.\n\n` +
            `⚠️ The code is private. Do not share it.`
        );

    } catch (err) {

        console.error(
            `Pairing error for ${phone}:`,
            err
        );

        sessions.delete(phone);

        await sendTelegramMessage(
            chatId,
            "❌ Unable to generate a WhatsApp pairing code."
        );
    }
}

/* =========================
   TELEGRAM POLLING
========================= */

let telegramOffset = 0;

async function pollTelegram() {

    while (true) {

        try {

            const updates =
                await telegram(
                    "getUpdates",
                    {
                        offset: telegramOffset,
                        timeout: 30
                    }
                );

            for (const update of updates) {

                telegramOffset =
                    update.update_id + 1;

                const message =
                    update.message;

                if (!message?.text) {
                    continue;
                }

                const chatId =
                    message.chat.id;

                const text =
                    message.text.trim();

                /*
                 * /start
                 */
                if (text === "/start") {

                    await sendTelegramMessage(
                        chatId,
                        "🤖 WhisperBot Pairing\n\n" +
                        "Use:\n" +
                        "/pair 237XXXXXXXXX\n\n" +
                        "A WhatsApp pairing code will be generated for you."
                    );

                    continue;
                }

                /*
                 * /pair
                 */
                if (text.startsWith("/pair")) {

                    const parts =
                        text.split(/\s+/);

                    const phone =
                        normalizePhone(parts[1]);

                    if (!phone) {

                        await sendTelegramMessage(
                            chatId,
                            "📌 Usage:\n/pair 237XXXXXXXXX"
                        );

                        continue;
                    }

                    await sendTelegramMessage(
                        chatId,
                        `⏳ Connecting WhatsApp +${phone}...`
                    );

                    await createPairingSession(
                        phone,
                        chatId
                    );

                    continue;
                }
            }

        } catch (err) {

            console.error(
                "Telegram polling error:",
                err.message
            );

            await new Promise(
                resolve =>
                    setTimeout(resolve, 5000)
            );
        }
    }
}

/* =========================
   START
========================= */

async function main() {

    console.log(
        "================================"
    );

    console.log(
        "🤖 WhisperBot Pairing Service"
    );

    console.log(
        "================================"
    );

    console.log(
        "Telegram bot: connected"
    );

    await pollTelegram();
}

main().catch(err => {

    console.error(
        "FATAL ERROR:",
        err
    );

    process.exit(1);
});
