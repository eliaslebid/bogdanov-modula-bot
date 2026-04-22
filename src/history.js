// Conversation history buffer — persisted to disk so we survive restarts
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const MAX_MESSAGES = 50;
const HISTORY_FILE = resolve(import.meta.dirname, '../.chat-history.json');

let messages = loadFromDisk();

function loadFromDisk() {
  try {
    return JSON.parse(readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveToDisk() {
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify(messages));
  } catch (err) {
    console.error('Failed to save chat history:', err.message);
  }
}

export function addMessage(msg) {
  const name = msg.from?.first_name || msg.from?.username || 'Unknown';
  const isBot = msg.from?.is_bot || false;
  const text = msg.text || '';
  if (!text) return;

  // Deduplicate by messageId
  if (messages.some(m => m.messageId === msg.message_id)) return;

  messages.push({
    name: isBot ? 'Bogdanov' : name,
    text,
    date: new Date(msg.date * 1000).toISOString(),
    messageId: msg.message_id,
    replyTo: msg.reply_to_message?.message_id || null,
    isBot,
  });

  if (messages.length > MAX_MESSAGES) {
    messages.splice(0, messages.length - MAX_MESSAGES);
  }
  saveToDisk();
}

export function getRecentHistory(limit = 20) {
  return messages.slice(-limit);
}

export function formatHistory(limit = 20) {
  const recent = getRecentHistory(limit);
  if (recent.length === 0) return '(no recent messages)';
  return recent.map(m => `${m.name}: ${m.text}`).join('\n');
}

// Get only messages since the bot last spoke
export function getMessagesSinceBotSpoke() {
  const result = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].isBot) break;
    result.unshift(messages[i]);
  }
  return result;
}

export function formatHistorySinceBotSpoke() {
  const recent = getMessagesSinceBotSpoke();
  if (recent.length === 0) return null;
  return recent.map(m => `${m.name}: ${m.text}`).join('\n');
}

export function getLastUnansweredMention(botUsername = 'bogdanov_modula_bot') {
  const triggers = ['@' + botUsername, 'богданов', 'bogdanov', 'богдан', 'бодя'];
  // Walk backwards: find the last mention that has no bot reply after it
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.isBot) return null; // bot already spoke after any potential mention
    const lower = (m.text || '').toLowerCase();
    if (triggers.some(t => lower.includes(t))) {
      return m;
    }
  }
  return null;
}
