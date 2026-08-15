const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const ROOT_DIR = __dirname;

const TEMPLATE_DIR =
    path.join(ROOT_DIR, "whisperbot-template");

const REPO_URL =
    "https://github.com/sneakyuser5-netizen/The_whisperer_bot.git";

function runGit(args, cwd) {
    return execFileSync(
        "git",
        args,
        {
            cwd,
            stdio: "inherit"
        }
    );
}

function syncWhisperBotSource() {

    console.log("================================");
    console.log("🔄 SYNCING WHISPERBOT SOURCE");
    console.log("================================");

    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "whisperbot-source-")
    );

    try {

        /*
         * Always obtain a completely fresh copy of
         * The_whisperer_bot.
         *
         * whisperbot-template is intentionally NOT
         * a Git repository.
         */

        console.log(
            "📥 Downloading latest The_whisperer_bot..."
        );

        runGit(
            [
                "clone",
                "--depth",
                "1",
                "--branch",
                "main",
                REPO_URL,
                tempDir
            ],
            ROOT_DIR
        );

        /*
         * Remove the old template completely.
         */

        fs.rmSync(
            TEMPLATE_DIR,
            {
                recursive: true,
                force: true
            }
        );

        /*
         * Copy the freshly downloaded source into
         * the template directory.
         */

        fs.cpSync(
            tempDir,
            TEMPLATE_DIR,
            {
                recursive: true
            }
        );

        /*
         * Never allow Git metadata from the source
         * repository to become part of the template.
         */

        fs.rmSync(
            path.join(TEMPLATE_DIR, ".git"),
            {
                recursive: true,
                force: true
            }
        );

        /*
         * Never allow authentication/database data
         * from the source repository to become part
         * of a new instance.
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
            "✅ WhisperBot source synchronized from The_whisperer_bot."
        );

        return TEMPLATE_DIR;

    } catch (error) {

        console.error(
            "❌ WhisperBot source synchronization failed:"
        );

        console.error(error.message);

        throw error;

    } finally {

        fs.rmSync(
            tempDir,
            {
                recursive: true,
                force: true
            }
        );
    }
}

module.exports = {
    syncWhisperBotSource
};
