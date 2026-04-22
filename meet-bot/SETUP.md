# meet-bot setup (spare Mac)

POC: launch Chrome → join a Google Meet → record the meeting's audio to a WAV file.
No STT, no Telegram integration yet. Just prove the capture pipeline works.

## 1. System deps

```bash
brew install --cask google-chrome
brew install --cask blackhole-2ch
brew install ffmpeg node
```

`google-chrome` (not Chromium) is required — Meet depends on proprietary codecs that
Playwright's bundled Chromium doesn't ship. The script launches it via `channel: 'chrome'`.

## 2. Audio routing

Meet plays remote-participant audio through whatever output device Chrome is using.
We route that into BlackHole so ffmpeg can record it, while still letting you hear
the meeting on speakers.

1. Open **Audio MIDI Setup** (`/Applications/Utilities`).
2. `+` → **Create Multi-Output Device**. Tick **BlackHole 2ch** and **your speakers/headphones**.
   Drag BlackHole to be the master device. Name it "BlackHole + Speakers".
3. Right-click it → **Use This Device For Sound Output** (or set it in System Settings → Sound).
4. Verify ffmpeg sees BlackHole:

   ```bash
   ffmpeg -f avfoundation -list_devices true -i "" 2>&1 | grep -i blackhole
   ```

   You should see something like `[1] BlackHole 2ch`. If the name has a leading index,
   either update `AUDIO_INPUT` in `.env` to `:1` or keep `:BlackHole 2ch` — both work on
   recent ffmpeg.

## 3. Google account

Create a dedicated Google account for the bot (e.g. `bogdanov.modula@gmail.com`).
Before using it for Meet:

- Verify with a real phone number.
- Set a name + profile photo.
- Send one email, watch a YouTube video, log in from a phone. Accounts that *only* join
  Meets get flagged fast.

If you have a Google Workspace, add this account as a member of your org — meeting
hosts in the same org can skip the "Ask to join" admission step permanently.

## 4. Install & first run

```bash
cd meet-bot
cp .env.example .env
npm install
npx playwright install chromium   # only needed if `channel: 'chrome'` fails
```

**First run — manual login.** Start the script with any Meet URL. Chrome will open
on the accounts.google.com page. Log in to the bot's account in that window. The
profile is saved to `chrome-profile/` and reused on every subsequent run.

```bash
node src/join.js https://meet.google.com/xxx-yyyy-zzz
```

Once logged in, kill the script (Ctrl+C) and re-run — this time it should go straight
to the Meet pre-join screen.

## 5. Running the POC

```bash
node src/join.js https://meet.google.com/xxx-yyyy-zzz
```

What should happen:

1. Chrome opens, loads the Meet URL.
2. Mic + cam are toggled off on the pre-join screen.
3. Script clicks **Ask to join** (or **Join now** if you're in the host's org).
4. Someone on the host side clicks **Admit**.
5. Once the leave-call button appears (we're in the meeting), ffmpeg starts recording.
6. When the meeting ends (leave-call button disappears), the script stops ffmpeg
   cleanly and exits. The WAV lives in `recordings/<timestamp>.wav`.

Ctrl+C also triggers a clean shutdown.

## 6. Verifying the recording

```bash
ls -lh recordings/
afplay recordings/<timestamp>.wav
```

If the file is silent: Chrome's output is not routed through BlackHole. Re-check
step 2 — System Settings → Sound → Output should be "BlackHole + Speakers" while
the bot is in the call.

## Known rough edges (to fix in later phases)

- Join-button selectors rely on EN/RU text. If your Meet UI is in another locale,
  update the regexes in `src/join.js`.
- No pre-meeting "who are you" prompt handling — the script assumes a signed-in
  account, not a guest join.
- No auto meeting-link detection in Telegram yet. For now you pass the URL on CLI.
- One meeting at a time per machine (BlackHole is a single global sink).
