import cron from 'node-cron';
import { config } from './config.js';
import { sendMessage, startPolling } from './telegram.js';
import { getCommitsSince, getPRsSince, getRepoTree, getFileContent, getLastCommitPerAuthor, TEAM } from './github.js';
import { professionalReport, bogdanovComment, analyzeCodebase, weeklyMotivation, generateReply } from './ai.js';

function getInactiveDevs(lastCommits) {
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const inactive = [];
  for (const [login, info] of Object.entries(TEAM)) {
    const lastDate = lastCommits[login];
    if (!lastDate || lastDate < threeDaysAgo) {
      const days = lastDate
        ? Math.floor((Date.now() - lastDate.getTime()) / (1000 * 60 * 60 * 24))
        : '???';
      inactive.push({ name: info.name, telegram: info.telegram, days });
    }
  }
  return inactive;
}

// --- DAILY REPORT (Mon-Fri 10:00) ---
async function dailyReport() {
  console.log(`[${new Date().toISOString()}] Running daily report...`);
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [commits, prs, lastCommits] = await Promise.all([
      getCommitsSince(since),
      getPRsSince(since),
      getLastCommitPerAuthor(),
    ]);
    const inactiveDevs = getInactiveDevs(lastCommits);
    console.log(`Found ${commits.length} commits, ${prs.length} PRs, ${inactiveDevs.length} inactive`);

    // 1. Professional report
    const report = await professionalReport(commits, prs, inactiveDevs);
    await sendMessage(`📋 <b>Дейли отчёт</b>\n\n${report}`);

    // 2. Bogdanov's take (separate message)
    const roast = await bogdanovComment(commits, prs, inactiveDevs);
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

    console.log(`Read ${sampleFiles.length} files for analysis`);
    const review = await analyzeCodebase(tree, sampleFiles);
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
    const motivation = await weeklyMotivation();
    await sendMessage(`🔥 <b>Неделя начинается</b>\n\n${motivation}`);
    console.log('Sunday motivation sent.');
  } catch (err) {
    console.error('Sunday motivation failed:', err);
  }
}

// --- Reply handler ---
async function handleReply(msg) {
  const userName = msg.from.first_name || msg.from.username || 'Аноним';
  const userText = msg.text || '';
  const botMessageText = msg.reply_to_message?.text || '';

  if (!userText) return;

  console.log(`[${new Date().toISOString()}] Reply from ${userName}: "${userText}"`);
  try {
    const reply = await generateReply(userName, userText, botMessageText);
    await sendMessage(reply, msg.message_id);
    console.log('Reply sent.');
  } catch (err) {
    console.error('Reply failed:', err);
  }
}

// --- SCHEDULING ---
// Daily professional report + Bogdanov roast: Mon-Fri at 10:00
cron.schedule('0 10 * * 1-5', dailyReport);

// Codebase improvement review: Tue & Thu at 11:00
cron.schedule('0 11 * * 2,4', codebaseReview);

// Sunday motivation: Sunday at 19:00
cron.schedule('0 19 * * 0', sundayMotivation);

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
} else if (arg === '--test') {
  sendMessage('<b>Bogdanov</b> на связи. Слежу за вашим кодом. Всегда слежу.')
    .then(() => { console.log('Test message sent.'); process.exit(0); });
} else {
  startPolling(handleReply);
}
