const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT_DIR = __dirname;

const TEMPLATE_DIR =
    path.join(ROOT_DIR, "whisperbot-template");

const REPO_URL =
    "https://github.com/sneakyuser5-netizen/The_whisperer_bot.git";

function syncWhisperBotSource() {

    console.log("================================");
    console.log("🔄 SYNCING WHISPERBOT SOURCE");
    console.log("================================");

    try {

        if (!fs.existsSync(TEMPLATE_DIR)) {

            console.log(
                "📥 Downloading latest The_whisperer_bot..."
            );

            execFileSync(
                "git",
                [
                    "clone",
                    "--depth",
                    "1",
                    REPO_URL,
                    TEMPLATE_DIR
                ],
                {
                    stdio: "inherit"
                }
            );

        } else {

            console.log(
                "🔄 Updating existing WhisperBot source..."
            );

            execFileSync(
                "git",
                [
                    "-C",
                    TEMPLATE_DIR,
                    "fetch",
                    "origin",
                    "main",
                    "--depth",
                    "1"
                ],
                {
                    stdio: "inherit"
                }
            );

            execFileSync(
                "git",
                [
                    "-C",
                    TEMPLATE_DIR,
                    "reset",
                    "--hard",
                    "origin/main"
                ],
                {
                    stdio: "inherit"
                }
            );
        }

        /*
         * Never allow authentication/database
         * data from the source repository to
         * become part of a new instance.
         */

        fs.rmSync(
            path.join(TEMPLATE_DIR, "session"),
            {
                recursive: true,
                force: true
            }
        );

        fs.rmSync(
            path.join(TEMPLATE_DIR, "database"),
            {
                recursive: true,
                force: true
            }
        );

        fs.mkdirSync(
            path.join(TEMPLATE_DIR, "database"),
            {
                recursive: true
            }
        );

        console.log(
            "✅ WhisperBot source synchronized."
        );

        return TEMPLATE_DIR;

    } catch (error) {

        console.error(
            "❌ WhisperBot source synchronization failed:"
        );

        console.error(error.message);

        throw error;
    }
}

module.exports = {
    syncWhisperBotSource
};
