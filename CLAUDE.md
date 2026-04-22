# Bogdanov Modula Bot

## Project Overview
Telegram bot "Bogdanov" (@bogdanov_modula_bot) for team "Modula" group chat.
Monitors GitHub repo `Yneth/flatmatch` (private apartment matching platform).
Bot acts as a foul-mouthed Russian project manager — roasts, reports, motivates.

## Team
| Name    | GitHub      | Telegram       | Role    |
|---------|-------------|----------------|---------|
| Antony  | Yneth       | (no @username) | Lead dev |
| Elias   | eliaslebed  | @winfromloss   | Dev     |
| Gerbert | gerbertpr0  | @gerbertpr0    | Manager |

## Architecture
```
src/
  index.js    — entry point, cron scheduling, polling, reply handler, proactive jump-in
  ai.js       — all Claude API prompts (reports, roasts, reviews, replies, proactive comments)
  github.js   — GitHub API (commits, PRs, issues, repo tree, team mapping, telegramId capture)
  telegram.js — Telegram Bot API (sendMessage, polling with onMessage + onAnyMessage)
  history.js  — in-memory chat history buffer (last 50 messages)
  context.js  — fetches README.md + CLAUDE.md from flatmatch repo, caches, refreshes every 6h
.env          — all secrets (TELEGRAM_BOT_TOKEN, GITHUB_TOKEN, ANTHROPIC_API_KEY, etc.)
.telegram-ids.json — auto-captured Telegram user IDs (persisted across restarts)
```

## Schedule
- Mon-Fri 10:00 — Daily professional report + Bogdanov roast (2 separate messages)
- Tue & Thu 11:00 — Codebase review with improvement suggestions
- Sunday 19:00 — Weekly motivational message

## Bot Behavior
- Responds when someone replies to its message or mentions bogdanov/@bogdanov_modula_bot
- Proactively jumps into conversation every 5 human messages if topic is project-relevant
- All messages in Russian with мат (profanity) — consented by all group members
- Professional reports use clean business language (separate from Bogdanov's roasts)
- Refusal filter catches Claude content policy blocks and replaces with in-character fallback
- Never hallucinates tools/services — grounded in real GitHub data (issues, commits, repo docs)
- Tags: @username for Elias/Gerbert, tg://user link for Antony (auto-captured ID)
- Tracks 3-day dev inactivity (managers excluded), references their open GitHub issues

## Secrets Location
All in `.env`:
- TELEGRAM_BOT_TOKEN
- TELEGRAM_CHAT_ID (-1003639557657)
- GITHUB_TOKEN
- GITHUB_REPO (Yneth/flatmatch)
- ANTHROPIC_API_KEY

## Running
```bash
npx pm2 start src/index.js --name bogdanov   # start persistent
npx pm2 logs bogdanov                         # view logs
npx pm2 restart bogdanov                      # restart
npx pm2 delete bogdanov                       # stop and remove

# Manual triggers (SENDS to group!)
node src/index.js --daily
node src/index.js --review
node src/index.js --motivation
node src/index.js --test
```

## Known Issues
- 409 Polling Conflict: if multiple instances run, Telegram rejects polling. Fix: `npx pm2 delete bogdanov`, wait 30s, start fresh.
- Antony has no Telegram @username — bot auto-captures his user ID when he messages, stored in `.telegram-ids.json`

## Important Rules
- NEVER start the bot without user permission — they test manually first
- NEVER send test messages to the group without user asking
- Bot language: Russian with мат
- Professional reports are SEPARATE from Bogdanov's roasts
- Only reference real project data (GitHub Issues, not Jira/Trello/etc.)
