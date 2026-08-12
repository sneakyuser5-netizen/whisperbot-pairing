const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const {
    syncWhisperBotSource
} = require("./source-sync");
const TEMPLATE_DIR =
    path.join(__dirname, "whisperbot-template");

const INSTANCES_DIR =
    path.join(__dirname, "instances");

if (!fs.existsSync(INSTANCES_DIR)) {
    fs.mkdirSync(INSTANCES_DIR, {
        recursive: true
    });
}

/*
 * Start an isolated WhisperBot instance.
 *
 * Every WhatsApp account gets its own
 * complete WhisperBot directory.
 */
function startWhisperBot(phone) {

    const instanceDir =
        path.join(
            INSTANCES_DIR,
            phone
        );

       /*
     * Always obtain the latest WhisperBot
     * source before creating a new instance.
     */
    if (!fs.existsSync(instanceDir)) {

        console.log(
            `🔄 Syncing latest WhisperBot source before creating +${phone}`
        );

        syncWhisperBotSource();

        console.log(
            `Creating WhisperBot instance for ${phone}`
        );

        fs.cpSync(
            TEMPLATE_DIR,
            instanceDir,
            {
                recursive: true
            }
        );

        /*
         * Never copy the template's
         * authentication/database state.
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

        fs.mkdirSync(
            path.join(
                instanceDir,
                "database"
            ),
            {
                recursive: true
            }
        );
    }

    /*
     * Each instance gets its own
     * WhatsApp authentication directory.
     */
    const sessionDir =
        path.join(
            instanceDir,
            "session"
        );

    fs.mkdirSync(
        sessionDir,
        {
            recursive: true
        }
    );

    /*
     * Tell the WhisperBot which
     * WhatsApp authentication directory
     * belongs to this instance.
     */
    const env = {
        ...process.env,

        WHISPERBOT_PHONE: phone,

        WHISPERBOT_SESSION_DIR:
            sessionDir
    };

    console.log(
        `🚀 Starting WhisperBot instance for +${phone}`
    );

    const child =
        spawn(
            process.execPath,
            ["index.js"],
            {
                cwd: instanceDir,
                env,
                stdio: [
                    "ignore",
                    "inherit",
                    "inherit"
                ]
            }
        );

    child.on(
        "spawn",
        () => {

            console.log(
                `✅ WhisperBot process started for +${phone} (PID ${child.pid})`
            );

        }
    );

    child.on(
        "exit",
        (code, signal) => {

            console.log(
                `WhisperBot instance +${phone} stopped. code=${code} signal=${signal}`
            );

        }
    );

    child.on(
        "error",
        err => {

            console.error(
                `WhisperBot process error for +${phone}:`,
                err
            );

        }
    );

    return child;
}

module.exports = {
    startWhisperBot
};
