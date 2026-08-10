require("dotenv").config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const fs = require("fs");
const path = require("path");

const TELEGRAM_BOT_TOKEN =
    process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_BOT_TOKEN) {
    console.error("❌ TELEGRAM_BOT_TOKEN is missing.");
    process.exit(1);
}

/* =========================
   DIRECTORIES
========================= */

const SESSIONS_DIR =
    path.join(__dirname, "sessions");

if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, {
        recursive: true
    });
}

/* =========================
   ACTIVE SESSIONS
=========================

phone -> {
    sock,
    chatId,
    reconnecting,
    pairingRequested,
    pairingCodeSent,
    reconnectAttempts
}
*/

const sessions = new Map();

/* =========================
   TELEGRAM API
========================= */

async function telegram(
    method,
    data = {}
) {

    const response =
        await fetch(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
            {
                method: "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body:
                    JSON.stringify(data)
            }
        );

    const result =
        await response.json();

    if (!result.ok) {

        throw new Error(
            result.description ||
            "Telegram API request failed"
        );
    }

    return result.result;
}

/* =========================
   SEND TELEGRAM MESSAGE
========================= */

async function sendTelegramMessage(
    chatId,
    text
) {

    return telegram(
        "sendMessage",
        {
            chat_id: chatId,
            text
        }
    );
}

/* =========================
   PHONE NORMALIZATION
========================= */

function normalizePhone(input) {

    if (!input) {
        return null;
    }

    const phone =
        String(input)
            .replace(/[^\d]/g, "");

    if (
        phone.length < 7 ||
        phone.length > 15
    ) {
        return null;
    }

    return phone;
}

/* =========================
   WHATSAPP SOCKET
========================= */

async function createWhatsAppSocket(
    phone,
    session
) {

    const sessionPath =
        path.join(
            SESSIONS_DIR,
            phone
        );

    /*
     * Load the SAME authentication
     * directory every time.
     *
     * This is important because when
     * WhatsApp asks Baileys to restart
     * after 515, the new socket must
     * use the credentials from the
     * previous socket.
     */

    const {
        state,
        saveCreds
    } =
        await useMultiFileAuthState(
            sessionPath
        );

    console.log(
        `Creating WhatsApp socket for ${phone}`
    );

    /*
     * Same basic configuration as
     * the working WhisperBot.
     */

    const sock =
        makeWASocket({
            auth: state,

            printQRInTerminal: false,

            logger:
                pino({
                    level: "silent"
                })
        });

    session.sock = sock;

    /*
     * Save credentials.
     */

    sock.ev.on(
        "creds.update",
        saveCreds
    );

    /*
     * Connection events.
     */

    sock.ev.on(
        "connection.update",
        async update => {

            const {
                connection,
                lastDisconnect
            } = update;

            /*
             * =====================
             * CONNECTED
             * =====================
             */

            if (
                connection === "open"
            ) {

                session.reconnectAttempts =
                    0;

                session.reconnecting =
                    false;

                console.log(
                    `✅ WhatsApp connected: ${phone}`
                );

                /*
                 * This is the important
                 * success state.
                 */

                try {

                    await sendTelegramMessage(
                        session.chatId,

                        `✅ WhatsApp account +${phone} has been successfully linked to WhisperBot.`
                    );

                } catch (err) {

                    console.error(
                        "Telegram success message error:",
                        err.message
                    );
                }

                return;
            }

            /*
             * =====================
             * CONNECTION CLOSED
             * =====================
             */

            if (
                connection !== "close"
            ) {
                return;
            }

            const error =
                lastDisconnect?.error;

            const statusCode =
                error
                    ?.output
                    ?.statusCode;

            console.log(
                `WhatsApp session closed: ${phone} (${statusCode})`
            );

            console.log(
                "WhatsApp close details:",
                JSON.stringify(
                    {
                        statusCode,

                        data:
                            error?.data,

                        message:
                            error?.message
                    },
                    null,
                    2
                )
            );

            /*
             * =====================
             * 515
             * =====================
             *
             * WhatsApp says:
             *
             * "Stream Errored
             *  (restart required)"
             *
             * This is NOT treated as
             * an immediate pairing
             * failure.
             */

            if (
                statusCode ===
                DisconnectReason.restartRequired
            ) {

                console.log(
                    `🔄 WhatsApp requested socket restart for ${phone}`
                );

                await reconnectWhatsApp(
                    phone,
                    session
                );

                return;
            }

            /*
             * =====================
             * LOGGED OUT
             * =====================
             */

            if (
                statusCode ===
                DisconnectReason.loggedOut
            ) {

                console.log(
                    `❌ WhatsApp logged out ${phone}`
                );

                sessions.delete(
                    phone
                );

                try {

                    await sendTelegramMessage(
                        session.chatId,

                        `❌ WhatsApp rejected/logged out the session for +${phone}. Please request a new pairing code.`
                    );

                } catch {}

                return;
            }

            /*
             * =====================
             * OTHER CONNECTION ERRORS
             * =====================
             */

            console.log(
                `⚠️ WhatsApp connection closed for ${phone}: ${statusCode}`
            );

            /*
             * Give temporary connection
             * failures a chance to recover.
             */

            await reconnectWhatsApp(
                phone,
                session
            );
        }
    );

    return sock;
}

/* =========================
   RECONNECT WHATSAPP
========================= */

async function reconnectWhatsApp(
    phone,
    session
) {

    /*
     * Prevent two reconnects from
     * happening at the same time.
     */

    if (
        session.reconnecting
    ) {

        console.log(
            `Reconnect already running for ${phone}`
        );

        return;
    }

    session.reconnecting =
        true;

    session.reconnectAttempts =
        (session.reconnectAttempts || 0) + 1;

    const attempt =
        session.reconnectAttempts;

    /*
     * Don't reconnect forever.
     */

    if (attempt > 5) {

        console.log(
            `❌ Maximum reconnect attempts reached for ${phone}`
        );

        session.reconnecting =
            false;

        sessions.delete(
            phone
        );

        try {

            await sendTelegramMessage(
                session.chatId,

                `❌ WhatsApp could not complete the connection for +${phone}. Please request a new pairing code.`
            );

        } catch {}

        return;
    }

    /*
     * Wait before restarting.
     */

    const delay =
        attempt === 1
            ? 1500
            : 3000;

    console.log(
        `🔄 Restarting WhatsApp socket for ${phone} in ${delay}ms...`
    );

    await new Promise(
        resolve =>
            setTimeout(
                resolve,
                delay
            )
    );

    /*
     * Make sure the session wasn't
     * removed while waiting.
     */

    if (
        !sessions.has(phone)
    ) {

        session.reconnecting =
            false;

        return;
    }

    try {

        /*
         * Create a NEW socket using
         * the SAME auth directory.
         */

        await createWhatsAppSocket(
            phone,
            session
        );

        console.log(
            `✅ New WhatsApp socket created for ${phone}`
        );

        /*
         * IMPORTANT:
         *
         * We do NOT request another
         * pairing code here.
         *
         * The purpose of this restart
         * is to let Baileys continue
         * authentication using the
         * credentials saved by the
         * previous socket.
         */

    } catch (err) {

        console.error(
            `Reconnect error for ${phone}:`,
            err
        );

        session.reconnecting =
            false;

        /*
         * Try again if the session
         * still exists.
         */

        if (
            sessions.has(phone)
        ) {

            await reconnectWhatsApp(
                phone,
                session
            );
        }

        return;
    }

    session.reconnecting =
        false;
}

/* =========================
   CREATE PAIRING SESSION
========================= */

async function createPairingSession(
    phone,
    chatId
) {

    if (
        sessions.has(phone)
    ) {

        await sendTelegramMessage(
            chatId,

            `⚠️ A WhatsApp pairing session for +${phone} is already active.`
        );

        return;
    }

    const sessionPath =
        path.join(
            SESSIONS_DIR,
            phone
        );

    /*
     * Make sure the directory exists.
     */

    fs.mkdirSync(
        sessionPath,
        {
            recursive: true
        }
    );

    /*
     * Session object.
     */

    const session = {

        sock: null,

        chatId,

        reconnecting: false,

        pairingRequested: false,

        pairingCodeSent: false,

        reconnectAttempts: 0
    };

    sessions.set(
        phone,
        session
    );

    try {

        /*
         * Create first socket.
         */

        const sock =
            await createWhatsAppSocket(
                phone,
                session
            );

        session.sock =
            sock;

        /*
         * Give WhatsApp a moment to
         * establish the socket.
         */

        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    4000
                )
        );

        /*
         * Check whether this number
         * already has saved credentials.
         */

        if (
            sock.authState &&
            sock.authState.creds &&
            sock.authState.creds.registered
        ) {

            console.log(
                `ℹ️ ${phone} already has registered credentials.`
            );

            await sendTelegramMessage(
                chatId,

                `ℹ️ +${phone} is already linked in this session.`
            );

            return;
        }

        /*
         * =====================
         * REQUEST PAIRING CODE
         * =====================
         */

        session.pairingRequested =
            true;

        const code =
            await sock.requestPairingCode(
                phone
            );

        session.pairingCodeSent =
            true;

        console.log(
            "=============================="
        );

        console.log(
            `PAIR CODE 👉 ${code}`
        );

        console.log(
            "=============================="
        );

        /*
         * Send the code to Telegram.
         */

        await sendTelegramMessage(
            chatId,

            `🔐 WhatsApp Pairing Code

Number: +${phone}

Code: ${code}

Open WhatsApp → Linked Devices → Link a device → Link with phone number, then enter this code.

⚠️ The code is private. Do not share it.`
        );

    } catch (err) {

        console.error(
            `Pairing error for ${phone}:`,
            err
        );

        sessions.delete(
            phone
        );

        try {

            await sendTelegramMessage(
                chatId,

                `❌ Unable to generate a WhatsApp pairing code for +${phone}.`
            );

        } catch {}
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
                        offset:
                            telegramOffset,

                        timeout: 30
                    }
                );

            for (
                const update
                of updates
            ) {

                telegramOffset =
                    update.update_id + 1;

                const message =
                    update.message;

                if (
                    !message?.text
                ) {
                    continue;
                }

                const chatId =
                    message.chat.id;

                const text =
                    message.text.trim();

                /*
                 * =====================
                 * START
                 * =====================
                 */

                if (
                    text === "/start"
                ) {

                    await sendTelegramMessage(
                        chatId,

                        `🤖 WhisperBot Pairing

Use:

/pair 237XXXXXXXXX

Example:

/pair 237672334564

A WhatsApp pairing code will be generated for you.`
                    );

                    continue;
                }

                /*
                 * =====================
                 * PAIR
                 * =====================
                 */

                if (
                    text === "/pair" ||
                    text.startsWith("/pair ")
                ) {

                    const parts =
                        text.split(
                            /\s+/
                        );

                    const phone =
                        normalizePhone(
                            parts[1]
                        );

                    if (!phone) {

                        await sendTelegramMessage(
                            chatId,

                            `📌 Usage:

/pair 237XXXXXXXXX

Example:

/pair 237672334564`
                        );

                        continue;
                    }

                    await sendTelegramMessage(
                        chatId,

                        `⏳ Generating WhatsApp pairing code for +${phone}...`
                    );

                    /*
                     * Start the pairing process.
                     *
                     * We don't await the entire
                     * lifetime of the WhatsApp
                     * connection.
                     */

                    createPairingSession(
                        phone,
                        chatId
                    ).catch(
                        async err => {

                            console.error(
                                `Pairing session error for ${phone}:`,
                                err
                            );

                            sessions.delete(
                                phone
                            );

                            try {

                                await sendTelegramMessage(
                                    chatId,

                                    `❌ Unable to start the WhatsApp pairing session for +${phone}.`
                                );

                            } catch {}
                        }
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
                    setTimeout(
                        resolve,
                        5000
                    )
            );
        }
    }
}

/* =========================
   MAIN
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

/* =========================
   START
========================= */

main().catch(
    err => {

        console.error(
            "FATAL ERROR:",
            err
        );

        process.exit(1);
    }
);
