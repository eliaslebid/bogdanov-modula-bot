// Read meeting-notes markdown files, ask Bogdanov to summarize them, and
// remember which files were already summarized so we don't repeat ourselves.
//
// Storage format (.meeting-notes-summarized.json at project root):
//   { entries: [{ filePath, sha256, mtime, summarizedAt }] }
//
// Dedupe key is the content sha256, not the path — so a renamed-but-identical
// file is still considered "done", and an updated file (new content appended)
// gets re-summarized because its hash changed.

import { readFile, writeFile, stat, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname, join, basename } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { sendMessage } from './telegram.js';
import { meetingNotesSummary } from './ai.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = resolve(__dirname, '..', '.meeting-notes-summarized.json');

async function loadState() {
  if (!existsSync(STATE_FILE)) return { entries: [] };
  try {
    const raw = await readFile(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.entries)) return { entries: [] };
    return parsed;
  } catch (err) {
    console.warn(`[notes] state file unreadable, starting fresh: ${err.message}`);
    return { entries: [] };
  }
}

async function saveState(state) {
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// Strip Whisper-style filler and metadata, keeping only the actual utterances.
// The file format we get is:
//   ## USER: <text>
//   **Transcription duration:** ~Xms
//   ## SYSTEM: <text>
//   ...
// Output: "USER: <text>\nSYSTEM: <text>\n..." with filler lines dropped.
const FILLER_RX = /^(продолжение следует\.{0,3}|угу\.?|ага\.?|да\.?|нет\.?|так\.?|ну\.?|фак\.?|это все\.?|алло[,. ]?алло.*|руминг\.?)$/i;
// Whisper / YouTube auto-caption credits that leak into the transcript.
const CREDITS_RX = /(субтитры (сделал|подготовил|создавал|корректор)|корректор субтитров|редактор субтитров|субтитры от|amara\.org|titrovod|dimatorzok)/i;

export function cleanNotes(raw) {
  const lines = raw.split('\n');
  const out = [];
  for (const line of lines) {
    const m = line.match(/^##\s+(USER|SYSTEM):\s*(.+)$/);
    if (!m) continue;
    const speaker = m[1];
    const text = m[2].trim();
    if (!text) continue;
    if (FILLER_RX.test(text)) continue;
    if (CREDITS_RX.test(text)) continue;
    out.push(`${speaker}: ${text}`);
  }
  return out.join('\n');
}

// Pull "Mobile App Voucher Connect Development" out of the first H1 heading,
// or fall back to the filename without extension.
function extractTitle(raw, filePath) {
  const m = raw.match(/^#\s+(.+)$/m);
  if (m) return m[1].trim();
  return basename(filePath, '.md');
}

// Telegram caps a single message at 4096 chars. Deep summaries can blow past
// that, so we split on paragraph boundaries to keep <b> tags intact.
const TG_LIMIT = 3800;
function splitForTelegram(text) {
  if (text.length <= TG_LIMIT) return [text];
  const paragraphs = text.split(/\n\n+/);
  const chunks = [];
  let current = '';
  for (const p of paragraphs) {
    const candidate = current ? `${current}\n\n${p}` : p;
    if (candidate.length > TG_LIMIT && current) {
      chunks.push(current);
      current = p;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function summarizeOne(filePath, { force = false, dryRun = false, deep = false } = {}) {
  const absPath = resolve(filePath);
  const raw = await readFile(absPath, 'utf-8');
  const cleaned = cleanNotes(raw);

  if (!cleaned.trim()) {
    console.log(`[notes] ${absPath}: no usable content after cleanup, skipping`);
    return { status: 'empty', filePath: absPath };
  }

  const hash = sha256(cleaned);
  const state = await loadState();
  // In deep mode we re-summarize even if a prior shallow run exists, since the
  // user is asking for a different (richer) output. The state entry is keyed
  // by hash + mode so deep and shallow runs don't shadow each other.
  const mode = deep ? 'deep' : 'shallow';
  const prior = state.entries.find(e => e.sha256 === hash && (e.mode || 'shallow') === mode);

  if (prior && !force) {
    console.log(`[notes] ${absPath}: already summarized (${mode}) at ${prior.summarizedAt}, skipping`);
    return { status: 'skipped', filePath: absPath, prior };
  }

  const title = extractTitle(raw, absPath);
  const fileStat = await stat(absPath);
  console.log(`[notes] ${absPath}: ${cleaned.length} chars cleaned, summarizing as "${title}" (mode=${mode})…`);

  const summary = await meetingNotesSummary({ title, notes: cleaned, language: 'Russian', deep });
  const header = `📝 <b>Заметки со встречи: ${escapeHtml(title)}</b>${deep ? ' <i>(deep)</i>' : ''}\n\n`;
  const fullMessage = header + summary;
  const chunks = splitForTelegram(fullMessage);

  if (dryRun) {
    console.log(`[notes] DRY RUN — would post ${chunks.length} message(s):`);
    chunks.forEach((c, i) => console.log(`--- chunk ${i + 1}/${chunks.length} (${c.length} chars) ---\n${c}`));
    return { status: 'dry-run', filePath: absPath, summary, chunks: chunks.length };
  }

  for (const chunk of chunks) {
    await sendMessage(chunk);
  }

  // Drop entries that this run supersedes: same (hash, mode) or same (path, mode).
  // Other-mode entries for the same file are preserved so deep + shallow can
  // coexist independently.
  const next = state.entries.filter((e) => {
    const eMode = e.mode || 'shallow';
    if (eMode !== mode) return true;
    if (e.sha256 === hash) return false;
    if (e.filePath === absPath) return false;
    return true;
  });
  next.push({
    filePath: absPath,
    sha256: hash,
    mtime: fileStat.mtime.toISOString(),
    summarizedAt: new Date().toISOString(),
    mode,
  });
  await saveState({ entries: next });

  console.log(`[notes] ${absPath}: summary posted (${chunks.length} chunk(s)), state recorded`);
  return { status: 'posted', filePath: absPath, chunks: chunks.length };
}

async function expandPaths(input) {
  const absInput = resolve(input);
  const fileStat = await stat(absInput);
  if (fileStat.isFile()) return [absInput];
  if (fileStat.isDirectory()) {
    const entries = await readdir(absInput);
    return entries
      .filter(name => name.toLowerCase().endsWith('.md'))
      .map(name => join(absInput, name))
      .sort();
  }
  throw new Error(`not a file or directory: ${absInput}`);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Public entry point used by the CLI.
export async function summarizeMeetingNotes(input, opts = {}) {
  const paths = await expandPaths(input);
  console.log(`[notes] processing ${paths.length} file(s)`);
  const results = [];
  for (const p of paths) {
    try {
      results.push(await summarizeOne(p, opts));
    } catch (err) {
      console.error(`[notes] ${p} failed: ${err.message}`);
      results.push({ status: 'error', filePath: p, error: err.message });
    }
  }
  return results;
}
