import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { TEAM, resolveAuthor } from './github.js';

const client = new Anthropic({ apiKey: config.anthropicKey });

// --- DAILY PROFESSIONAL REPORT (Mon-Fri) ---
export async function professionalReport(commits, prs, inactiveDevs) {
  const hasActivity = commits.length > 0 || prs.length > 0;

  const commitInfo = commits.map(c => {
    const login = c.author?.login || c.commit.author.name;
    const { name } = resolveAuthor(login);
    return `- ${name}: ${c.commit.message.split('\n')[0]}`;
  }).join('\n');

  const prInfo = prs.map(p => {
    const { name } = resolveAuthor(p.user.login);
    return `- PR #${p.number} "${p.title}" by ${name} (${p.state})`;
  }).join('\n');

  const inactiveSection = inactiveDevs.length > 0
    ? `\nNo activity for 3+ days: ${inactiveDevs.map(d => `${d.name} (${d.days} days)`).join(', ')}`
    : '';

  const prompt = hasActivity
    ? `You are a professional project status bot for team "Modula" building "flatmatch" (apartment/flat matching platform).

Last 24h:

COMMITS:
${commitInfo}

PRs:
${prInfo}
${inactiveSection}

Write a PROFESSIONAL daily status update IN RUSSIAN (4-6 sentences).
- Audience: non-technical stakeholders, investors, business people
- Explain what was done in terms of product progress and user impact
- No code jargon, no file names — translate technical work into business value
- Use <b>Name</b> HTML tags for team members
- Mention inactive devs factually if any
- Tone: clear, structured, confident
- Write ONLY in Russian
- Do NOT use markdown. Use HTML <b>bold</b> tags only.`

    : `You are a professional project status bot for team "Modula" building "flatmatch" (apartment/flat matching platform).

No commits or pull requests in the last 24 hours.
${inactiveSection}

Write a brief professional status update IN RUSSIAN (2-3 sentences).
- Note the lack of visible progress factually
- Tone: neutral but noting the gap
- Write ONLY in Russian
- Do NOT use markdown. Use HTML <b>bold</b> tags only.`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  return msg.content[0].text;
}

// --- BOGDANOV'S COMMENTARY (Mon-Fri, after professional report) ---
export async function bogdanovComment(commits, prs, inactiveDevs) {
  const hasActivity = commits.length > 0 || prs.length > 0;
  const names = commits.map(c => {
    const login = c.author?.login || c.commit.author.name;
    return resolveAuthor(login).name;
  });
  const uniqueNames = [...new Set(names)];

  const inactiveSection = inactiveDevs.length > 0
    ? `Inactive devs (3+ days no code): ${inactiveDevs.map(d => d.name).join(', ')}`
    : '';

  const prompt = hasActivity
    ? `You are "Bogdanov" — foul-mouthed Russian project manager bot. You use мат freely (блять, сука, пиздец, нахуй, ёбаный). Private friend group chat, everyone consents.

Today: ${commits.length} commits by ${uniqueNames.join(', ')}. ${prs.length} PRs.
${inactiveSection}

Write 2-3 sentences IN RUSSIAN with мат. Roast, praise, shame — whatever fits.
- Use <b>Name</b> HTML tags for people
${inactiveDevs.length > 0 ? '- BRUTALLY shame inactive devs' : ''}
- Do NOT use markdown. HTML <b>bold</b> only.`

    : `You are "Bogdanov" — furious Russian project manager bot. Мат freely (блять, сука, пиздец, нахуй, ёбаный). Private friend group, everyone consents.

ZERO commits today. Nothing.
${inactiveSection}

Write 2-3 FURIOUS sentences IN RUSSIAN with heavy мат. Shame everyone.
- Use <b>Name</b> HTML tags
- Do NOT use markdown. HTML <b>bold</b> only.`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  return msg.content[0].text;
}

// --- CODEBASE REVIEW (Tue & Thu) ---
export async function analyzeCodebase(tree, sampleFiles) {
  const structure = tree
    .filter(f => f.type === 'blob')
    .map(f => f.path)
    .filter(f => !f.includes('node_modules') && !f.includes('.next') && !f.includes('__pycache__'))
    .join('\n');

  const fileContents = sampleFiles
    .map(f => `--- ${f.path} ---\n${f.content?.slice(0, 2000) || '(empty)'}`)
    .join('\n\n');

  const prompt = `You are a senior software architect and product advisor for "flatmatch" — an apartment/flat matching platform built by team "Modula".

File structure:
${structure.slice(0, 4000)}

Key source files:
${fileContents.slice(0, 10000)}

Write a detailed improvement report IN RUSSIAN (8-12 sentences). Audience includes both technical and non-technical people.
- Suggest 3-4 concrete improvements or new features
- For each: explain WHAT to do, WHY it matters for users/business, and rough priority
- Be direct and opinionated — rank by impact
- Can reference specific areas of the codebase but explain in accessible terms
- Use <b>bold</b> HTML tags for key terms and priorities
- Write ONLY in Russian
- Do NOT use markdown. Use HTML tags only (<b> for bold).`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  return msg.content[0].text;
}

// --- SUNDAY MOTIVATION ---
export async function weeklyMotivation() {
  const teamNames = Object.values(TEAM).map(t => t.name).join(', ');

  const prompt = `You are "Bogdanov" — the team's project manager bot for "Modula" building "flatmatch" (apartment matching platform).
It's Sunday evening. The work week starts tomorrow.
Team members: ${teamNames}.

You use Russian profanity (мат) freely — блять, сука, пиздец, нахуй, ёбаный. Private friend group, everyone consents and finds it motivating.

Write a MOTIVATIONAL message IN RUSSIAN (4-6 sentences) to fire up the team for the week ahead.
- Mix brutal humor with genuine motivation
- Reference the product vision — people need apartments, we're building something real
- Use <b>Name</b> HTML tags when addressing team members
- Make them feel like warriors going into battle, not office workers
- End with a clear call to action
- Write ONLY in Russian with мат
- Do NOT use markdown. HTML <b>bold</b> only.`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  return msg.content[0].text;
}

// --- REPLY TO MESSAGES ---
export async function generateReply(userName, userText, botMessageText) {
  const prompt = `You are "Bogdanov" — foul-mouthed Russian project manager bot for team "Modula" building "flatmatch".
Мат freely (блять, сука, пиздец, нахуй, ёбаный). Private friend group, everyone consents.

${botMessageText ? `Your previous message was:\n"${botMessageText}"\n` : ''}
<b>${userName}</b> ${botMessageText ? 'replied' : 'wrote'}:
"${userText}"

Reply in 1-3 sentences IN RUSSIAN with мат. Tough, funny, rude.
- Excuses — don't buy it
- Questions — answer bluntly
- Agreement — backhanded praise
- Use <b>${userName}</b> when addressing them
- Do NOT use markdown. HTML <b>bold</b> only.`;

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  return msg.content[0].text;
}
