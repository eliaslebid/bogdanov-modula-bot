// Captures Google Meet's live captions by scraping the DOM.
//
// 1) Click the CC toolbar button to turn captions on (with keyboard fallback).
// 2) Poll the captions region every 800ms and emit new/updated rows as
//    {time, speaker, text} entries. Speaker comes from Meet's own labeling,
//    so diarization is free.
//
// Selectors are best-effort — Meet reshuffles CSS often, so we use broad
// aria-label globs and keep multiple container-finding strategies.

export async function enableCaptions(page, { onEvent = () => {} } = {}) {
  // Toolbar isn't fully rendered the instant admission happens.
  await page.waitForTimeout(2000);

  const candidates = page.locator(
    'button[aria-label*="caption" i], button[aria-label*="subtitle" i], button[aria-label*="субтит" i], button[aria-label*="субтитр" i]'
  );
  const count = await candidates.count();
  onEvent({ type: 'captions-search', candidates: count });

  for (let i = 0; i < count; i++) {
    const btn = candidates.nth(i);
    if (!(await btn.isVisible().catch(() => false))) continue;
    const label = (await btn.getAttribute('aria-label').catch(() => '')) || '';
    // Skip if captions are already ON (button label says "turn off").
    if (/turn off|выключить|отключить|вимкнути/i.test(label)) {
      onEvent({ type: 'captions-already-on', label });
      return;
    }
    await btn.click().catch((e) => onEvent({ type: 'captions-click-failed', message: e.message, label }));
    onEvent({ type: 'captions-enabled', label });
    return;
  }

  // Fallback: Meet's keyboard shortcut for captions is the "c" key when the
  // call view has focus. Doesn't always work if focus is in a side panel,
  // but it's free to try.
  await page.keyboard.press('c').catch(() => {});
  onEvent({ type: 'captions-kbd-fallback' });
}

// Navigate Meet's Settings → Captions → Meeting language and pick `target`.
// Meet's caption ASR defaults to English; for Russian/Ukrainian speech it
// produces phonetic garbage unless the language is set explicitly.
// `target` can be 'multi' (tries Multi-language first, falls back to Russian),
// 'russian', 'ukrainian', 'english', etc. Selectors are guessed — function
// is fully best-effort and logs progress so we can see where it breaks.
//
// Debug: on any missing step or failed language pick, dumps a screenshot +
// full-page HTML to `meet-bot/debug/` so we can see what Meet actually
// rendered. Also enumerates every visible combobox (with its aria-label) and
// every role=option under the open dropdown — that's usually enough to spot
// the real selector/name Meet is using.
export async function setCaptionLanguage(page, { target = 'multi', onEvent = () => {}, debugDir } = {}) {
  const log = (ev) => onEvent({ ...ev, component: 'caption-lang' });

  // Lazy-import so we don't pay the cost unless called.
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const dir = debugDir || join(fileURLToPath(new URL('..', import.meta.url)), 'debug');
  await mkdir(dir, { recursive: true }).catch(() => {});
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  async function dump(label) {
    const base = join(dir, `caption-lang-${stamp}-${label}`);
    try {
      await page.screenshot({ path: `${base}.png`, fullPage: false });
      const html = await page.content();
      await writeFile(`${base}.html`, html);
      log({ type: 'debug-dump', label, png: `${base}.png`, html: `${base}.html` });
    } catch (e) {
      log({ type: 'debug-dump-failed', label, message: e.message });
    }
  }

  async function listComboboxes() {
    try {
      const items = await page.locator('[role="combobox"]').evaluateAll((els) =>
        els.map((el) => ({
          label: el.getAttribute('aria-label') || '',
          text: (el.innerText || '').slice(0, 80),
          visible: !!(el.offsetWidth || el.offsetHeight),
        }))
      );
      log({ type: 'debug-comboboxes', items });
    } catch {}
  }

  async function listOptions(note) {
    try {
      const items = await page.locator('[role="option"]').evaluateAll((els) =>
        els.map((el) => ({
          name: el.getAttribute('aria-label') || (el.innerText || '').trim().slice(0, 80),
          selected: el.getAttribute('aria-selected') === 'true',
        }))
      );
      log({ type: 'debug-options', note, count: items.length, items });
    } catch {}
  }

  log({ type: 'enter', target });
  await dump('00-start');

  try {
    // 1. Open "More options" (bottom-toolbar 3-dot).
    log({ type: 'step-begin', step: '1-more-options' });
    const moreBtn = page.getByRole('button', {
      name: /more options|more actions|ещё параметры|дополнительные|більше параметрів/i,
    });
    const moreCount = await moreBtn.count().catch(() => 0);
    log({ type: 'step-probe', step: '1-more-options', count: moreCount });
    if (!moreCount) {
      log({ type: 'step-missing', step: '1-more-options' });
      await dump('01-no-more-options');
      return;
    }
    await moreBtn.first().click({ timeout: 5_000 });
    log({ type: 'step-ok', step: '1-more-options-clicked' });
    await page.waitForTimeout(500);
    await dump('01-after-more-options');

    // 2. Click "Settings" in the popup menu.
    log({ type: 'step-begin', step: '2-settings' });
    const settingsItem = page.getByRole('menuitem', {
      name: /^settings$|^настройки$|^налаштування$/i,
    });
    const settingsCount = await settingsItem.count().catch(() => 0);
    log({ type: 'step-probe', step: '2-settings', count: settingsCount });
    if (!settingsCount) {
      log({ type: 'step-missing', step: '2-settings' });
      await dump('02-no-settings-item');
      await page.keyboard.press('Escape').catch(() => {});
      return;
    }
    await settingsItem.first().click({ timeout: 5_000 });
    log({ type: 'step-ok', step: '2-settings-clicked' });
    await page.waitForTimeout(1000);
    await dump('02-after-settings');

    // 3. Click the "Captions" tab in the Settings dialog.
    log({ type: 'step-begin', step: '3-captions-tab' });
    const captionsTab = page.getByRole('tab', {
      name: /captions|субтитры|субтитри/i,
    });
    const tabCount = await captionsTab.count().catch(() => 0);
    log({ type: 'step-probe', step: '3-captions-tab', count: tabCount });
    if (tabCount) {
      await captionsTab.first().click({ timeout: 3_000 }).catch(() => {});
      log({ type: 'step-ok', step: '3-captions-tab-clicked' });
    } else {
      log({ type: 'step-missing', step: '3-captions-tab', note: 'maybe already on captions pane' });
    }
    await page.waitForTimeout(500);
    await dump('03-after-captions-tab');

    // Before trying to find the dropdown, enumerate everything combobox-like
    // so we can see what labels Meet actually uses on this page.
    await listComboboxes();

    // 4. Open the Meeting language dropdown.
    log({ type: 'step-begin', step: '4-lang-dropdown' });
    const langDropdown = page.locator(
      '[role="combobox"][aria-label*="language" i], [role="combobox"][aria-label*="язык" i], [role="combobox"][aria-label*="мова" i], [aria-label*="meeting language" i]'
    );
    const dropdownCount = await langDropdown.count().catch(() => 0);
    log({ type: 'step-probe', step: '4-lang-dropdown', count: dropdownCount });
    if (!dropdownCount) {
      log({ type: 'step-missing', step: '4-lang-dropdown' });
      await dump('04-no-lang-dropdown');
      await page.keyboard.press('Escape').catch(() => {});
      return;
    }
    // Meet's Material Design combobox has a ripple layer (`jsname="GGAcbc"`)
    // as a sibling that intercepts pointer events — Playwright's normal click
    // retries forever waiting for a clear click target. `force: true` bypasses
    // that actionability check; the synthetic click still bubbles up and the
    // combobox opens. If that still fails, fall back to focus + Space.
    const dd = langDropdown.first();
    try {
      await dd.click({ force: true, timeout: 3_000 });
      log({ type: 'step-ok', step: '4-lang-dropdown-clicked', via: 'force-click' });
    } catch (clickErr) {
      log({ type: 'step-retry', step: '4-lang-dropdown', message: clickErr.message.slice(0, 200) });
      await dd.focus().catch(() => {});
      await page.keyboard.press('Space').catch(() => {});
      log({ type: 'step-ok', step: '4-lang-dropdown-clicked', via: 'keyboard' });
    }
    await page.waitForTimeout(500);

    // Dump the full option list — this is the single most useful debug
    // signal: we get to see exactly what Meet named the Multi-language option.
    await listOptions('dropdown-open');
    await dump('04-dropdown-open');

    // 5. Pick the target language. 'multi' tries Multi-language first, falls
    //    back to Russian if that option isn't offered (free-tier accounts).
    const tryOption = async (rx) => {
      const opt = page.getByRole('option', { name: rx });
      if (await opt.count().catch(() => 0)) {
        // Same MD ripple-intercept issue as the combobox — force it.
        await opt.first().click({ force: true, timeout: 3_000 });
        return true;
      }
      return false;
    };

    let picked = null;
    if (target === 'multi') {
      if (await tryOption(/multi[\s-]?language|multiple languages|несколько языков|мульти|кілька мов/i)) picked = 'multi';
      else if (await tryOption(/russian|русский/i)) picked = 'russian';
    } else if (target === 'russian' || target === 'ru') {
      if (await tryOption(/russian|русский/i)) picked = 'russian';
    } else if (target === 'ukrainian' || target === 'uk' || target === 'ua') {
      if (await tryOption(/ukrainian|украинский|українська/i)) picked = 'ukrainian';
    } else {
      if (await tryOption(new RegExp(target, 'i'))) picked = target;
    }

    if (picked) {
      log({ type: 'language-set', target, picked });
      await dump('05-picked');
    } else {
      log({ type: 'language-not-found', target });
      await dump('05-pick-failed');
    }

    // 6. Close the settings dialog.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(300);
    await page.keyboard.press('Escape').catch(() => {});
    log({ type: 'exit' });
  } catch (err) {
    log({ type: 'error', message: err.message });
    await dump('99-error');
    await page.keyboard.press('Escape').catch(() => {});
  }
}

export async function startCaptionBuffer(page, onEntry) {
  await page.exposeFunction('__captionEmit', (entry) => {
    try { onEntry(entry); } catch {}
  });

  // Forward any page-side console.log from the observer to our logs for debug.
  page.on('console', (msg) => {
    const txt = msg.text();
    if (txt.startsWith('[caption-scan]')) {
      onEntry({ debug: true, time: Date.now(), text: txt });
    }
  });

  await page.evaluate(() => {
    if (window.__captionObserverInstalled) return;
    window.__captionObserverInstalled = true;

    // Find the captions container. Try several strategies; log which one hit.
    function findContainer() {
      const byRole = document.querySelector('div[role="region"][aria-label*="aption" i]');
      if (byRole) return { el: byRole, via: 'role+caption' };
      const bySubtitle = document.querySelector('div[role="region"][aria-label*="ubtitle" i]');
      if (bySubtitle) return { el: bySubtitle, via: 'role+subtitle' };
      const bySubRu = document.querySelector('div[role="region"][aria-label*="убтит" i]');
      if (bySubRu) return { el: bySubRu, via: 'role+субтит' };
      // aria-live is the broadest fallback — Meet uses it for captions and
      // also for other live regions, so we pick the largest one by text.
      const lives = [...document.querySelectorAll('div[aria-live="polite"], div[aria-live="assertive"]')];
      const biggest = lives.map((el) => ({ el, len: (el.innerText || '').length })).sort((a, b) => b.len - a.len)[0];
      if (biggest && biggest.len > 0) return { el: biggest.el, via: 'aria-live-fallback' };
      return null;
    }

    // Extract {speaker, text} from a single caption row using a heuristic:
    // if the row has two distinct text chunks and the first is short (< 40 chars),
    // treat it as the speaker and the rest as the caption.
    function parseRow(row) {
      const texts = [];
      const walk = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const t = node.textContent.trim();
          if (t) texts.push(t);
        } else if (node.childNodes) {
          for (const child of node.childNodes) walk(child);
        }
      };
      walk(row);
      if (texts.length === 0) return null;
      if (texts.length === 1) return { speaker: null, text: texts[0] };
      const speaker = texts[0].length < 40 ? texts[0] : null;
      const text = speaker ? texts.slice(1).join(' ') : texts.join(' ');
      return { speaker, text };
    }

    // Two-layer dedup:
    // 1. rowState (WeakMap keyed by the row's DOM node) tracks the last text
    //    emitted for that row. When Meet extends a live caption ("Hello" →
    //    "Hello world"), we only emit the new suffix once.
    // 2. recentContent (rolling set of speaker||text for the last N emissions)
    //    suppresses duplicates when Meet *replaces* the row with a fresh node
    //    whose content matches something we just emitted. This is what the
    //    previous outerHTML-based key missed — re-rendered rows got fresh
    //    keys and re-emitted the same line forever.
    const rowState = new WeakMap();
    const recentContent = [];
    const recentSet = new Set();
    const RECENT_MAX = 200;

    function markEmitted(key) {
      if (recentSet.has(key)) return;
      recentSet.add(key);
      recentContent.push(key);
      if (recentContent.length > RECENT_MAX) {
        recentSet.delete(recentContent.shift());
      }
    }

    let lastDebug = 0;

    function scanOnce() {
      const found = findContainer();
      const now = Date.now();
      if (!found) {
        // Debug ping every 10s so we can tell the scan loop is running but
        // finding nothing — important for diagnosing selector breakage.
        if (now - lastDebug > 10_000) {
          console.log('[caption-scan] no container found');
          lastDebug = now;
        }
        return;
      }
      if (now - lastDebug > 10_000) {
        console.log(`[caption-scan] container via=${found.via} children=${found.el.children.length}`);
        lastDebug = now;
      }

      for (const row of found.el.children) {
        const parsed = parseRow(row);
        if (!parsed || !parsed.text) continue;
        const prevText = rowState.get(row);
        if (prevText === parsed.text) continue;
        rowState.set(row, parsed.text);
        const contentKey = `${parsed.speaker || ''}||${parsed.text}`;
        if (recentSet.has(contentKey)) continue;
        markEmitted(contentKey);
        try {
          window.__captionEmit({
            time: Date.now(),
            speaker: parsed.speaker,
            text: parsed.text,
          });
        } catch {}
      }
    }

    setInterval(scanOnce, 800);
  });
}
