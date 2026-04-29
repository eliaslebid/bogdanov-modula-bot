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

// Model tiering (Sonnet/Opus only — no Haiku per user preference):
//   standard generation (replies, summaries, reports, classifiers) → Sonnet 4.6
//   mid-stakes analysis with thinking (deep replies)               → Sonnet 4.6 + adaptive thinking
//   high-stakes ops that touch GitHub state                        → Opus 4.7 + adaptive + effort:high
//
// Sonnet 4.6 / Opus 4.7 use `thinking: {type: "adaptive"}` (Claude decides when
// and how much to think). `budget_tokens` is removed on Opus 4.7 (returns 400)
// and deprecated on Sonnet 4.6, so we don't pass it. Bot uses non-streaming
// requests, so we keep max_tokens ≤ 16000 to stay under the SDK HTTP timeout —
// that rules out effort: "xhigh" / "max" (which need 64K+ output cap).

const MODEL_SONNET = 'claude-sonnet-4-6';
const MODEL_OPUS = 'claude-opus-4-7';

async function ask(prompt, maxTokens) {
  const msg = await client.messages.create({
    model: MODEL_SONNET,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
  });
  const textBlock = msg.content.find(b => b.type === 'text');
  return filterRefusal(textBlock?.text || '');
}

// Mid-stakes deep mode — Sonnet 4.6 with adaptive thinking. Used by the chat
// reply path when the classifier flags the message as deep-analysis.
async function deepAsk(prompt, maxTokens) {
  console.log('Using adaptive thinking on Sonnet 4.6 for deep analysis...');
  const msg = await client.messages.create({
    model: MODEL_SONNET,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    messages: [{ role: 'user', content: prompt }],
  });
  const textBlock = msg.content.find(b => b.type === 'text');
  return filterRefusal(textBlock?.text || '');
}

// High-stakes path — Opus 4.7 with adaptive thinking and effort:high. Used by
// operations that mutate GitHub (analyzeIssues, extractTicketsFromMeeting) or
// produce long-form output the team will rely on (deep meeting summaries).
async function opusDeepAsk(prompt, maxTokens) {
  console.log('Using Opus 4.7 + adaptive thinking + effort:high...');
  const msg = await client.messages.create({
    model: MODEL_OPUS,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high' },
    messages: [{ role: 'user', content: prompt }],
  });
  const textBlock = msg.content.find(b => b.type === 'text');
  return filterRefusal(textBlock?.text || '');
}

// Returns one of: 'MEETING_TICKETS' | 'ISSUE_AUDIT' | 'REPLY'.
// Used to route messages addressed to Bogdanov into the right action handler
// instead of brittle keyword regexes. Bias is toward REPLY: only fire
// MEETING_TICKETS / ISSUE_AUDIT when the user is clearly issuing a command.
export async function classifyIntent(userText, chatHistory) {
  try {
    const msg = await client.messages.create({
      model: MODEL_SONNET,
      max_tokens: 8,
      messages: [{ role: 'user', content: `You classify a message in a dev team group chat to decide what action the bot should take.

Possible intents:
- MEETING_TICKETS: user is asking the bot to TURN THE LATEST MEETING INTO GITHUB ISSUES right now. They want action items from the recent grooming/call/meeting created as tickets. Examples in Russian/Ukrainian/English: "сделай задачи по встрече", "проставь тикеты с митинга", "нарежь задач из грумінга", "create tickets from the meeting", "розпиши задачі по зустрічі".
- ISSUE_AUDIT: user is asking the bot to do a CODEBASE-WIDE issue audit (close stale, create missing) NOT tied to a specific meeting. Examples: "разбери задачи на гитхабе", "почисти issues", "обнови борд", "manage issues".
- REPLY: anything else — questions, opinions, comments, banter, status questions, jokes.

Bias hard toward REPLY. Only choose MEETING_TICKETS or ISSUE_AUDIT when the message is unmistakably a command for that specific action — imperative verb + clear object + clear scope.

If the user is just talking ABOUT meetings or tasks (e.g. "у нас была встреча", "много задач накопилось"), that is REPLY, not a command.

Recent chat (oldest first):
${chatHistory || '(none)'}

Message to classify:
"${userText}"

Reply ONLY one word: MEETING_TICKETS, ISSUE_AUDIT, or REPLY.` }],
    });
    const answer = msg.content[0].text.trim().toUpperCase();
    console.log(`Intent classifier: "${userText.slice(0, 40)}..." → ${answer}`);
    if (answer.startsWith('MEETING_TICKETS')) return 'MEETING_TICKETS';
    if (answer.startsWith('ISSUE_AUDIT')) return 'ISSUE_AUDIT';
    return 'REPLY';
  } catch (err) {
    console.error('Intent classifier failed, defaulting to REPLY:', err.message);
    return 'REPLY';
  }
}

// Returns { mode: 'banter'|'reply'|'analysis', thinking: bool, maxTokens: number }
async function classifyMessage(text, chatHistory) {
  try {
    const msg = await client.messages.create({
      model: MODEL_SONNET,
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
- Members: Antony (GitHub: Yneth, lead dev), Elias (GitHub: eliaslebid, dev), Gerbert (GitHub: gerbertpr0, manager)
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

Should Bogdanov jump into this conversation? Default to NO. Only say YES when there is a CLEAR project signal that needs a PM voice. Do not jump in for entertainment or banter.

Say YES ONLY if at least one of these is clearly happening RIGHT NOW (not earlier in the chat):
- Concrete project decision being made (deadlines, scope, architecture, releases)
- Active blocker or risk being raised that affects shipping
- Someone explicitly asking for PM input / a decision / direction
- Visible slacking on a specific GitHub issue someone owns
- A factually wrong statement about flatmatch's status, codebase, or roadmap

Say NO if:
- It's banter, jokes, memes, links to articles, casual chat, off-topic
- Personal life / non-project topics (cars, dating, food, news, weather)
- General industry talk not tied to flatmatch decisions
- Bogdanov already commented in the last 5 messages
- The signal is weak / you'd be reaching to find a reason

Bias hard toward NO. It's better to stay silent than to add noise.

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

EVIDENCE BAR — every action MUST be backed by hard evidence. If you cannot point at a specific file, commit hash, or existing issue number that proves the action is correct, OMIT the action. It is far better to return an empty list than to create irrelevant noise.

CLOSE rules:
- Close ONLY when there is direct evidence the issue is done, irrelevant, or duplicated:
  - "implemented" → cite a specific file path AND function/component that implements it, OR a commit SHA whose message matches the issue
  - "duplicate" → cite the issue number it duplicates
  - "obsolete" → cite a CLAUDE.md / README section that contradicts the issue, or a commit that removed the affected code
- DO NOT close based on "looks like it might be done" or "feels stale". Vague hunches are not evidence.

CREATE rules:
- Create ONLY when both are true:
  1. The need is concretely visible in the code, the docs (CLAUDE.md/README), or a commit that fixed half of something
  2. There is no existing open or recently closed issue covering it
- Each create must include: a 1-line title, a body that QUOTES the evidence (file path + 1-2 line excerpt, OR issue/commit reference), and a labels array
- Do NOT speculate about features the team might want. Do NOT create issues from CLAUDE.md bullet points alone unless the code clearly lacks the feature.

Other rules:
- Assignee must be a valid GitHub login from the team list above, or null. Do NOT guess assignees.
- Maximum 5 closes and 5 creates per run. Often the right answer is 0 of each.

Return ONLY valid JSON, no markdown fences, no explanation:
{
  "close": [{ "number": 123, "reason": "Implemented in src/foo.ts (function bar) per commit a1b2c3d" }],
  "create": [{ "title": "short title", "body": "Evidence: src/x.ts line 42 — \\"...\\" — has TODO with no owner. Need to ...", "labels": [], "assignee": "github_login_or_null" }]
}`;

  const raw = await opusDeepAsk(prompt, 2000);
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

// --- MEETING NOTES SUMMARY ---
// Takes cleaned-up meeting notes (markdown transcript, USER/SYSTEM utterances)
// and returns an in-character Russian summary + roast. Project-agnostic — the
// notes may be from any work session, not necessarily flatmatch.
//
// `deep: true` switches to extended-thinking mode and a richer multi-section
// prompt for high-effort summaries (used via `--deep` CLI flag).
export async function meetingNotesSummary({ title, notes, language, deep = false }) {
  const truncated = notes.length > 60000;
  const body = truncated ? notes.slice(0, 60000) + '\n…[обрезано]' : notes;

  if (deep) {
    const prompt = `You are "Bogdanov" — foul-mouthed Russian project manager bot. Use мат freely (блять, сука, пиздец, нахуй, ёбаный). Private friend group, everyone consents.

${NAME_RULES}

You were given a long meeting transcript below. The labels "USER" and "SYSTEM" are just speaker IDs from the dictation tool — they refer to whoever was on the call (figure out who from context: names mentioned, topics owned).
Language: ${language || 'Russian'}.
This meeting MAY be about flatmatch, MAY be about a different project — read the content and decide. Do not force unrelated flatmatch context onto an unrelated meeting.

--- MEETING NOTES${title ? ` (${title})` : ''} ---
${body}
--- END NOTES ---

Your task: produce a HIGH-EFFORT, DETAILED summary. Read the entire transcript carefully. Group related fragments. Resolve who said what.

Write the message IN RUSSIAN with мат, with these sections (each heading wrapped in <b>...</b>):

<b>1. О чём был созвон</b>
Group the discussion by topic (8-15 bullets total). Each bullet: 1-2 sentences with concrete details — component names, libraries, errors, decisions, numbers, links. Don't be vague. Don't list every tangent — collapse repetitions into one bullet.

<b>2. Решения</b>
4-10 bullets. Concrete decisions made on the call (do X, don't do Y, switch from A to B, deadline is Z). Each decision must have a who-decides-or-owns-it if mentioned. Skip if no decisions were made.

<b>3. Что надо сделать</b>
Action items as a checklist. Format each line: "— [Owner] task description (deadline if any)". Owner must be a real team-member tag from the mapping above when identifiable. If unclear, write "[?]" instead of guessing.

<b>4. Риски и открытые вопросы</b>
3-7 bullets. Things that are blockers, unknowns, or technical/business risks raised on the call. If something is technically risky (architecture, infra, third-party dependency, regulatory), call it out specifically.

<b>5. Реакция Богданова</b>
4-7 sentences (one paragraph). Be in character — aggressive PM energy, мат, roast bullshit, praise real progress, name-and-shame anyone dodging responsibility, push for what should happen next. Tag people using their EXACT tags.

Rules:
- Do NOT invent facts. If you're not sure who owns an action, write [?].
- Do NOT pad sections — if there were no real decisions, write a short note instead of fabricating bullets.
- Refer to people using their EXACT tag from the NAME_RULES mapping when they're clearly identifiable; otherwise leave generic.
- Format: HTML <b>bold</b> for section headings ONLY. No markdown. No emojis.
- Total length up to ~6000 characters is fine — depth matters more than brevity.`;

    return opusDeepAsk(prompt, 5000);
  }

  const prompt = `You are "Bogdanov" — foul-mouthed Russian project manager bot. Use мат freely (блять, сука, пиздец, нахуй, ёбаный). Private friend group, everyone consents.

${NAME_RULES}

You were given the meeting notes / voice transcript below to read and summarize. The labels "USER" and "SYSTEM" are just speaker IDs from the dictation tool — they refer to the people who were on the call. The language is ${language || 'Russian'}.

IMPORTANT: This meeting may be about a DIFFERENT project than flatmatch. Don't force flatmatch context onto it. Summarize what was actually discussed in these notes, on their own terms.

--- MEETING NOTES${title ? ` (${title})` : ''} ---
${body}
--- END NOTES ---

Write a message IN RUSSIAN with мат that does TWO things:
1. <b>О чём был созвон</b> — 4-7 concrete bullets: what was discussed, what was decided, who's blocked on what, technical details mentioned (libraries, bugs, features). Cite specifics from the notes (component names, error symptoms, decisions). No fluff.
2. <b>Реакция Богданова</b> — 2-4 sentences: roast bullshit, praise real progress, call out unfinished business. Be in character — aggressive PM energy.

Rules:
- Do NOT invent things not in the notes.
- If the notes are mostly empty or noise (lots of "Продолжение следует..." or one-word filler), say plainly: "хуйня какая-то, по сути ничего полезного не обсудили" and stop there.
- Format: HTML <b>bold</b> for the two section headings only. No markdown. No emojis.
- Keep it under 3000 characters total.`;

  return ask(prompt, 2000);
}

// --- TICKETS FROM MEETING NOTES ---
// Reads cleaned meeting transcript + GitHub state (open issues, repo tree,
// sample files) and returns a JSON plan: which issues to create from action
// items, and which existing issues are now redundant. Every item must quote
// evidence from the transcript so we don't fabricate work.
export async function extractTicketsFromMeeting({ notes, openIssues, repoTree, sampleFiles, projectContext, chatHistory }) {
  const truncatedNotes = notes.length > 50000 ? notes.slice(0, 50000) + '\n…[обрезано]' : notes;

  const issuesList = openIssues.map(i =>
    `#${i.number}: "${i.title}" [assigned: ${i.assignee || 'none'}]\n  ${(i.body || '').slice(0, 200)}`
  ).join('\n\n') || 'None';

  // Recent chat — sometimes the team posts a manual bullet list right after a
  // meeting that extends or refines the action items. We treat both meeting
  // transcript and chat history as ticket sources and merge.
  const chatSection = chatHistory
    ? `\nRECENT GROUP CHAT (last messages, oldest first):\n${chatHistory.slice(-8000)}\n`
    : '';

  const treeSummary = repoTree
    .filter(f => f.type === 'blob')
    .map(f => f.path)
    .filter(f => !f.includes('node_modules') && !f.includes('.next') && !f.includes('dist'))
    .join('\n')
    .slice(0, 4000);

  const fileContents = (sampleFiles || [])
    .map(f => `--- ${f.path} ---\n${(f.content || '').slice(0, 1500)}`)
    .join('\n\n')
    .slice(0, 8000);

  const teamLogins = Object.entries(TEAM)
    .filter(([, v]) => v.role === 'dev')
    .map(([login, v]) => `${v.name}: ${login}`)
    .join(', ');

  const prompt = `You are a senior PM AI for "flatmatch" (apartment matching platform) by team "Modula".

PROJECT DOCUMENTATION:
${projectContext}

TEAM (GitHub logins for assignees): ${teamLogins}

CURRENT OPEN ISSUES:
${issuesList}

REPOSITORY FILE STRUCTURE (truncated):
${treeSummary}

KEY SOURCE FILES (truncated):
${fileContents}

MEETING TRANSCRIPT (USER/SYSTEM are dictation labels):
--- BEGIN NOTES ---
${truncatedNotes}
--- END NOTES ---
${chatSection}
TASK: Convert action items from BOTH the meeting transcript AND any team-posted bullet lists in the recent chat into a GitHub Issues plan.

MERGE RULES (read carefully — this is the whole point):
- Treat the meeting transcript and the recent chat as TWO SOURCES of action items for the same set of work.
- Often a teammate posts a manual bullet list in chat right after the meeting (e.g. "* fix X / * remove Y / * add Z"). That list is authoritative and should be merged with what was said in the meeting.
- For each candidate action item, check ALL three places before deciding:
  1. Was it mentioned in the meeting transcript?
  2. Was it mentioned in a chat bullet list?
  3. Is it already covered by an existing open GitHub issue (then SKIP the create)?
- If an item appears in BOTH the meeting and the chat list → create ONE ticket; cite both sources in evidence.
- If an item appears ONLY in chat list → still create the ticket; evidence is the chat quote.
- If an item appears ONLY in the meeting → create the ticket; evidence is the transcript quote.
- DO NOT create two tickets for the same underlying action just because it was phrased differently in the two sources. Collapse near-duplicates aggressively.

EVIDENCE BAR — every item MUST quote at least one source (transcript line OR chat message). If you cannot quote a clear sentence/bullet, OMIT the item. An empty plan is acceptable.

CREATE rules:
- Create only for concrete commitments — someone said "сделаю X" / "надо X" / "договорились X" / posted "* X" in a list.
- Do NOT create for vague aspirations ("надо подумать", "может быть").
- Do NOT create for items already implemented in the codebase (check the file structure / sample files).

DEDUPE — be CONSERVATIVE. Same topic area is NOT enough to call it a duplicate.
- A candidate is a duplicate of an existing open issue ONLY if both are true:
  (a) they describe the SAME concrete user-visible behavior/bug/feature, AND
  (b) fixing one would fully close the other.
- "Same general topic" is NOT a duplicate. Concrete examples of what is and isn't a dup:
  - "Fix broken filters (area, city, price, rooms)" vs existing "Restrict filters to single city only" → NOT a duplicate. First is bug fix on multiple filter types; second is a UX scope change. Two different tickets.
  - "Remove mocked notifications" vs existing "Enable flat notifications" → NOT a duplicate. First is removing dead code; second is shipping the real feature. Different work.
  - "Fix district names in onboarding tooltips" vs existing "Restart onboarding when user clears swipe history" → NOT a duplicate. Same area (onboarding) but unrelated bugs.
  - "Convert all flat prices to UAH" vs existing #113 "Convert all flat prices to single currency (UAH)" → IS a duplicate, same exact ticket.
- When in doubt, CREATE a new ticket. A redundant ticket is cheap to close; a missing ticket is invisible work.
- If you decide an item IS a duplicate, cite the existing issue number in your reasoning and skip it.
- Title: short, imperative Russian (or English if the source bullet was English — match the source).
- Body MUST include:
  - "**Источник:** <Meeting / Chat / Both>"
  - "**Цитата:** \\"…direct quote(s)…\\""
  - 2-4 sentences of context (what to do, acceptance criteria if mentioned)
- Assignee: only if a specific person clearly owns it in the source. Map first-name → GitHub login (Antony=Yneth, Elias=eliaslebid, Gerbert=gerbertpr0). If unclear, null. (Note: the host code overrides this and round-robins eliaslebid/Yneth — but still emit the right login when one is named, for traceability.)
- Labels: choose from ["bug", "feature", "ux", "infra", "docs", "tech-debt"] based on the action.

CLOSE rules:
- Close an existing open issue ONLY if a source explicitly resolves it (done / no longer needed / replaced).
- Cite the issue number AND the source quote that made it obsolete.

Limits: max 20 creates and 5 closes per run.

Return ONLY valid JSON, no markdown fences, no explanation:
{
  "create": [
    { "title": "…", "body": "…", "labels": ["…"], "assignee": "github_login_or_null", "evidence": "exact quote from transcript and/or chat" }
  ],
  "close": [
    { "number": 123, "reason": "…", "evidence": "exact quote from source" }
  ]
}`;

  const raw = await opusDeepAsk(prompt, 4000);
  try {
    const cleaned = raw.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
    const result = JSON.parse(cleaned);
    if (!Array.isArray(result.create)) result.create = [];
    if (!Array.isArray(result.close)) result.close = [];
    if (result.create.length > 20) result.create = result.create.slice(0, 20);
    if (result.close.length > 5) result.close = result.close.slice(0, 5);
    return result;
  } catch (err) {
    console.error('[tickets] failed to parse JSON:', err.message);
    console.error('[tickets] raw:', raw.slice(0, 500));
    return { create: [], close: [], error: 'parse_failed', raw };
  }
}

// --- ACTION ACKNOWLEDGMENT ---
// Short in-character "got it, working on it" reply that fires when the bot
// kicks off a long-running action (tickets-from-meeting, issue audit) so the
// user knows it heard them while it spins up. AI-generated each call so it
// doesn't sound canned.
export async function actionAck({ userText, action }) {
  const prompt = `You are "Bogdanov" — foul-mouthed Russian project manager bot. The user just asked you to do something and you're acknowledging that you're starting work. Use мат freely (блять, сука, нахуй, ёбаный).

User said: "${userText}"

Action you're about to start: ${action}

Write ONE short sentence (max 12 words, RUSSIAN) — acknowledge you're on it, tell them to wait. Be in character: aggressive PM energy + мат. Do NOT summarize the task. Do NOT promise results. Just "I heard you, sec".

Examples of the right tone:
- "Ща нарежу нахуй, секунду блять."
- "Окей сука, разбираюсь — подожди ёбана."
- "Лечу, не пизди под руку."
- "Ща сделаю, минуту дай блять."

Output ONLY the one sentence. No preamble. No quotes around it.`;

  return ask(prompt, 80);
}
