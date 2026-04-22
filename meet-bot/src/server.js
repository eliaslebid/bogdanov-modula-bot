import http from 'node:http';
import { runJoin, isValidMeetUrl } from './runJoin.js';

const PORT = Number(process.env.PORT || 7777);

let job = null;
const recentEvents = [];

function pushEvent(e) {
  const stamped = { ...e, at: Date.now() };
  recentEvents.push(stamped);
  while (recentEvents.length > 50) recentEvents.shift();
  console.log('[meet-bot]', JSON.stringify(stamped));
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  try { return JSON.parse(body); } catch { return {}; }
}

function respond(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function handleJoin(req, res) {
  const { meetUrl } = await readJson(req);
  if (!isValidMeetUrl(meetUrl)) {
    return respond(res, 400, { error: 'invalid or missing meetUrl' });
  }
  if (job && !job.done) {
    return respond(res, 409, {
      error: 'already in a meeting',
      current: { meetUrl: job.meetUrl, startedAt: job.startedAt },
    });
  }

  const startedAt = Date.now();
  job = { meetUrl, startedAt, done: false, result: null };
  respond(res, 202, { status: 'joining', meetUrl, startedAt });

  try {
    const active = await runJoin(meetUrl, { onEvent: pushEvent });
    job.recordingPath = active.recordingPath;
    job.leave = active.leave;
    job.liveCaptions = active.captions; // mutated in place by runJoin
    const result = await active.ended;
    job.done = true;
    job.result = result;
    pushEvent({ type: 'finished', reason: result.reason, captionCount: result.captions?.length || 0 });
  } catch (err) {
    job.done = true;
    job.result = { error: err.message };
    pushEvent({ type: 'setup-error', message: err.message });
  }
}

function handleTranscript(req, res) {
  if (!job) return respond(res, 404, { error: 'no meeting' });
  // While the call is live, serve the in-memory buffer; after it's finished,
  // serve the snapshot stored on the result.
  const captions = job.done ? (job.result?.captions || []) : (job.liveCaptions || []);
  respond(res, 200, {
    meetUrl: job.meetUrl,
    startedAt: job.startedAt,
    done: job.done,
    captions,
  });
}

async function handleLeave(req, res) {
  if (!job || job.done || !job.leave) {
    return respond(res, 404, { error: 'no active meeting' });
  }
  await job.leave();
  respond(res, 200, { status: 'leaving' });
}

function handleStatus(req, res) {
  respond(res, 200, {
    busy: !!(job && !job.done),
    job: job && {
      meetUrl: job.meetUrl,
      startedAt: job.startedAt,
      done: job.done,
      recordingPath: job.recordingPath,
      result: job.result,
    },
    recentEvents: recentEvents.slice(-15),
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/status' && req.method === 'GET') return handleStatus(req, res);
    if (req.url === '/transcript' && req.method === 'GET') return handleTranscript(req, res);
    if (req.url === '/join' && req.method === 'POST') return handleJoin(req, res);
    if (req.url === '/leave' && req.method === 'POST') return handleLeave(req, res);
    respond(res, 404, { error: 'not found' });
  } catch (err) {
    console.error('[meet-bot] request error:', err);
    respond(res, 500, { error: err.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[meet-bot] server listening on 0.0.0.0:${PORT}`);
});
