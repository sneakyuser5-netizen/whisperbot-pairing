
require("dotenv").config();

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const pino = require("pino");
const fs = require("fs");
const path = require("path");

const {
    startWhisperBot
} = require("./bot-runtime");

const TELEGRAM_BOT_TOKEN =
    process.env.TELEGRAM_BOT_TOKEN;

if (!TELEGRAM_BOT_TOKEN) {
    console.error("❌ TELEGRAM_BOT_TOKEN is missing.");
    process.exit(1);
}

/* =========================
   DIRECTORIES
========================= */

const ROOT_DIR = __dirname;

const TEMPLATE_DIR =
    path.join(
        ROOT_DIR,
        "whisperbot-template"
    );

const INSTANCES_DIR =
    path.join(
        ROOT_DIR,
        "instances"
    );

if (!fs.existsSync(INSTANCES_DIR)) {
    fs.mkdirSync(
        INSTANCES_DIR,
        {
            recursive: true
        }
    );
}

/*
 * phone -> session object
 */

const sessions = new Map();

/*
 * phone -> child WhisperBot process
 */

const botProcesses = new Map();

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
   TELEGRAM MESSAGE
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
   PHONE
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
   INSTANCE PATHS
========================= */

function getInstanceDir(phone) {

    return path.join(
        INSTANCES_DIR,
        phone
    );
}

function getSessionDir(phone) {

    return path.join(
        getInstanceDir(phone),
        "session"
    );
}

/* =========================
   PREPARE INSTANCE
========================= */

function prepareInstance(phone) {

    const instanceDir =
        getInstanceDir(phone);

    /*
     * The template must exist.
     */

    if (!fs.existsSync(TEMPLATE_DIR)) {

        throw new Error(
            `WhisperBot template not found: ${TEMPLATE_DIR}`
        );
    }

    /*
     * Create the isolated instance
     * if it doesn't exist.
     */

    if (!fs.existsSync(instanceDir)) {

        console.log(
            `📦 Creating WhisperBot instance for +${phone}`
        );

        fs.cpSync(
            TEMPLATE_DIR,
            instanceDir,
            {
                recursive: true
            }
        );

        /*
         * The template must never bring
         * authentication or database data
         * into a new user's instance.
         */

        fs.rmSync(
            path.join(
                instanceDir,
                "session"
            ),
            {
                recursive: true,
                force: true
            }
        );

        fs.rmSync(
            path.join(
                instanceDir,
                "database"
            ),
            {
                recursive: true,
                force: true
            }
        );
    }

    /*
     * Make sure every instance has its
     * own database.
     */

    fs.mkdirSync(
        path.join(
            instanceDir,
            "database"
        ),
        {
            recursive: true
        }
    );

    /*
     * Make sure every instance has its
     * own WhatsApp session directory.
     */

    fs.mkdirSync(
        path.join(
            instanceDir,
            "session"
        ),
        {
            recursive: true
        }
    );

    return {
        instanceDir,
        sessionDir:
            getSessionDir(phone)
    };
}

/* =========================
   START BOT INSTANCE
========================= */

function launchWhisperBot(
    phone,
    chatId
) {

    /*
     * Don't launch the same bot twice.
     */

    const existing =
        botProcesses.get(phone);

    if (
        existing &&
        !existing.killed
    ) {

        console.log(
            `ℹ️ WhisperBot instance already running for +${phone}`
        );

        return existing;
    }

    console.log(
        `🚀 Launching WhisperBot for +${phone}`
    );

    const child =
        startWhisperBot(phone);

    botProcesses.set(
        phone,
        child
    );

    child.on(
        "exit",
        async (
            code,
            signal
        ) => {

            /*
             * Only remove this exact
             * child from the map.
             */

            if (
                botProcesses.get(phone) ===
                child
            ) {

                botProcesses.delete(
                    phone
                );
            }

            console.log(
                `WhisperBot +${phone} stopped. code=${code} signal=${signal}`
            );

            /*
             * Don't immediately spam Telegram
             * if the process stops normally.
             */

            if (
                code !== 0 &&
                sessions.has(phone)
            ) {

                try {

                    await sendTelegramMessage(
                        chatId,

                        `⚠️ WhisperBot instance for +${phone} stopped unexpectedly.`
                    );

                } catch {}
            }
        }
    );

    return child;
}

/* =========================
   WHATSAPP SOCKET
========================= */

async function createWhatsAppSocket(
    phone,
    session
) {

    /*
     * IMPORTANT:
     *
     * Authentication is stored directly
     * inside the final WhisperBot instance.
     *
     * There is no intermediate copy.
     */

    const {
        sessionDir
    } =
        prepareInstance(phone);

    console.log(
        `Using WhatsApp authentication directory: ${sessionDir}`
    );

    const {
        state,
        saveCreds
    } =
        await useMultiFileAuthState(
            sessionDir
        );

    /*
     * Create the socket using the SAME
     * basic configuration as the working
     * WhisperBot.
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

    session.sock =
        sock;

    session.state =
        state;

    /*
     * Save every credential update.
     */

    sock.ev.on(
        "creds.update",
        saveCreds
    );

    /*
     * =========================
     * CONNECTION UPDATE
     * =========================
     */

    sock.ev.on(
        "connection.update",
        async update => {

            const {
                connection,
                lastDisconnect
            } = update;

            /*
             * =========================
             * OPEN
             * =========================
             */

            if (
                connection === "open"
            ) {

                session.reconnectAttempts =
                    0;

                session.reconnecting =
                    false;

                session.connected =
                    true;

                console.log(
                    `✅ WhatsApp connected: +${phone}`
                );

                /*
                 * Give creds.update a moment to
                 * finish writing the authentication
                 * files before starting the actual
                 * WhisperBot process.
                 */

                await new Promise(
                    resolve =>
                        setTimeout(
                            resolve,
                            1500
                        )
                );

                /*
                 * If another process was already
                 * launched, don't launch another.
                 */

                if (
                    !botProcesses.has(phone)
                ) {

                    try {

                        launchWhisperBot(
                            phone,
                            session.chatId
                        );

                    } catch (err) {

                        console.error(
                            `WhisperBot launch error for +${phone}:`,
                            err
                        );

                        try {

                            await sendTelegramMessage(
                                session.chatId,

                                `❌ WhatsApp was linked successfully, but WhisperBot could not be started for +${phone}.`
                            );

                        } catch {}

                        return;
                    }

                }

                /*
                 * Tell the Telegram user that
                 * the actual bot is now starting.
                 */

                try {

                    await sendTelegramMessage(
                        session.chatId,

                        `✅ WhatsApp account +${phone} is linked successfully.\n\n🚀 WhisperBot is now starting on this WhatsApp account.`
                    );

                } catch {}

                /*
                 * The temporary pairing socket
                 * is no longer needed.
                 *
                 * The real WhisperBot process now
                 * owns the same authentication.
                 */

                setTimeout(
                    async () => {

                        try {

                            await sock.logout
                                ? null
                                : null;

                        } catch {}

                        try {

                            sock.ws?.close();

                        } catch {}

                    },
                    2000
                );

                return;
            }

            /*
             * =========================
             * CLOSE
             * =========================
             */

            if (
                connection !== "close"
            ) {
                return;
            }

            session.connected =
                false;

            const error =
                lastDisconnect?.error;

            const statusCode =
                error
                    ?.output
                    ?.statusCode;

            console.log(
                `WhatsApp session closed: +${phone} (${statusCode})`
            );

            if (error) {

                console.log(
                    "WhatsApp error details:",
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
            }

            /*
             * If the actual WhisperBot is already
             * running, the pairing socket closing
             * is expected. Do NOT restart pairing.
             */

            if (
                botProcesses.has(phone)
            ) {

                console.log(
                    `Pairing socket closed after WhisperBot launch for +${phone}`
                );

                return;
            }

            /*
             * =========================
             * LOGGED OUT
             * =========================
             */

            if (
                statusCode ===
                DisconnectReason.loggedOut
            ) {

                console.log(
                    `❌ WhatsApp logged out/rejected +${phone}`
                );

                sessions.delete(
                    phone
                );

                try {

                    await sendTelegramMessage(
                        session.chatId,

                        `❌ WhatsApp rejected the pairing session for +${phone}. Please request a new pairing code.`
                    );

                } catch {}

                return;
            }

            /*
             * =========================
             * 515 RESTART REQUIRED
             * =========================
             */

            if (
                statusCode ===
                DisconnectReason.restartRequired
            ) {

                console.log(
                    `🔄 WhatsApp requested socket restart for +${phone}`
                );

                await reconnectWhatsApp(
                    phone,
                    session
                );

                return;
            }

            /*
             * =========================
             * OTHER TEMPORARY FAILURE
             * =========================
             */

            console.log(
                `⚠️ Temporary WhatsApp connection failure for +${phone}: ${statusCode}`
            );

            await reconnectWhatsApp(
                phone,
                session
            );
        }
    );

    return sock;
}

/* =========================
   RECONNECT
========================= */

async function reconnectWhatsApp(
    phone,
    session
) {

    /*
     * Don't run two reconnect operations
     * simultaneously.
     */

    if (
        session.reconnecting
    ) {

        console.log(
            `Reconnect already running for +${phone}`
        );

        return;
    }

    /*
     * Never reconnect after the real
     * WhisperBot has already started.
     */

    if (
        botProcesses.has(phone)
    ) {

        return;
    }

    session.reconnecting =
        true;

    session.reconnectAttempts =
        (session.reconnectAttempts || 0) + 1;

    const attempt =
        session.reconnectAttempts;

    /*
     * Five attempts is enough for temporary
     * 515/network failures.
     */

    if (
        attempt > 5
    ) {

        console.log(
            `❌ Maximum reconnect attempts reached for +${phone}`
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

    const delay =
        attempt === 1
            ? 1500
            : 3000;

    console.log(
        `🔄 Restarting WhatsApp socket for +${phone} in ${delay}ms (attempt ${attempt}/5)...`
    );

    await new Promise(
        resolve =>
            setTimeout(
                resolve,
                delay
            )
    );

    /*
     * The Telegram session may have been
     * removed while we were waiting.
     */

    if (
        !sessions.has(phone)
    ) {

        session.reconnecting =
            false;

        return;
    }

    try {

        await createWhatsAppSocket(
            phone,
            session
        );

        console.log(
            `✅ New WhatsApp socket created for +${phone}`
        );

        session.reconnecting =
            false;

    } catch (err) {

        console.error(
            `Reconnect error for +${phone}:`,
            err
        );

        session.reconnecting =
            false;

        /*
         * Retry through the same controlled
         * mechanism.
         */

        if (
            sessions.has(phone) &&
            !botProcesses.has(phone)
        ) {

            await reconnectWhatsApp(
                phone,
                session
            );
        }
    }
}

/* =========================
   CREATE PAIRING SESSION
========================= */

async function createPairingSession(
    phone,
    chatId
) {

    /*
     * Don't allow two pairing sessions
     * for the same WhatsApp number.
     */

    if (
        sessions.has(phone)
    ) {

        await sendTelegramMessage(
            chatId,

            `⚠️ A WhatsApp pairing session for +${phone} is already active.`
        );

        return;
    }

    /*
     * Prepare the final isolated instance
     * BEFORE generating the pairing code.
     */

    try {

        prepareInstance(phone);

    } catch (err) {

        console.error(
            `Instance preparation failed for +${phone}:`,
            err
        );

        await sendTelegramMessage(
            chatId,

            `❌ Unable to prepare the WhisperBot instance for +${phone}.`
        );

        return;
    }

    /*
     * Session state.
     */

    const session = {

        sock: null,

        state: null,

        chatId,

        connected: false,

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
         * Create the first socket.
         */

        const sock =
            await createWhatsAppSocket(
                phone,
                session
            );

        session.sock =
            sock;

        /*
         * Give WhatsApp time to establish
         * the initial WebSocket.
         */

        await new Promise(
            resolve =>
                setTimeout(
                    resolve,
                    4000
                )
        );

        /*
         * If the account is already registered,
         * don't request a pairing code.
         */

        if (
            session.state?.creds?.registered
        ) {

            console.log(
                `ℹ️ +${phone} already has registered WhatsApp credentials.`
            );

            /*
             * Start the bot directly because
             * this instance already has valid
             * authentication.
             */

            if (
                !botProcesses.has(phone)
            ) {

                launchWhisperBot(
                    phone,
                    chatId
                );
            }

            await sendTelegramMessage(
                chatId,

                `ℹ️ +${phone} is already linked.\n\n🚀 WhisperBot is starting using the existing WhatsApp session.`
            );

            return;
        }

        /*
         * =========================
         * REQUEST PAIRING CODE
         * =========================
         */

        if (
            !session.pairingRequested
        ) {

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

            await sendTelegramMessage(
                chatId,

                `🔐 WhatsApp Pairing Code

Number: +${phone}

Code: ${code}

Open WhatsApp → Linked Devices → Link a device → Link with phone number, then enter this code.

⚠️ The code is private. Do not share it.`
            );
        }

    } catch (err) {

        console.error(
            `Pairing error for +${phone}:`,
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
                 * =========================
                 * START
                 * =========================
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

Your WhatsApp account will be linked and a personal WhisperBot instance will start automatically.`
                    );

                    continue;
                }

                /*
                 * =========================
                 * PAIR
                 * =========================
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

                    /*
                     * Don't allow an existing
                     * WhisperBot to be paired
                     * again accidentally.
                     */

                    if (
                        botProcesses.has(phone)
                    ) {

                        await sendTelegramMessage(
                            chatId,

                            `ℹ️ WhisperBot is already running for +${phone}.`
                        );

                        continue;
                    }

                    await sendTelegramMessage(
                        chatId,

                        `⏳ Preparing WhisperBot for +${phone}...\n\nA WhatsApp pairing code will be generated shortly.`
                    );

                    /*
                     * Start the pairing process
                     * without blocking Telegram.
                     */

                    createPairingSession(
                        phone,
                        chatId
                    ).catch(
                        async err => {

                            console.error(
                                `Pairing session error for +${phone}:`,
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
        `Template: ${TEMPLATE_DIR}`
    );

    console.log(
        `Instances: ${INSTANCES_DIR}`
    );

    console.log(
        "Telegram bot: connected"
    );

    await pollTelegram();
}

/* =========================
   SHUTDOWN
========================= */

async function shutdown(
    signal
) {

    console.log(
        `\nReceived ${signal}. Shutting down...`
    );

    /*
     * Stop pairing sockets.
     */

    for (
        const [
            phone,
            session
        ]
        of sessions
    ) {

        try {

            session.sock?.ws?.close();

        } catch {}

        console.log(
            `Closed pairing socket for +${phone}`
        );
    }

    /*
     * Don't kill the actual WhisperBot
     * processes here unless explicitly
     * requested. They are independent
     * runtime processes.
     */

    process.exit(0);
}

process.on(
    "SIGINT",
    () =>
        shutdown("SIGINT")
);

process.on(
    "SIGTERM",
    () =>
        shutdown("SIGTERM")
);

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
