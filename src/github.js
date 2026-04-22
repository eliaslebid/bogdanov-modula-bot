import { config } from './config.js';

const headers = {
  Authorization: `Bearer ${config.githubToken}`,
  Accept: 'application/vnd.github.v3+json',
};

const API = `https://api.github.com/repos/${config.githubRepo}`;

// GitHub login -> { name, telegram, telegramId, role }
// telegramId is auto-captured when the user messages the bot
export const TEAM = {
  Yneth:      { name: 'Antony',  telegram: null,           telegramId: null, role: 'dev' },
  eliaslebed: { name: 'Elias',   telegram: '@winfromloss', telegramId: null, role: 'dev' },
  eliaslebid: { name: 'Elias',   telegram: '@winfromloss', telegramId: null, role: 'dev' },
  gerbertpr0: { name: 'Gerbert', telegram: '@gerbertpr0',  telegramId: null, role: 'manager' },
};

export function resolveAuthor(githubLogin) {
  return TEAM[githubLogin] || { name: githubLogin, telegram: null, role: 'unknown' };
}

// Format name for Telegram: @username > tg://user link > bold fallback
export function formatName(githubLogin) {
  const member = TEAM[githubLogin];
  if (!member) return `<b>${githubLogin}</b>`;
  if (member.telegram) return member.telegram;
  if (member.telegramId) return `<a href="tg://user?id=${member.telegramId}">${member.name}</a>`;
  return `<b>${member.name}</b>`;
}

// Get display tag for a team member by name
export function tagByName(name) {
  const entry = Object.values(TEAM).find(t => t.name === name);
  if (!entry) return `<b>${name}</b>`;
  if (entry.telegram) return entry.telegram;
  if (entry.telegramId) return `<a href="tg://user?id=${entry.telegramId}">${entry.name}</a>`;
  return `<b>${entry.name}</b>`;
}

// Auto-capture Telegram user ID from message and persist to TEAM
export function captureTelegramId(msg) {
  const from = msg.from;
  if (!from || from.is_bot) return;
  const firstName = from.first_name || '';
  // Match by first name to a team member without a telegramId
  for (const info of Object.values(TEAM)) {
    if (info.name === firstName && !info.telegramId) {
      info.telegramId = from.id;
      console.log(`Captured Telegram ID for ${info.name}: ${from.id}`);
      // Persist to .tid file so it survives restarts
      import('fs').then(fs => {
        const path = new URL('../.telegram-ids.json', import.meta.url);
        const existing = {};
        try { Object.assign(existing, JSON.parse(fs.readFileSync(path, 'utf-8'))); } catch {}
        existing[info.name] = from.id;
        fs.writeFileSync(path, JSON.stringify(existing, null, 2));
      });
      break;
    }
  }
}

// Load persisted Telegram IDs on startup
try {
  const fs = await import('fs');
  const path = new URL('../.telegram-ids.json', import.meta.url);
  const ids = JSON.parse(fs.readFileSync(path, 'utf-8'));
  for (const [name, id] of Object.entries(ids)) {
    for (const info of Object.values(TEAM)) {
      if (info.name === name && !info.telegramId) {
        info.telegramId = id;
        console.log(`Loaded Telegram ID for ${name}: ${id}`);
      }
    }
  }
} catch {}

export async function getLastCommitPerAuthor() {
  // Query each team member individually to avoid missing commits buried in history
  const seen = new Set();
  const logins = [];
  for (const [login, info] of Object.entries(TEAM)) {
    if (info.role === 'manager') continue;
    if (seen.has(info.name)) continue;
    seen.add(info.name);
    logins.push(login);
  }

  const last = {};
  await Promise.all(logins.map(async (login) => {
    const url = `${API}/commits?author=${login}&per_page=1`;
    const res = await fetch(url, { headers });
    if (!res.ok) return;
    const commits = await res.json();
    if (commits.length > 0) {
      last[login] = new Date(commits[0].commit.author.date);
    }
  }));

  return last;
}

export async function getCommitsSince(since) {
  const url = `${API}/commits?since=${since.toISOString()}&per_page=100`;
  const res = await fetch(url, { headers });
  if (!res.ok) return [];
  return res.json();
}

export async function getPRsSince(since) {
  const url = `${API}/pulls?state=all&sort=updated&direction=desc&per_page=30`;
  const res = await fetch(url, { headers });
  if (!res.ok) return [];
  const prs = await res.json();
  return prs.filter(pr => new Date(pr.updated_at) >= since);
}

export async function getRepoTree() {
  const url = `${API}/git/trees/main?recursive=1`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    // Try master branch
    const res2 = await fetch(`${API}/git/trees/master?recursive=1`, { headers });
    if (!res2.ok) return [];
    const data = await res2.json();
    return data.tree || [];
  }
  const data = await res.json();
  return data.tree || [];
}

export async function getFileContent(path) {
  const url = `${API}/contents/${path}`;
  const res = await fetch(url, { headers });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.encoding === 'base64') {
    return Buffer.from(data.content, 'base64').toString('utf-8');
  }
  return data.content;
}

export async function getOpenIssues() {
  const url = `${API}/issues?state=open&per_page=100`;
  const res = await fetch(url, { headers });
  if (!res.ok) return [];
  const issues = await res.json();
  return issues.filter(i => !i.pull_request).map(i => ({
    number: i.number,
    title: i.title,
    body: i.body || '',
    labels: (i.labels || []).map(l => l.name),
    assignee: i.assignee?.login || null,
    created: i.created_at,
  }));
}

export async function getClosedIssues(since) {
  const url = `${API}/issues?state=closed&sort=updated&since=${since.toISOString()}&per_page=50`;
  const res = await fetch(url, { headers });
  if (!res.ok) return [];
  const issues = await res.json();
  return issues.filter(i => !i.pull_request).map(i => ({
    number: i.number,
    title: i.title,
    closed_at: i.closed_at,
  }));
}

export async function createIssue(title, body, labels, assignee) {
  const payload = { title, body };
  if (labels?.length) payload.labels = labels;
  if (assignee) payload.assignees = [assignee];
  const res = await fetch(`${API}/issues`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json();
    console.error(`Failed to create issue "${title}":`, err);
    return null;
  }
  const data = await res.json();
  console.log(`Created issue #${data.number}: ${title}`);
  return { number: data.number, title: data.title, url: data.html_url };
}

export async function closeIssue(issueNumber, comment) {
  // Add comment explaining why
  if (comment) {
    await fetch(`${API}/issues/${issueNumber}/comments`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: `🤖 Bogdanov (автоматически): ${comment}` }),
    });
  }
  const res = await fetch(`${API}/issues/${issueNumber}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }),
  });
  if (!res.ok) {
    const err = await res.json();
    console.error(`Failed to close issue #${issueNumber}:`, err);
    return null;
  }
  console.log(`Closed issue #${issueNumber}`);
  return { number: issueNumber, closed: true };
}

export async function getRecentDiffs(since) {
  const commits = await getCommitsSince(since);
  const diffs = [];
  for (const commit of commits.slice(0, 10)) {
    const url = `${API}/commits/${commit.sha}`;
    const res = await fetch(url, { headers });
    if (!res.ok) continue;
    const data = await res.json();
    diffs.push({
      message: data.commit.message,
      author: data.commit.author.name,
      files: (data.files || []).map(f => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        patch: (f.patch || '').slice(0, 500),
      })),
    });
  }
  return diffs;
}
