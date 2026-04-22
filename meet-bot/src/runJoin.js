import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { transcribe } from './transcribe.js';
import { enableCaptions, startCaptionBuffer } from './captions.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

const DISPLAY_NAME = process.env.BOT_DISPLAY_NAME || 'Bogdanov';
const AUDIO_INPUT = process.env.AUDIO_INPUT || ':BlackHole 2ch';
const PROFILE_DIR = join(ROOT, 'chrome-profile');
const RECORDINGS_DIR = join(ROOT, 'recordings');

export function isValidMeetUrl(url) {
  return typeof url === 'string' && /^https:\/\/meet\.google\.com\/[a-z0-9-]+/i.test(url);
}

// Runs the full join → record → leave flow. Resolves when the meeting ends
// (or the caller calls the returned `leave()`). Throws synchronously on
// setup errors (invalid URL, Chrome launch failure, not signed in).
// onEvent({type, ...}) is optional — used by the server to stream progress.
export async function runJoin(meetUrl, { onEvent = () => {} } = {}) {
  if (!isValidMeetUrl(meetUrl)) {
    throw new Error(`invalid meet url: ${meetUrl}`);
  }

  await mkdir(RECORDINGS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const recordingPath = join(RECORDINGS_DIR, `${stamp}.wav`);

  let ffmpeg = null;
  let browser = null;
  let shuttingDown = false;
  let finishing = false;
  let endedDeferred;
  const endedPromise = new Promise((r) => { endedDeferred = r; });

  // Rolling buffer of caption entries streamed from the Meet page while the
  // call is live. Server.js holds a reference and serves this from /transcript.
  const captions = [];

  async function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    onEvent({ type: 'shutting-down', reason });

    if (ffmpeg && ffmpeg.exitCode === null) {
      try { ffmpeg.stdin.write('q'); } catch {}
      await new Promise((r) => {
        const t = setTimeout(() => { try { ffmpeg.kill('SIGTERM'); } catch {} r(); }, 3000);
        ffmpeg.on('exit', () => { clearTimeout(t); r(); });
      });
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  // Every terminal state funnels through here. Runs shutdown, then (best-effort)
  // transcribes the WAV via Groq, then resolves the ended promise.
  async function finish(reason, extra = {}) {
    if (finishing) return;
    finishing = true;
    await shutdown(reason);

    const result = {
      recordingPath,
      startedAt,
      endedAt: Date.now(),
      reason,
      captions: [...captions],
      ...extra,
    };

    try {
      const st = await stat(recordingPath).catch(() => null);
      if (st && st.size > 50_000 && process.env.GROQ_API_KEY) {
        onEvent({ type: 'transcribing', wavBytes: st.size });
        const t0 = Date.now();
        const tr = await transcribe(recordingPath, { apiKey: process.env.GROQ_API_KEY });
        result.transcript = {
          text: tr.text?.trim() || '',
          language: tr.language,
          duration: tr.duration,
          took: Date.now() - t0,
        };
        onEvent({ type: 'transcribed', chars: result.transcript.text.length, language: tr.language, took: result.transcript.took });
      } else if (!process.env.GROQ_API_KEY) {
        onEvent({ type: 'transcribe-skip', reason: 'GROQ_API_KEY not set' });
      } else {
        onEvent({ type: 'transcribe-skip', reason: 'recording too short', size: st?.size });
      }
    } catch (err) {
      onEvent({ type: 'transcribe-error', message: err.message });
      result.transcriptError = err.message;
    }

    endedDeferred(result);
  }

  // Clean up stale Chrome singleton locks from a previous non-graceful exit.
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    await rm(join(PROFILE_DIR, name), { force: true }).catch(() => {});
  }

  onEvent({ type: 'launching' });
  browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1280, height: 800 },
    permissions: ['microphone', 'camera'],
    args: [
      '--use-fake-ui-for-media-stream',
      '--disable-blink-features=AutomationControlled',
      // Suppress "Chrome didn't shut down correctly" bubble after we killed
      // the previous run non-gracefully. Without this, the bubble blocks the
      // top-right area and can intercept clicks.
      '--hide-crash-restore-bubble',
    ],
  });

  const startedAt = Date.now();

  (async () => {
    try {
      const page = browser.pages()[0] || (await browser.newPage());
      onEvent({ type: 'navigating', meetUrl });
      await page.goto(meetUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);

      if (/accounts\.google\.com/.test(page.url())) {
        throw new Error('chrome is not signed into a Google account — run CLI join.js once to log in');
      }

      const nameField = page.locator('input[aria-label*="name" i], input[placeholder*="name" i]');
      if (await nameField.count()) {
        await nameField.first().fill(DISPLAY_NAME).catch(() => {});
      }

      // Turn mic + cam OFF before joining. Meet's button labels vary by locale
      // and toggle state — only click when the button reports the device is ON.
      async function ensureOff(deviceRx) {
        const onLabelRx = /(turn off|отключить|выключить)/i;
        const btns = await page.getByRole('button', { name: deviceRx }).all();
        for (const btn of btns) {
          const label = (await btn.getAttribute('aria-label')) || '';
          if (onLabelRx.test(label)) {
            await btn.click().catch(() => {});
            onEvent({ type: 'toggled-off', label });
          }
        }
      }
      await ensureOff(/microphone|микрофон/i);
      await ensureOff(/camera|камер/i);

      // When the *same Google account* is still in the call from a previous,
      // non-gracefully-killed Chrome session, Meet shows "Switch here" (EN)
      // / "Переключить" (RU) instead of the normal Join button. Click it
      // first — it transfers the live call to this new tab without requiring
      // a re-admit by the host.
      const switchRx = /switch here|use here|переключить|перенести/i;
      const switchBtn = page.getByRole('button', { name: switchRx });
      if (await switchBtn.count().catch(() => 0)) {
        await switchBtn.first().click({ timeout: 5_000 }).catch(() => {});
        onEvent({ type: 'switched-here' });
        await page.waitForTimeout(2000);
      }

      const joinRx = /ask to join|join now|попросить разрешения|присоединиться/i;
      const joinBtn = page.getByRole('button', { name: joinRx });
      if (await joinBtn.count().catch(() => 0)) {
        await joinBtn
          .first()
          .click({ timeout: 10_000 })
          .catch((e) => onEvent({ type: 'warn', message: `join click failed: ${e.message}` }));
        onEvent({ type: 'requested' });
      } else {
        // If "Switch here" already put us into the call, there's no Join
        // button to click — that's fine.
        onEvent({ type: 'requested', viaSwitch: true });
      }

      const leaveBtn = page.getByRole('button', {
        name: /leave call|покинуть вызов|выйти из звонка/i,
      });
      await leaveBtn.waitFor({ state: 'visible', timeout: 5 * 60_000 });
      onEvent({ type: 'admitted', recordingPath });

      // Enable Meet's built-in captions and start streaming them into the
      // `captions` array. The array is mutated in-place; server.js reads from
      // it live via the ref returned below.
      try {
        await enableCaptions(page, { onEvent });
        await startCaptionBuffer(page, (entry) => {
          if (entry.debug) {
            onEvent({ type: 'caption-debug', text: entry.text });
            return;
          }
          captions.push(entry);
          onEvent({ type: 'caption', speaker: entry.speaker, text: entry.text.slice(0, 120) });
        });
      } catch (err) {
        onEvent({ type: 'captions-setup-failed', message: err.message });
      }

      ffmpeg = spawn(
        'ffmpeg',
        [
          '-f', 'avfoundation',
          '-i', AUDIO_INPUT,
          '-ac', '1',
          '-ar', '16000',
          '-c:a', 'pcm_s16le',
          '-y',
          recordingPath,
        ],
        { stdio: ['pipe', 'inherit', 'inherit'] }
      );
      ffmpeg.on('exit', (code) => onEvent({ type: 'ffmpeg-exit', code }));

      // Detection loop: two signals, either triggers leave.
      // (1) Our own leave button disappears → Meet ejected us (host ended / kicked).
      // (2) Bot is the only participant for 30s → everyone else left, bail out.
      let aloneSince = null;
      const ALONE_THRESHOLD_MS = 30_000;

      async function participantCount() {
        // Meet's "People" button aria-label contains the count in parentheses,
        // e.g. "Show everyone (2)" / "Показать всех (2)".
        const btn = page.locator('button[aria-label*="everyone" i], button[aria-label*="people" i], button[aria-label*="участн" i]');
        const label = await btn.first().getAttribute('aria-label').catch(() => null);
        if (!label) return null;
        const m = label.match(/\((\d+)\)/);
        return m ? Number(m[1]) : null;
      }

      const poll = setInterval(async () => {
        const stillIn = await leaveBtn.isVisible().catch(() => false);
        if (!stillIn) {
          clearInterval(poll);
          await finish('meeting-ended');
          return;
        }
        const n = await participantCount();
        if (n === 1) {
          if (aloneSince === null) {
            aloneSince = Date.now();
            onEvent({ type: 'alone', since: aloneSince });
          } else if (Date.now() - aloneSince > ALONE_THRESHOLD_MS) {
            onEvent({ type: 'leaving-solo' });
            clearInterval(poll);
            await finish('left-alone');
          }
        } else if (n !== null) {
          aloneSince = null;
        }
      }, 5000);
    } catch (err) {
      onEvent({ type: 'error', message: err.message });
      await finish('error', { error: err.message });
    }
  })();

  return {
    recordingPath,
    startedAt,
    ended: endedPromise,
    leave: () => finish('leave-requested'),
    // Live caption buffer — mutated in place as Meet emits new captions.
    captions,
  };
}
