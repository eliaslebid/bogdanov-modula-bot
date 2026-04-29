// Convert a meeting transcript into GitHub Issues — fire-and-create.
// Used by:
//   - the `--meeting-notes <path> --with-tickets` CLI flag (after a summary post)
//   - the chat-trigger keyword in handleReply (operates on the most recent
//     entry from .meeting-notes-summarized.json)

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { sendMessage } from './telegram.js';
import { extractTicketsFromMeeting } from './ai.js';
import { cleanNotes } from './meetingNotes.js';
import { getOpenIssues, getRepoTree, getFileContent, createIssue, closeIssue, TEAM } from './github.js';
import { loadProjectContext } from './context.js';
import { formatHistory } from './history.js';

// How many recent chat messages to scan for additional action items / manual
// bullet lists posted alongside the meeting summary. Capped well above the
// MAX_MESSAGES buffer so we get everything we have.
const CHAT_LOOKBACK = 40;

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = resolve(__dirname, '..', '.meeting-notes-summarized.json');

// Pull a small but representative sample of the repo for grounding the AI's
// "is this already implemented" check. Same heuristic as analyzeIssues.
async function loadRepoSample() {
  const tree = await getRepoTree();
  const codeFiles = tree
    .filter(f => f.type === 'blob')
    .filter(f => /\.(ts|tsx|js|jsx|py|rs|swift|css|html|json|yaml|yml|toml)$/i.test(f.path))
    .filter(f => !f.path.includes('node_modules') && !f.path.includes('.next') && !f.path.includes('dist'))
    .filter(f => (f.size || 0) < 50000);

  const priority = codeFiles.filter(f =>
    /package\.json$|tsconfig|\.env\.example|claude\.md|readme/i.test(f.path) ||
    /^src\/(index|main|app)\./i.test(f.path)
  );
  const srcFiles = codeFiles.filter(f => /^src\//.test(f.path) && !priority.includes(f)).slice(0, 10);
  const filesToRead = [...priority, ...srcFiles].slice(0, 15);
  const sampleFiles = [];
  for (const f of filesToRead) {
    const content = await getFileContent(f.path);
    if (content) sampleFiles.push({ path: f.path, content });
  }
  return { tree, sampleFiles };
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Real GitHub logins that can actually be assigned on Yneth/flatmatch.
// Anyone else returns 422 from the GitHub API (assignees must be collaborators).
const ASSIGNABLE_LOGINS = new Set(['eliaslebid', 'Yneth']);

// Round-robin pool — every created issue gets one of these as the assignee,
// ignoring whatever the AI suggested. Keeps load 50/50 between Elias and Antony
// and side-steps GitHub's collaborator-validation rejections.
const RR_POOL = ['eliaslebid', 'Yneth'];

// Canonicalize: AI sometimes outputs "Elias", "eliaslebed" (legacy typo), or
// "gerbertpr0" (manager — not assignable on this repo). Anything not in
// ASSIGNABLE_LOGINS becomes null and falls through to the round-robin step.
function normalizeAssignee(assignee) {
  if (!assignee) return null;
  const raw = String(assignee).trim();
  if (raw === 'eliaslebed' || raw.toLowerCase() === 'elias') return 'eliaslebid';
  if (ASSIGNABLE_LOGINS.has(raw)) return raw;
  // Allow first-name shorthand for Antony.
  if (raw.toLowerCase() === 'antony') return 'Yneth';
  return null;
}

// Run the full plan against GitHub. Caller has already produced `plan`.
async function executePlan(plan) {
  const created = [];
  const closed = [];
  const errors = [];

  // 50/50 round-robin assignment across the create batch. Overrides whatever
  // the AI suggested — assignment was a guess anyway, and forcing the split
  // here also makes assignee permission errors impossible (we only assign to
  // known collaborators).
  let rrIndex = 0;
  for (const item of (plan.create || [])) {
    try {
      const assignee = RR_POOL[rrIndex % RR_POOL.length];
      rrIndex++;
      const result = await createIssue(item.title, item.body, item.labels || [], assignee);
      if (result) created.push({ ...result, assignee, evidence: item.evidence });
      else errors.push(`Create "${item.title}" failed`);
    } catch (err) {
      errors.push(`Create "${item.title}": ${err.message}`);
    }
  }

  for (const item of (plan.close || [])) {
    try {
      const result = await closeIssue(item.number, item.reason);
      if (result) closed.push({ number: item.number, reason: item.reason });
      else errors.push(`Close #${item.number} failed`);
    } catch (err) {
      errors.push(`Close #${item.number}: ${err.message}`);
    }
  }

  return { created, closed, errors };
}

function formatReport({ title, plan, results }) {
  const lines = [`<b>📋 Тикеты с встречи: ${escapeHtml(title)}</b>\n`];

  if (plan.error === 'parse_failed') {
    lines.push('Не смог распарсить план задач, блять. Лог в консоли.');
    return lines.join('\n');
  }

  if (results.created.length) {
    lines.push('<b>Создал:</b>');
    for (const i of results.created) {
      const who = i.assignee ? ` → @${i.assignee}` : '';
      lines.push(`• #${i.number} — ${escapeHtml(i.title)}${escapeHtml(who)}`);
    }
    lines.push('');
  }
  if (results.closed.length) {
    lines.push('<b>Закрыл:</b>');
    for (const i of results.closed) {
      lines.push(`• #${i.number} — ${escapeHtml(i.reason || '').slice(0, 120)}`);
    }
    lines.push('');
  }
  if (results.errors.length) {
    lines.push('<b>Ошибки:</b>');
    for (const e of results.errors) lines.push(`• ${escapeHtml(e)}`);
    lines.push('');
  }
  if (!results.created.length && !results.closed.length && !results.errors.length) {
    lines.push('Ничего по этой встрече тикетов не нашёл — всё уже на борде или не было конкретных решений.');
  }
  return lines.join('\n').trim();
}

// Public: tickets from a specific notes file path.
export async function createTicketsFromMeetingFile(filePath, { post = true } = {}) {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) throw new Error(`notes file not found: ${absPath}`);

  const raw = await readFile(absPath, 'utf-8');
  const cleaned = cleanNotes(raw);
  if (!cleaned.trim()) {
    console.log(`[tickets] ${absPath}: empty after cleanup`);
    return null;
  }

  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : absPath.split('/').pop();

  console.log(`[tickets] ${absPath}: extracting from ${cleaned.length} chars`);
  const [openIssues, repoCtx, projectContext] = await Promise.all([
    getOpenIssues(),
    loadRepoSample(),
    loadProjectContext(),
  ]);

  const chatHistory = formatHistory(CHAT_LOOKBACK);
  const chatBytes = chatHistory && chatHistory !== '(no recent messages)' ? chatHistory.length : 0;
  console.log(`[tickets] chat history: ${chatBytes} chars from last ${CHAT_LOOKBACK} messages`);

  const plan = await extractTicketsFromMeeting({
    notes: cleaned,
    openIssues,
    repoTree: repoCtx.tree,
    sampleFiles: repoCtx.sampleFiles,
    projectContext,
    chatHistory,
  });

  console.log(`[tickets] plan: create=${plan.create?.length || 0}, close=${plan.close?.length || 0}`);

  const results = await executePlan(plan);
  console.log(`[tickets] executed: created=${results.created.length}, closed=${results.closed.length}, errors=${results.errors.length}`);

  if (post) {
    const report = formatReport({ title, plan, results });
    await sendMessage(report);
  }

  return { title, plan, results };
}

// Public: tickets from the most-recently summarized meeting (for chat trigger).
export async function createTicketsFromLatestMeeting({ post = true } = {}) {
  if (!existsSync(STATE_FILE)) {
    throw new Error('no summarized meetings yet — run --meeting-notes <path> first');
  }
  const state = JSON.parse(await readFile(STATE_FILE, 'utf-8'));
  if (!Array.isArray(state.entries) || state.entries.length === 0) {
    throw new Error('state file is empty — no recent meeting to use');
  }
  const latest = state.entries
    .slice()
    .sort((a, b) => new Date(b.summarizedAt) - new Date(a.summarizedAt))[0];

  console.log(`[tickets] latest summarized meeting: ${latest.filePath} (${latest.summarizedAt})`);
  return createTicketsFromMeetingFile(latest.filePath, { post });
}
