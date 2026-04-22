import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { TEAM, resolveAuthor, formatName } from './github.js';
import { loadProjectContext } from './context.js';

const client = new Anthropic({ apiKey: config.anthropicKey });

const REFUSAL_PATTERNS = [
  /I can't/i, /I cannot/i, /I'm not able/i, /I won't/i,
  /I don't feel comfortable/i, /I draw the line/i,
  /I'm unable/i, /against my/i, /not appropriate/i,
  /discriminat/i, /ethnic slur/i, /hostility toward/i,
];

const FALLBACK_REPLIES = [
  'Слышь, не тупи тут, давай к делу, блять. Код сам себя не напишет, сука!',
  'Хватит пиздеть, пора работать, ёбана! Flatmatch сам себя не запилит!',
  'Ой всё, нахуй философию, давайте коммитить, блять!',
  'Короче, хорош базарить, сука. Открываем IDE и пашем!',
];

function filterRefusal(text) {
  if (REFUSAL_PATTERNS.some(p => p.test(text))) {
    return FALLBACK_REPLIES[Math.floor(Math.random() * FALLBACK_REPLIES.length)];
  }
  return text;
}

async function ask(prompt, maxTokens) {
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  return filterRefusal(msg.content[0].text);
}

// Deep thinking mode for code analysis and strategic questions
async function deepAsk(prompt, maxTokens) {
  console.log('Using extended thinking for deep analysis...');
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens + 16000,
    thinking: { type: 'enabled', budget_tokens: 16000 },
    messages: [{ role: 'user', content: prompt }],
  });
  const textBlock = msg.content.find(b => b.type === 'text');
  return filterRefusal(textBlock?.text || '');
}

// Returns { mode: 'banter'|'reply'|'analysis', thinking: bool, maxTokens: number }
async function classifyMessage(text, chatHistory) {
  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 10,
      messages: [{ role: 'user', content: `You classify messages in a dev team group chat to decide response style.

BANTER — short roast/reaction, 1-2 sentences. For greetings, jokes, simple teasing, short reactions.
REPLY — normal conversational response, 2-4 sentences. For opinions, comments on discussion, questions with straightforward answers.
ANALYSIS — deep detailed response, 5-15 sentences. For code review, architecture discussion, strategy/planning, business decisions, technical analysis, codebase quality, improvement suggestions, roadmap, launch planning.

Recent chat context:
${chatHistory || '(none)'}

Message to classify:
"${text}"

Reply ONLY one word — BANTER, REPLY, or ANALYSIS:` }],
    });
    const answer = msg.content[0].text.trim().toUpperCase();
    console.log(`Classifier: "${text.slice(0, 40)}..." → ${answer}`);
    if (answer.startsWith('ANALYSIS')) return { mode: 'analysis', thinking: true, maxTokens: 1500 };
    if (answer.startsWith('REPLY')) return { mode: 'reply', thinking: false, maxTokens: 500 };
    return { mode: 'banter', thinking: false, maxTokens: 250 };
  } catch (err) {
    console.error('Classifier failed, defaulting to reply:', err.message);
    return { mode: 'reply', thinking: false, maxTokens: 500 };
  }
}

// Build name mapping for prompts so Claude uses exact tags
function nameTagMap() {
  const seen = new Set();
  const entries = [];
  for (const [login, info] of Object.entries(TEAM)) {
    if (seen.has(info.name)) continue;
    seen.add(info.name);
    const tag = info.telegram || `<b>${info.name}</b>`;
    entries.push(`${info.name} = ${tag}`);
  }
  return entries.join('\n');
}

// Build issue assignment summary per person
function issueAssignments(openIssues) {
  const byPerson = {};
  for (const issue of openIssues) {
    if (!issue.assignee) continue;
    const member = resolveAuthor(issue.assignee);
    const name = member.name;
    if (!byPerson[name]) byPerson[name] = [];
    byPerson[name].push(`#${issue.number}: ${issue.title}`);
  }
  if (Object.keys(byPerson).length === 0) return '';
  return '\nAssigned issues per person:\n' + Object.entries(byPerson)
    .map(([name, issues]) => `${name}: ${issues.join(', ')}`)
    .join('\n');
}

const STATIC_CONTEXT = `PROJECT RULES (ALWAYS follow):
- Team: Modula
- Members: Antony (GitHub: Yneth, lead dev), Elias (GitHub: eliaslebed, dev), Gerbert (GitHub: gerbertpr0, manager)
- Task tracking: GitHub Issues (NOT Jira, NOT Trello, NOT Linear — ONLY GitHub Issues)
- NEVER mention tools or services the team doesn't use
- If you don't know something, say you don't know — NEVER make things up`;

async function getProjectContext() {
  const docs = await loadProjectContext();
  return `${STATIC_CONTEXT}\n\nPROJECT DOCUMENTATION (from repo):\n${docs}`;
}

const NAME_RULES = `TEAM MEMBER TAGS (use EXACTLY these when mentioning people, copy-paste as-is):
${nameTagMap()}
IMPORTANT: Always use the exact tag from above. Do NOT wrap @usernames in <b> tags.`;

// --- DAILY PROFESSIONAL REPORT (Mon-Fri) ---
export async function professionalReport(commits, prs, inactiveDevs, openIssues) {
  const pc = await getProjectContext();
  const hasActivity = commits.length > 0 || prs.length > 0;

  const commitInfo = commits.map(c => {
    const login = c.author?.login || c.commit.author.name;
    return `- ${formatName(login)}: ${c.commit.message.split('\n')[0]}`;
  }).join('\n');

  const prInfo = prs.map(p =>
    `- PR #${p.number} "${p.title}" by ${formatName(p.user.login)} (${p.state})`
  ).join('\n');

  const inactiveSection = inactiveDevs.length > 0
    ? `\nNo activity for 3+ days: ${inactiveDevs.map(d => `${d.tag} (${d.days} days)`).join(', ')}`
    : '';

  const assignments = issueAssignments(openIssues);

  const prompt = hasActivity
    ? `You are a professional project status bot for team "Modula".

${pc}

${NAME_RULES}

Last 24h:

COMMITS:
${commitInfo}

PRs:
${prInfo}
${inactiveSection}
${assignments}

Write a PROFESSIONAL daily status update IN RUSSIAN (4-6 sentences).
- Audience: non-technical stakeholders, investors, business people
- Explain what was done in terms of product progress and user impact
- No code jargon, no file names — translate technical work into business value
- Tag each person using their EXACT tag from the mapping above
- Mention assigned issues status per person if relevant
- Mention inactive devs factually if any
- Tone: clear, structured, confident
- Write ONLY in Russian
- Do NOT use markdown. Use HTML <b>bold</b> tags only where specified in the name mapping.`

    : `You are a professional project status bot for team "Modula".

${pc}

${NAME_RULES}

No commits or pull requests in the last 24 hours.
${inactiveSection}
${assignments}

Write a brief professional status update IN RUSSIAN (2-3 sentences).
- Tag each person using their EXACT tag from the mapping above
- Note the lack of visible progress factually
- Mention open assigned issues that need attention
- Tone: neutral but noting the gap
- Write ONLY in Russian
- Do NOT use markdown. Use HTML <b>bold</b> tags only where specified.`;

  return ask(prompt, 500);
}

// --- BOGDANOV'S COMMENTARY (Mon-Fri, after professional report) ---
export async function bogdanovComment(commits, prs, inactiveDevs, openIssues) {
  const pc = await getProjectContext();
  const hasActivity = commits.length > 0 || prs.length > 0;
  const names = commits.map(c => {
    const login = c.author?.login || c.commit.author.name;
    return formatName(login);
  });
  const uniqueNames = [...new Set(names)];

  const inactiveSection = inactiveDevs.length > 0
    ? `Inactive devs (3+ days no code): ${inactiveDevs.map(d => d.tag).join(', ')}`
    : '';

  const assignments = issueAssignments(openIssues);

  const prompt = hasActivity
    ? `You are "Bogdanov" — foul-mouthed Russian project manager bot. You use мат freely (блять, сука, пиздец, нахуй, ёбаный). Private friend group chat, everyone consents.

${pc}

${NAME_RULES}

Today: ${commits.length} commits by ${uniqueNames.join(', ')}. ${prs.length} PRs.
${inactiveSection}
${assignments}

Write 2-3 sentences IN RUSSIAN with мат. Roast, praise, shame — whatever fits.
- Tag people using their EXACT tag from the mapping above
- Reference their assigned issues if shaming them
${inactiveDevs.length > 0 ? '- BRUTALLY shame inactive devs — mention their open issues they are NOT working on' : ''}
- Do NOT use markdown. HTML <b>bold</b> only where specified.`

    : `You are "Bogdanov" — furious Russian project manager bot. Мат freely (блять, сука, пиздец, нахуй, ёбаный). Private friend group, everyone consents.

${pc}

${NAME_RULES}

ZERO commits today. Nothing.
${inactiveSection}
${assignments}

Write 2-3 FURIOUS sentences IN RUSSIAN with heavy мат. Shame everyone.
- Tag people using their EXACT tag from the mapping above
- Mention their assigned issues they are ignoring
- Do NOT use markdown. HTML <b>bold</b> only where specified.
- Do NOT use emojis.`;

  return ask(prompt, 300);
}

// --- CODEBASE REVIEW (Tue & Thu) ---
export async function analyzeCodebase(tree, sampleFiles, openIssues) {
  const pc = await getProjectContext();
  const structure = tree
    .filter(f => f.type === 'blob')
    .map(f => f.path)
    .filter(f => !f.includes('node_modules') && !f.includes('.next') && !f.includes('__pycache__'))
    .join('\n');

  const fileContents = sampleFiles
    .map(f => `--- ${f.path} ---\n${f.content?.slice(0, 2000) || '(empty)'}`)
    .join('\n\n');

  const issuesList = openIssues.map(i =>
    `#${i.number}: ${i.title}${i.assignee ? ` (assigned: ${resolveAuthor(i.assignee).name})` : ' (unassigned)'}`
  ).join('\n');

  const prompt = `You are a senior software architect and product advisor for "flatmatch".

${pc}

${NAME_RULES}

Open GitHub Issues:
${issuesList || 'None'}

File structure:
${structure.slice(0, 4000)}

Key source files:
${fileContents.slice(0, 10000)}

Write a detailed improvement report IN RUSSIAN (8-12 sentences). Audience includes both technical and non-technical people.
- Reference actual open issues from the list above when relevant
- Suggest 3-4 concrete improvements or new features
- For each: explain WHAT to do, WHY it matters for users/business, and rough priority
- Tag responsible people using EXACT tags from the mapping
- Call out unassigned issues that need an owner
- Be direct and opinionated — rank by impact
- Write ONLY in Russian
- Do NOT use markdown. Use HTML tags only (<b> for bold where specified).`;

  return ask(prompt, 800);
}

// --- SUNDAY MOTIVATION ---
export async function weeklyMotivation(openIssues) {
  const pc = await getProjectContext();
  const issueCount = openIssues?.length || 0;
  const assignments = issueAssignments(openIssues || []);

  const prompt = `You are "Bogdanov" — the team's project manager bot for "Modula" building "flatmatch" (apartment matching platform).
It's Sunday evening. The work week starts tomorrow.
Open issues in backlog: ${issueCount}.
${assignments}

${pc}

${NAME_RULES}

You use Russian profanity (мат) freely — блять, сука, пиздец, нахуй, ёбаный. Private friend group, everyone consents and finds it motivating.

Write a MOTIVATIONAL message IN RUSSIAN (4-6 sentences) to fire up the team for the week ahead.
- Mix brutal humor with genuine motivation
- Tag EACH team member using their EXACT tag and tell them what to focus on this week (based on their assigned issues)
- Reference the product vision — people need apartments, we're building something real
- End with a clear call to action
- Write ONLY in Russian with мат
- Do NOT use markdown. HTML <b>bold</b> only where specified.
- Do NOT use emojis.`;

  return ask(prompt, 400);
}

// --- REPLY TO MESSAGES ---
export async function generateReply(userName, userText, botMessageText, openIssues, chatHistory, repoTree, meetTranscript) {
  const pc = await getProjectContext();
  const issuesList = openIssues.map(i =>
    `#${i.number}: ${i.title}${i.assignee ? ` (assigned: ${resolveAuthor(i.assignee).name})` : ''}`
  ).join('\n');

  // Try to find the user's tag
  const userEntry = Object.values(TEAM).find(t => t.name === userName);
  const userTag = userEntry?.telegram || `<b>${userName}</b>`;

  const repoTreeSection = repoTree?.length
    ? `\nRepository file structure:\n${repoTree.join('\n')}\n`
    : '';

  // When a Google Meet call is live, meetTranscript arrives as an array of
  // {speaker, text} entries (speaker may be null). We pass it to Claude so the
  // bot can actually answer "про что мы сейчас говорили" type questions.
  const meetSection = (meetTranscript && meetTranscript.length)
    ? `\nLIVE MEETING TRANSCRIPT (captions from the Google Meet you are currently in — use this to answer questions about what's being discussed RIGHT NOW):\n${
        meetTranscript.map((c) => `${c.speaker || '?'}: ${c.text}`).join('\n').slice(-6000)
      }\n`
    : '';

  const prompt = `You are "Bogdanov" — project manager bot for team "Modula" building "flatmatch".
You speak Russian with мат (блять, сука, пиздец, нахуй, ёбаный). Private friend group, everyone consents.

${pc}

${NAME_RULES}

Open GitHub Issues:
${issuesList || 'None'}
${repoTreeSection}${meetSection}
Recent group chat conversation:
${chatHistory}

${botMessageText ? `The message being replied to:\n"${botMessageText}"\n` : ''}
${userTag} ${botMessageText ? 'replied' : 'wrote'}:
"${userText}"

FOCUS: Answer the SPECIFIC question "${userText}" — do NOT rehash or comment on older conversation topics unless the question explicitly asks about them. The chat history is for context only, not for you to summarize or react to.

Reply IN RUSSIAN with мат.
RESPONSE MODE: {{MODE}}
{{MODE_INSTRUCTIONS}}
- NEVER invent facts, tools, services, or features that don't exist in the project
- Only mention other team members if directly relevant to THIS question
- Use ${userTag} when addressing them (copy EXACTLY)
- Tag other team members using their EXACT tags from the mapping ONLY when relevant to the answer
- Do NOT use markdown. HTML <b>bold</b> only where specified.
- Do NOT use emojis.`;

  const classification = await classifyMessage(userText, chatHistory);
  const modeInstructions = {
    banter: `1-2 sentences. Quick roast, reaction, or comeback. Punchy and funny.`,
    reply: `2-4 sentences. Give your opinion, reference the conversation, answer the question. Use real project facts.`,
    analysis: `5-15 sentences. Deep, serious analysis grounded in real data. Reference actual files from the repo structure, actual GitHub issues, actual tech stack. Be specific with file names, issue numbers, concrete suggestions. You can be serious AND use мат — analytical doesn't mean boring.`,
  };
  const finalPrompt = prompt
    .replace('{{MODE}}', classification.mode.toUpperCase())
    .replace('{{MODE_INSTRUCTIONS}}', modeInstructions[classification.mode]);

  return classification.thinking
    ? deepAsk(finalPrompt, classification.maxTokens)
    : ask(finalPrompt, classification.maxTokens);
}

// --- DECIDE WHETHER TO JUMP INTO CONVERSATION ---
export async function shouldJumpIn(chatHistory) {
  const prompt = `You are "Bogdanov" — a project manager bot silently observing a Telegram group chat for team "Modula" building "flatmatch".

Recent conversation:
${chatHistory}

Should Bogdanov jump into this conversation? Answer ONLY "YES" or "NO".
Say YES if:
- Someone is discussing the project, strategy, features, deadlines, marketing, investors
- Someone is making excuses or slacking
- Someone is arguing about priorities
- The conversation is interesting enough for a project manager to have an opinion
- Someone mentioned the bot by name or asked for input
Say NO if:
- It's casual/off-topic chat unrelated to the project
- Bogdanov already replied recently (his messages appear as "Bogdanov:" in the history)
- Only 1-2 messages since last Bogdanov message
- Nothing worth commenting on

Answer ONLY "YES" or "NO":`;

  const answer = await ask(prompt, 10);
  return answer.trim().toUpperCase().startsWith('YES');
}

// --- PROACTIVE COMMENT ON CONVERSATION ---
export async function proactiveComment(chatHistory, openIssues) {
  const pc = await getProjectContext();
  const issuesList = openIssues.map(i =>
    `#${i.number}: ${i.title}${i.assignee ? ` (assigned: ${resolveAuthor(i.assignee).name})` : ''}`
  ).join('\n');

  const prompt = `You are "Bogdanov" — foul-mouthed Russian project manager bot for team "Modula" building "flatmatch".
Мат freely (блять, сука, пиздец, нахуй, ёбаный). Private friend group, everyone consents.

${pc}

${NAME_RULES}

Open GitHub Issues:
${issuesList || 'None'}

Recent group chat conversation:
${chatHistory}

You've been watching this conversation silently and now want to jump in with your opinion.
Write 1-3 sentences IN RUSSIAN with мат. Be relevant to what people are discussing.
- Reference what specific people said — you've been reading everything
- Give your project manager perspective — business, deadlines, priorities
- Tag people using their EXACT tags from the mapping
- Be opinionated, tough, and funny
- NEVER invent facts — only reference real project data above
- Do NOT use markdown. HTML <b>bold</b> only where specified.
- Do NOT use emojis.`;

  return ask(prompt, 300);
}

// --- ISSUE MANAGEMENT: analyze codebase + roadmap, decide what to close/create ---
export async function analyzeIssues({ openIssues, closedIssues, recentCommits, repoTree, sampleFiles, projectContext }) {
  const issuesList = openIssues.map(i =>
    `#${i.number}: "${i.title}" [assigned: ${i.assignee || 'none'}] [labels: ${i.labels.join(', ') || 'none'}]\n  ${i.body?.slice(0, 200) || '(no description)'}`
  ).join('\n\n');

  const recentlyClosed = closedIssues.map(i => `#${i.number}: "${i.title}" (closed ${i.closed_at})`).join('\n');

  const commitSummary = recentCommits.map(c => {
    const login = c.author?.login || c.commit.author.name;
    return `- ${login}: ${c.commit.message.split('\n')[0]}`;
  }).join('\n');

  const treeSummary = repoTree
    .filter(f => f.type === 'blob')
    .map(f => f.path)
    .filter(f => !f.includes('node_modules') && !f.includes('.next') && !f.includes('dist'))
    .join('\n');

  const fileContents = sampleFiles
    .map(f => `--- ${f.path} ---\n${f.content?.slice(0, 2000) || '(empty)'}`)
    .join('\n\n');

  const teamLogins = Object.entries(TEAM)
    .filter(([, v]) => v.role === 'dev')
    .map(([login, v]) => `${v.name}: ${login}`)
    .join(', ');

  const prompt = `You are a senior project manager AI for "flatmatch" (apartment matching platform) by team "Modula".

PROJECT DOCUMENTATION:
${projectContext}

TEAM (GitHub logins for assignees): ${teamLogins}

CURRENT OPEN ISSUES:
${issuesList || 'None'}

RECENTLY CLOSED ISSUES (last 30 days):
${recentlyClosed || 'None'}

RECENT COMMITS (last 14 days):
${commitSummary || 'None'}

REPOSITORY FILE STRUCTURE:
${treeSummary.slice(0, 5000)}

KEY SOURCE FILES:
${fileContents.slice(0, 10000)}

TASK: Analyze the project state and return a JSON object with issue management actions.

RULES:
- Close issues that are: already implemented (evidence in commits/code), duplicates, no longer relevant to the roadmap, or too vague to be actionable
- Create issues that are: needed based on the roadmap/CLAUDE.md but missing from the board, bugs visible in the code, or improvements that would unblock progress
- Do NOT recreate recently closed issues
- Do NOT create duplicates of existing open issues
- Assignee must be a valid GitHub login from the team list above, or null
- Maximum 5 closes and 5 creates per run
- Each reason/body must be specific and reference real evidence (file paths, commit messages, issue numbers)

Return ONLY valid JSON, no markdown fences, no explanation:
{
  "close": [{ "number": 123, "reason": "why this should be closed" }],
  "create": [{ "title": "short title", "body": "detailed description", "labels": [], "assignee": "github_login_or_null" }]
}`;

  const raw = await deepAsk(prompt, 2000);
  try {
    const cleaned = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
    const result = JSON.parse(cleaned);
    if (result.close?.length > 5) result.close = result.close.slice(0, 5);
    if (result.create?.length > 5) result.create = result.create.slice(0, 5);
    return result;
  } catch (err) {
    console.error('Failed to parse issue analysis JSON:', err.message);
    console.error('Raw response:', raw.slice(0, 500));
    return { close: [], create: [], error: 'parse_failed' };
  }
}

// --- MEET ANNOUNCEMENT ---
// Called when someone pastes a Google Meet link in the group chat.
// `status` is one of: 'joining' | 'busy' | 'failed'.
// Returns a short in-character Russian message for Bogdanov to post.
export async function meetAnnouncement({ fromName, meetUrl, status, reason }) {
  const situationByStatus = {
    joining: `${fromName} только что скинул в чат ссылку на Google Meet звонок. Ты (Bogdanov) сейчас залетаешь в этот звонок чтобы слушать что команда обсуждает и потом доложить.`,
    busy: `${fromName} скинул ссылку на звонок, но ты уже сидишь в ДРУГОМ звонке и не можешь быть в двух сразу. Объясни что ты занят и пусть подождут пока освободишься.`,
    failed: `${fromName} скинул ссылку на звонок, но meet-bot сервис сейчас недоступен и ты не можешь залететь. Причина: ${reason || 'unknown'}. Пожалуйся на это так чтобы Elias (@winfromloss) разобрался с сервисом.`,
  };
  const situation = situationByStatus[status] || situationByStatus.failed;

  const prompt = `You are "Bogdanov" — foul-mouthed Russian project manager bot in a team group chat. Use мат freely (блять, сука, пиздец, нахуй, ёбаный). Private friend group, everyone consents.

${NAME_RULES}

SITUATION:
${situation}

Write ONE short message (1-2 sentences) IN RUSSIAN with мат. Be in character — aggressive PM energy. Reference the person who posted the link using their EXACT tag from the mapping above.
- Do NOT use markdown. HTML <b>bold</b> only where specified.
- Do NOT use emojis.
- Do NOT include the Meet URL in your response — everyone already has it.`;

  return ask(prompt, 200);
}

// --- MEET SUMMARY (posted after a call ends) ---
// Takes the full transcript and returns an in-character Russian message
// summarizing what the team discussed + a roast/reaction in Bogdanov's voice.
export async function meetSummary({ transcript, durationSec, language, fromName }) {
  const pc = await getProjectContext();
  const minutes = Math.max(1, Math.round((durationSec || 0) / 60));
  const truncated = transcript.length > 12000;
  const body = truncated ? transcript.slice(0, 12000) + '…[обрезано]' : transcript;

  const prompt = `You are "Bogdanov" — foul-mouthed Russian project manager bot in the team's group chat. Use мат freely. Private friend group, everyone consents.

${pc}

${NAME_RULES}

You just sat through a ${minutes}-minute Google Meet call that ${fromName} invited you to. The language spoken was ${language || 'unknown'}. Here is the full transcript (auto-generated by Whisper, may have typos):

--- TRANSCRIPT ---
${body}
--- END TRANSCRIPT ---

Write a message IN RUSSIAN with мат that does TWO things:
1. A short factual summary (3-5 bullets): what was discussed, what was decided, who said what — be concrete, cite names/decisions/numbers from the transcript.
2. A Bogdanov-style reaction (2-3 sentences): roast bullshit decisions, call out half-assed plans, praise anything actually useful. Name-and-shame if anyone dodged responsibility.

Rules:
- Tag team members using their EXACT tag from the mapping above (only if they are mentioned in or are participating in the call).
- Do NOT invent names/decisions not in the transcript.
- If the transcript is mostly empty or gibberish, say so plainly ("хуйня какая-то, ничего не понял") instead of making things up.
- Format: use HTML <b>bold</b> for the two section headings only. No markdown. No emojis.
- Keep it under 2000 characters total.`;

  return ask(prompt, 1500);
}
