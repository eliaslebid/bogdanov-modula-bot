import cron from 'node-cron';
import { config } from './config.js';
import { sendMessage, startPolling } from './telegram.js';
import { getCommitsSince, getPRsSince, getRepoTree, getFileContent, getLastCommitPerAuthor, getOpenIssues, getClosedIssues, createIssue, closeIssue, TEAM, tagByName, captureTelegramId } from './github.js';
import { professionalReport, bogdanovComment, analyzeCodebase, weeklyMotivation, generateReply, shouldJumpIn, proactiveComment, analyzeIssues } from './ai.js';

// Cached repo tree for quick access in replies
let cachedRepoTree = null;
let treeCacheTime = 0;
async function getRepoTreeCached() {
  if (cachedRepoTree && Date.now() - treeCacheTime < 30 * 60 * 1000) return cachedRepoTree;
  try {
    const tree = await getRepoTree();
    cachedRepoTree = tree.filter(f => f.type === 'blob')
      .map(f => f.path)
      .filter(f => !f.includes('node_modules') && !f.includes('.next') && !f.includes('dist'));
    treeCacheTime = Date.now();
  } catch (err) {
    console.error('Failed to fetch repo tree:', err.message);
  }
  return cachedRepoTree || [];
}
import { addMessage, formatHistory, formatHistorySinceBotSpoke } from './history.js';
import { loadProjectContext, startContextRefresh } from './context.js';
import { handleMessageForMeet, getCurrentTranscript } from './meet.js';

function getInactiveDevs(lastCommits) {
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const inactive = [];
  const seen = new Set();
  for (const [login, info] of Object.entries(TEAM)) {
    if (info.role === 'manager') continue;
    if (seen.has(info.name)) continue;
    seen.add(info.name);
    const lastDate = lastCommits[login];
    if (!lastDate || lastDate < threeDaysAgo) {
      const days = lastDate
        ? Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24))
        : '???';
      inactive.push({ name: info.name, tag: tagByName(info.name), days });
    }
  }
  return inactive;
}

// --- DAILY REPORT (Mon-Fri 10:00) ---
async function dailyReport() {
  console.log(`[${new Date().toISOString()}] Running daily report...`);
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [commits, prs, lastCommits, openIssues] = await Promise.all([
      getCommitsSince(since),
      getPRsSince(since),
      getLastCommitPerAuthor(),
      getOpenIssues(),
    ]);
    const inactiveDevs = getInactiveDevs(lastCommits);
    console.log(`Found ${commits.length} commits, ${prs.length} PRs, ${inactiveDevs.length} inactive, ${openIssues.length} open issues`);

    const report = await professionalReport(commits, prs, inactiveDevs, openIssues);
    await sendMessage(`📋 <b>Дейли отчёт</b>\n\n${report}`);

    const roast = await bogdanovComment(commits, prs, inactiveDevs, openIssues);
    await sendMessage(roast);

    console.log('Daily report sent.');
  } catch (err) {
    console.error('Daily report failed:', err);
  }
}

// --- CODEBASE REVIEW (Tue & Thu 11:00) ---
async function codebaseReview() {
  console.log(`[${new Date().toISOString()}] Running codebase review...`);
  try {
    const tree = await getRepoTree();
    const codeFiles = tree
      .filter(f => f.type === 'blob')
      .filter(f => /\.(ts|js|py|rs|swift|css|html|json|yaml|yml|toml|dockerfile)$/i.test(f.path))
      .filter(f => !f.path.includes('node_modules') && !f.path.includes('.next') && !f.path.includes('dist'))
      .filter(f => (f.size || 0) < 50000);

    const priority = codeFiles.filter(f =>
      /package\.json$|tsconfig|\.env\.example|docker|readme/i.test(f.path) ||
      /^src\/(index|main|app)\./i.test(f.path)
    );
    const srcFiles = codeFiles.filter(f =>
      /^src\//.test(f.path) && !priority.includes(f)
    ).slice(0, 10);

    const filesToRead = [...priority, ...srcFiles].slice(0, 15);
    const sampleFiles = [];
    for (const f of filesToRead) {
      const content = await getFileContent(f.path);
      if (content) sampleFiles.push({ path: f.path, content });
    }

    const openIssues = await getOpenIssues();
    console.log(`Read ${sampleFiles.length} files, ${openIssues.length} open issues for analysis`);
    const review = await analyzeCodebase(tree, sampleFiles, openIssues);
    await sendMessage(`🔍 <b>Обзор кодовой базы</b>\n\n${review}`);
    console.log('Codebase review sent.');
  } catch (err) {
    console.error('Codebase review failed:', err);
  }
}

// --- SUNDAY MOTIVATION (Sun 19:00) ---
async function sundayMotivation() {
  console.log(`[${new Date().toISOString()}] Running Sunday motivation...`);
  try {
    const openIssues = await getOpenIssues();
    const motivation = await weeklyMotivation(openIssues);
    await sendMessage(`🔥 <b>Неделя начинается</b>\n\n${motivation}`);
    console.log('Sunday motivation sent.');
  } catch (err) {
    console.error('Sunday motivation failed:', err);
  }
}

// --- ISSUE MANAGEMENT ---
async function manageIssues(dryRun = false) {
  console.log(`[ISSUES] Running issue management${dryRun ? ' (DRY RUN)' : ''}...`);
  try {
    const since14d = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [openIssues, closedIssues, recentCommits, tree] = await Promise.all([
      getOpenIssues(),
      getClosedIssues(since30d),
      getCommitsSince(since14d),
      getRepoTree(),
    ]);

    // Read key source files (same logic as codebaseReview)
    const codeFiles = tree
      .filter(f => f.type === 'blob')
      .filter(f => /\.(ts|js|py|rs|swift|css|html|json|yaml|yml|toml|dockerfile)$/i.test(f.path))
      .filter(f => !f.path.includes('node_modules') && !f.path.includes('.next') && !f.path.includes('dist'))
      .filter(f => (f.size || 0) < 50000);
    const priority = codeFiles.filter(f =>
      /package\.json$|tsconfig|\.env\.example|docker|readme|claude/i.test(f.path) ||
      /^src\/(index|main|app)\./i.test(f.path)
    );
    const srcFiles = codeFiles.filter(f => /^src\//.test(f.path) && !priority.includes(f)).slice(0, 10);
    const filesToRead = [...priority, ...srcFiles].slice(0, 15);
    const sampleFiles = [];
    for (const f of filesToRead) {
      const content = await getFileContent(f.path);
      if (content) sampleFiles.push({ path: f.path, content });
    }

    const projectContext = await loadProjectContext();
    console.log(`[ISSUES] Data: ${openIssues.length} open, ${closedIssues.length} recently closed, ${recentCommits.length} commits, ${sampleFiles.length} files read`);

    const plan = await analyzeIssues({ openIssues, closedIssues, recentCommits, repoTree: tree, sampleFiles, projectContext });

    if (plan.error) {
      await sendMessage('<b>Управление задачами</b>\n\nНе удалось проанализировать задачи, блять. Попробуйте позже.');
      return;
    }

    console.log(`[ISSUES] Plan: close ${plan.close?.length || 0}, create ${plan.create?.length || 0}`);

    const results = { closed: [], created: [], errors: [] };

    if (dryRun) {
      // Just report what would happen
      let report = '<b>Управление задачами (DRY RUN)</b>\n\n';
      if (plan.close?.length) {
        report += '<b>Закрыл бы:</b>\n' + plan.close.map(i => `- #${i.number}: ${i.reason}`).join('\n') + '\n\n';
      }
      if (plan.create?.length) {
        report += '<b>Создал бы:</b>\n' + plan.create.map(i => `- "${i.title}" (${i.assignee || 'без назначения'})`).join('\n');
      }
      await sendMessage(report);
      return;
    }

    // Execute closes
    for (const item of (plan.close || [])) {
      try {
        const result = await closeIssue(item.number, item.reason);
        if (result) results.closed.push({ number: item.number, reason: item.reason });
        else results.errors.push(`Close #${item.number} failed`);
      } catch (err) {
        results.errors.push(`Close #${item.number}: ${err.message}`);
      }
    }

    // Execute creates
    for (const item of (plan.create || [])) {
      try {
        const result = await createIssue(item.title, item.body, item.labels, item.assignee);
        if (result) results.created.push(result);
        else results.errors.push(`Create "${item.title}" failed`);
      } catch (err) {
        results.errors.push(`Create "${item.title}": ${err.message}`);
      }
    }

    // Build report
    let report = '<b>Управление задачами</b>\n\n';
    if (results.closed.length) {
      report += '<b>Закрыто:</b>\n' + results.closed.map(i => `- #${i.number}: ${i.reason}`).join('\n') + '\n\n';
    }
    if (results.created.length) {
      report += '<b>Создано:</b>\n' + results.created.map(i => `- #${i.number}: ${i.title}`).join('\n') + '\n\n';
    }
    if (results.errors.length) {
      report += '<b>Ошибки:</b>\n' + results.errors.join('\n') + '\n\n';
    }
    if (!results.closed.length && !results.created.length && !results.errors.length) {
      report += 'Всё актуально, менять нечего.';
    }
    await sendMessage(report);
    console.log(`[ISSUES] Done: ${results.closed.length} closed, ${results.created.length} created, ${results.errors.length} errors`);
  } catch (err) {
    console.error('[ISSUES] Failed:', err);
  }
}

// --- Track ALL messages + proactive jump-in ---
let messagesSinceLastCheck = 0;
let isChecking = false;

function trackMessage(msg, isMention = false) {
  captureTelegramId(msg);
  addMessage(msg);

  // Don't count bot's own messages or messages already handled as mentions
  if (msg.from?.is_bot) return;

  // Meet URL auto-trigger runs before the mention guard so pasting a link
  // alone (no mention, no reply) still pulls Bogdanov into the call.
  handleMessageForMeet(msg);

  if (isMention) return;

  messagesSinceLastCheck++;

  // Check if Bogdanov should jump in
  if (messagesSinceLastCheck >= 1 && !isChecking) {
    messagesSinceLastCheck = 0;
    isChecking = true;
    checkAndJumpIn().finally(() => { isChecking = false; });
  }
}

async function checkAndJumpIn() {
  try {
    const newMessages = formatHistorySinceBotSpoke();
    if (!newMessages) {
      console.log('[PROACTIVE] No new messages since bot last spoke, skipping');
      return;
    }
    console.log(`[PROACTIVE] New messages since bot last spoke:\n${newMessages}`);
    const jump = await shouldJumpIn(newMessages);
    console.log(`[PROACTIVE] Should jump in? ${jump}`);
    if (jump) {
      const openIssues = await getOpenIssues();
      const comment = await proactiveComment(newMessages, openIssues);
      console.log(`[PROACTIVE] Sending: "${comment.slice(0, 100)}..."`);
      const sent = await sendMessage(comment);
      if (sent?.result) addMessage(sent.result);
      console.log('[PROACTIVE] Comment sent.');
    }
  } catch (err) {
    console.error('[PROACTIVE] Jump-in check failed:', err);
  }
}

// --- Reply handler ---
async function handleReply(msg) {
  const userName = msg.from.first_name || msg.from.username || 'Аноним';
  const userText = msg.text || '';
  const botMessageText = msg.reply_to_message?.text || '';

  if (!userText) return;

  console.log(`[REPLY] From ${userName}: "${userText}"`);
  console.log(`[REPLY] Replying to msg_id=${msg.message_id}, reply_to="${botMessageText.slice(0, 50)}"`);

  // Check if user is asking to manage issues
  const issueKeywords = ['управляй задачами', 'разбери задачи', 'manage issues', 'почисти issues', 'обнови задачи', 'проверь задачи', 'обнови борд', 'обнови борду'];
  const lower = userText.toLowerCase();
  if (issueKeywords.some(k => lower.includes(k))) {
    console.log('[REPLY] Detected issue management request');
    await sendMessage('Секунду, разбираюсь с задачами на GitHub...', msg.message_id);
    await manageIssues();
    return;
  }

  try {
    const [openIssues, repoTree, meetTranscript] = await Promise.all([
      getOpenIssues(),
      getRepoTreeCached(),
      getCurrentTranscript(),
    ]);
    const chatHistory = formatHistory(20);
    console.log(`[REPLY] History (last 20):\n${chatHistory}`);
    if (meetTranscript?.length) {
      console.log(`[REPLY] Injecting live meet transcript (${meetTranscript.length} captions)`);
    }
    const reply = await generateReply(userName, userText, botMessageText, openIssues, chatHistory, repoTree, meetTranscript);
    console.log(`[REPLY] Sending: "${reply.slice(0, 100)}..."`);
    const sent = await sendMessage(reply, msg.message_id);
    if (sent?.result) {
      addMessage(sent.result);
    }
    console.log('[REPLY] Sent.');
  } catch (err) {
    console.error('Reply failed:', err);
  }
}

// --- SCHEDULING ---
if (!config.isDev) {
  cron.schedule('0 10 * * 1-5', dailyReport);
  cron.schedule('0 11 * * 2,4', codebaseReview);
  cron.schedule('0 19 * * 0', sundayMotivation);
} else {
  console.log('[config] dev mode — cron schedules disabled');
}

// Pre-load project context from README.md + CLAUDE.md
await loadProjectContext();
startContextRefresh();

console.log('Bogdanov bot started!');
console.log('Schedule:');
console.log('  Mon-Fri 10:00  — Daily report (professional + roast)');
console.log('  Tue,Thu 11:00  — Codebase review & suggestions');
console.log('  Sun     19:00  — Weekly motivation');

// --- CLI ---
const arg = process.argv[2];
if (arg === '--daily') {
  dailyReport().then(() => process.exit(0));
} else if (arg === '--review') {
  codebaseReview().then(() => process.exit(0));
} else if (arg === '--motivation') {
  sundayMotivation().then(() => process.exit(0));
} else if (arg === '--manage-issues') {
  manageIssues().then(() => process.exit(0));
} else if (arg === '--manage-issues-dry') {
  manageIssues(true).then(() => process.exit(0));
} else if (arg === '--test') {
  sendMessage('<b>Bogdanov</b> на связи. Слежу за вашим кодом. Всегда слежу.')
    .then(() => { console.log('Test message sent.'); process.exit(0); });
} else {
  startPolling(handleReply, trackMessage);
}
