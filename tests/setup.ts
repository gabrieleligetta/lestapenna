import * as path from 'path';
import * as os from 'os';

// ⚠️ DB ISOLATION: without this the tests used the default DB data/dnd_bot.db
// and wipeDatabase() in the tests really DID empty it on every `npm test`. Every jest
// worker works on a throwaway temporary file.
process.env.DB_PATH = path.join(os.tmpdir(), `lestapenna_test_${process.pid}_${Date.now()}.db`);

// Audio diagnostics isolation: the tests that simulate closing audio segments
// (recorder/e2e) must not write JSONL inside src/audio_diagnostics.
process.env.AUDIO_DIAGNOSTICS_DIR = path.join(os.tmpdir(), `lestapenna_test_audiodiag_${process.pid}_${Date.now()}`);

// Entity media tests must never touch a production/object-storage bucket or
// leave generated WebP files in the repository.
process.env.MEDIA_STORAGE_DRIVER = 'local';
process.env.MEDIA_LOCAL_DIR = path.join(os.tmpdir(), `lestapenna_test_media_${process.pid}_${Date.now()}`);

// Reports tests use the local driver too, in a separate throwaway directory so
// report JSON / screenshots never land in the repo or the production bucket.
process.env.REPORTS_STORAGE_DRIVER = 'local';
process.env.REPORTS_LOCAL_DIR = path.join(os.tmpdir(), `lestapenna_test_reports_${process.pid}_${Date.now()}`);

// The reports controller fires a real email to TECHNICAL_REPORT_RECIPIENT on
// submission. Tests must never send (or even attempt) real SMTP: route the
// nodemailer calls to a dry-run directory instead. Preview/dev stays unset so
// the mail is genuinely delivered during manual smoke testing.
process.env.EMAIL_DRY_RUN = 'true';
process.env.EMAIL_DRY_RUN_DIR = path.join(os.tmpdir(), `lestapenna_test_email_${process.pid}_${Date.now()}`);

// Set these before any module loads dotenv so the .env values don't override them.
// DEV_GUILD_ID restricts the bot to one guild - tests need to work with any guild ID.
process.env.DEV_GUILD_ID = '';
// Channel restriction comes from getGuildConfig DB call in tests, not env var.
process.env.DISCORD_COMMAND_AND_RESPONSE_CHANNEL_ID = '';
// Unit/e2e tests use deterministic in-memory queue/admission/web-session
// adapters. They must not open sockets to a developer's local Redis instance
// or keep Jest alive after the assertions have completed.
process.env.DISABLE_REDIS = 'true';
// Deterministic AI config: without this override the tests would inherit the
// machine's ai.config.local.json (e.g. the agentic pipeline active in strict
// mode), making the outcome depend on the developer's environment.
process.env.AI_CONFIG_LOCAL = path.join(__dirname, 'fixtures', 'ai.config.test.json');

// Deterministic fake Discord OAuth app credentials so auth.test.ts doesn't
// depend on (or accidentally hit) real Discord endpoints/config.
process.env.DISCORD_CLIENT_ID = 'test-client-id';
process.env.DISCORD_CLIENT_SECRET = 'test-client-secret';
process.env.PUBLIC_BASE_URL = 'https://app.example.test';

// `config` demands DISCORD_BOT_TOKEN and otherwise throws at import time, so
// without this half the suite does not start on a machine without a `.env` — that is, on
// every CI runner and on every freshly cloned copy of the repository.
// Setting it here also wins over the `.env` of those who have one, because dotenv does not
// overwrite variables that are already present: that is deliberate, the tests must not be able
// to wield the bot's real token.
process.env.DISCORD_BOT_TOKEN = 'test-bot-token';
