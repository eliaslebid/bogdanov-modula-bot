import { runJoin, isValidMeetUrl } from './runJoin.js';

const meetUrl = process.argv[2];
if (!isValidMeetUrl(meetUrl)) {
  console.error('usage: node src/join.js https://meet.google.com/xxx-yyyy-zzz');
  process.exit(1);
}

let job;
try {
  job = await runJoin(meetUrl, {
    onEvent: (e) => console.log('[meet-bot]', JSON.stringify(e)),
  });
} catch (err) {
  console.error('[meet-bot] setup failed:', err.message);
  process.exit(1);
}

process.on('SIGINT', async () => {
  console.log('[meet-bot] SIGINT — leaving…');
  await job.leave();
});
process.on('SIGTERM', async () => {
  console.log('[meet-bot] SIGTERM — leaving…');
  await job.leave();
});

const result = await job.ended;
console.log('[meet-bot] done:', JSON.stringify(result));
process.exit(0);
