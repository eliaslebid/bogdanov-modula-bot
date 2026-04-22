import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BOT_ENV = process.env.BOT_ENV || 'production';

// Load env file for the current BOT_ENV. Falls back to legacy `.env` if
// the environment-specific file is missing.
function loadEnvFile(path) {
  try {
    const content = readFileSync(path, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
    return true;
  } catch {
    return false;
  }
}

const envFile = resolve(__dirname, '..', `.env.${BOT_ENV}`);
const legacyFile = resolve(__dirname, '..', '.env');
const loaded = loadEnvFile(envFile) || loadEnvFile(legacyFile);

if (!loaded) {
  console.error(`[config] no env file found (tried ${envFile} and ${legacyFile})`);
}

export const config = {
  env: BOT_ENV,
  isDev: BOT_ENV !== 'production',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  githubToken: process.env.GITHUB_TOKEN,
  githubRepo: process.env.GITHUB_REPO,
  anthropicKey: process.env.ANTHROPIC_API_KEY,
  meetBotUrl: process.env.MEET_BOT_URL,
};

console.log(`[config] BOT_ENV=${BOT_ENV} chat=${config.chatId}`);
