// Thin HTTP client for the meet-bot service. Owns base URL + timeouts +
// JSON parsing; knows nothing about Telegram, announcements, or Claude.
// Callers handle errors and do their own orchestration.

import { config } from './config.js';

function requireUrl() {
  if (!config.meetBotUrl) {
    const err = new Error('MEET_BOT_URL not configured');
    err.code = 'NOT_CONFIGURED';
    throw err;
  }
  return config.meetBotUrl;
}

// Kicks off a meeting join. Returns {status, data} — caller decides what
// HTTP status codes mean (e.g. 202 accepted, 409 already busy).
export async function join(meetUrl) {
  const res = await fetch(`${requireUrl()}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ meetUrl }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

export async function getStatus() {
  const res = await fetch(`${requireUrl()}/status`, {
    signal: AbortSignal.timeout(10_000),
  });
  return await res.json();
}

// Returns the raw /transcript payload, or null on HTTP error. The `done`
// flag + the `captions` array are caller's concern.
export async function getTranscript() {
  const res = await fetch(`${requireUrl()}/transcript`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) return null;
  return await res.json();
}
