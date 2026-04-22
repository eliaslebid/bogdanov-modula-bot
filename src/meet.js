import { sendMessage } from './telegram.js';
import { meetAnnouncement, meetSummary } from './ai.js';
import * as meetBot from './meetBotClient.js';

const MEET_URL_RX = /https:\/\/meet\.google\.com\/[a-z0-9-]{3,}/i;

// Debounce: the same URL seen twice within this window only triggers once.
// Someone quote-replying the URL, or posting + someone else reposting, shouldn't
// make Bogdanov announce twice.
const DEDUPE_MS = 5 * 60 * 1000;
const seen = new Map(); // meetUrl -> lastSeenAt

function extractMeetUrl(text) {
  if (!text) return null;
  const m = text.match(MEET_URL_RX);
  return m ? m[0] : null;
}

async function announce(status, { fromName, meetUrl, reason }) {
  try {
    const text = await meetAnnouncement({ fromName, meetUrl, status, reason });
    await sendMessage(text);
  } catch (err) {
    console.error('[meet] announcement failed:', err.message);
  }
}

function clientErrorReason(err) {
  return err.code === 'NOT_CONFIGURED'
    ? 'MEET_BOT_URL не настроен'
    : `meet-bot не отвечает (${err.message})`;
}

async function triggerJoin({ fromName, meetUrl }) {
  let result;
  try {
    result = await meetBot.join(meetUrl);
  } catch (err) {
    const reason = clientErrorReason(err);
    console.error(`[meet] triggerJoin failed: ${reason}`);
    await announce('failed', { fromName, meetUrl, reason });
    return;
  }

  const { status, data } = result;
  console.log(`[meet] meet-bot /join → ${status}`, data);

  if (status === 202) {
    await announce('joining', { fromName, meetUrl });
    // Poll /status until this job finishes, then post the summary.
    pollUntilFinished({ meetUrl, startedAt: data.startedAt, fromName }).catch((err) =>
      console.error('[meet] poll crashed:', err.message)
    );
  } else if (status === 409) {
    await announce('busy', { fromName, meetUrl });
  } else {
    await announce('failed', { fromName, meetUrl, reason: data.error || `HTTP ${status}` });
  }
}

// Polls /status every 30s (up to ~4 hours) until the job we kicked off is done,
// then posts a summary if we got a transcript back.
async function pollUntilFinished({ meetUrl, startedAt, fromName }) {
  const POLL_MS = 30_000;
  const MAX_ATTEMPTS = 480; // 4 hours ceiling
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let status;
    try {
      status = await meetBot.getStatus();
    } catch (err) {
      console.warn(`[meet] poll ${i + 1}: status fetch failed — ${err.message}`);
      continue;
    }
    const job = status.job;
    // Guard: /status returns the *latest* job, not our specific one. Confirm
    // it's ours by matching startedAt before acting on a "done" state.
    if (!job || job.startedAt !== startedAt) {
      console.log(`[meet] poll ${i + 1}: current job is different (startedAt mismatch), stopping`);
      return;
    }
    if (!job.done) continue;

    console.log(`[meet] poll: job finished after ${i + 1} polls, reason=${job.result?.reason}`);
    const transcript = job.result?.transcript;
    if (!transcript || !transcript.text) {
      console.log('[meet] no transcript available — skipping summary post');
      return;
    }
    try {
      const summary = await meetSummary({
        transcript: transcript.text,
        durationSec: transcript.duration,
        language: transcript.language,
        fromName,
      });
      await sendMessage(summary);
    } catch (err) {
      console.error('[meet] summary/post failed:', err.message);
    }
    return;
  }
  console.warn('[meet] poll timed out after 4h');
}

// Returns the current Meet transcript as [{speaker, text}, ...], or null if no
// meeting is active / meet-bot is unreachable. Used by the reply handler to
// give Bogdanov in-call context for "what did we just discuss" questions.
export async function getCurrentTranscript() {
  let data;
  try {
    data = await meetBot.getTranscript();
  } catch (err) {
    console.warn('[meet] transcript fetch failed:', err.message);
    return null;
  }
  // Only return captions when a meeting is actively in progress. After it
  // ends the summary post handles recap — the reply handler shouldn't keep
  // injecting a stale call transcript.
  if (!data || data.done) return null;
  return data.captions || [];
}

// Call this from the onAnyMessage handler in index.js.
export function handleMessageForMeet(msg) {
  const meetUrl = extractMeetUrl(msg.text);
  if (!meetUrl) return;

  const now = Date.now();
  const last = seen.get(meetUrl);
  if (last && now - last < DEDUPE_MS) {
    console.log(`[meet] ignoring duplicate URL ${meetUrl} (seen ${Math.round((now - last) / 1000)}s ago)`);
    return;
  }
  seen.set(meetUrl, now);

  const fromName = msg.from?.first_name || 'кто-то';
  console.log(`[meet] detected Meet URL from ${fromName}: ${meetUrl}`);

  // Fire-and-forget — don't block message polling on the meet-bot roundtrip.
  triggerJoin({ fromName, meetUrl }).catch((err) =>
    console.error('[meet] triggerJoin crashed:', err)
  );
}
