import { config } from './config.js';

const headers = {
  Authorization: `Bearer ${config.githubToken}`,
  Accept: 'application/vnd.github.v3+json',
};

const API = `https://api.github.com/repos/${config.githubRepo}`;

// GitHub login -> { name, telegram }
export const TEAM = {
  Yneth:      { name: 'Antony',  telegram: null },
  eliaslebed: { name: 'Elias',   telegram: '@winfromloss' },
};

export function resolveAuthor(githubLogin) {
  return TEAM[githubLogin] || { name: githubLogin, telegram: null };
}

export async function getLastCommitPerAuthor() {
  const url = `${API}/commits?per_page=100`;
  const res = await fetch(url, { headers });
  if (!res.ok) return {};
  const commits = await res.json();
  const last = {};
  for (const c of commits) {
    const login = c.author?.login || c.commit.author.name;
    if (!last[login]) {
      last[login] = new Date(c.commit.author.date);
    }
  }
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
