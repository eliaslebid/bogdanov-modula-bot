import { config } from './config.js';
import { getLastUnansweredMention } from './history.js';

const API = `https://api.telegram.org/bot${config.telegramToken}`;

export async function sendMessage(text, replyToMessageId) {
  const body = {
    chat_id: config.chatId,
    text,
    parse_mode: 'HTML',
  };
  if (replyToMessageId) {
    body.reply_to_message_id = replyToMessageId;
  }
  const res = await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error('Telegram send failed:', data);
    // Retry without reply-to if original message not found
    if (replyToMessageId && data.description?.includes('not found')) {
      console.log('Retrying without reply_to_message_id...');
      return sendMessage(text);
    }
    // Retry without HTML if parse error
    if (data.description?.includes('parse')) {
      const retryBody = { chat_id: config.chatId, text };
      if (replyToMessageId) retryBody.reply_to_message_id = replyToMessageId;
      const retry = await fetch(`${API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(retryBody),
      });
      return retry.json();
    }
  }
  return data;
}

export async function getMe() {
  const res = await fetch(`${API}/getMe`);
  return (await res.json()).result;
}

// Action-trigger phrases that should route to the reply handler even when the
// user didn't explicitly name Bogdanov. Kept narrow and verb-anchored so
// casual mentions of "задачи" or "встреча" don't false-positive.
const ACTION_TRIGGERS = [
  /(сделай|создай|проставь|распиши|нарежь|добавь)\b[\s\S]{0,40}?(задач|тикет)/i,
  /(тикет|задач)[\s\S]{0,40}?(по|с|со|из|после)[\s\S]{0,20}?(встреч|митинг|созвон|груминг)/i,
  /(управляй|разбери|почисти|обнови|проверь)\b[\s\S]{0,20}?(задач|тикет|issues|борд)/i,
];

function isMentionOfBot(text, botId, replyToMessage) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const isReplyToBot = replyToMessage && replyToMessage.from?.id === botId;
  const mentionsBot = lower.includes('@bogdanov_modula_bot')
    || lower.includes('богданов')
    || lower.includes('bogdanov')
    || lower.includes('богдан')
    || lower.includes('бодя');
  const actionTrigger = ACTION_TRIGGERS.some(rx => rx.test(text));
  return isReplyToBot || mentionsBot || actionTrigger;
}

export async function startPolling(onMessage, onAnyMessage) {
  const me = await getMe();
  const botId = me.id;
  let offset = 0;

  console.log(`Polling as @${me.username} (id: ${botId})`);

  // --- Catch-up: process any pending Telegram updates first ---
  try {
    const res = await fetch(`${API}/getUpdates?offset=0&timeout=5`);
    const data = await res.json();
    if (data.ok && data.result.length > 0) {
      console.log(`Catch-up: ${data.result.length} pending Telegram updates`);
      for (const update of data.result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg) continue;
        if (onAnyMessage) onAnyMessage(msg);
      }
    }
  } catch (err) {
    console.error('Catch-up fetch failed:', err.message);
  }

  // --- Catch-up: check persisted history for unanswered mentions ---
  try {
    const unanswered = getLastUnansweredMention();
    if (unanswered) {
      console.log(`Catch-up: found unanswered mention from ${unanswered.name}: "${unanswered.text}"`);
      // Build a minimal msg object for the reply handler
      const fakeMsg = {
        message_id: unanswered.messageId,
        from: { first_name: unanswered.name, is_bot: false },
        text: unanswered.text,
        reply_to_message: unanswered.replyTo ? { message_id: unanswered.replyTo } : undefined,
      };
      await onMessage(fakeMsg);
    } else {
      console.log('Catch-up: no unanswered mentions in history');
    }
  } catch (err) {
    console.error('Catch-up reply failed:', err.message);
  }

  // --- Normal polling loop ---
  console.log('Entering polling loop...');
  while (true) {
    try {
      const res = await fetch(`${API}/getUpdates?offset=${offset}&timeout=30`);
      const data = await res.json();
      if (!data.ok) {
        console.error('Polling error:', data);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      if (data.result.length > 0) {
        console.log(`Received ${data.result.length} updates`);
      }
      for (const update of data.result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg) continue;
        if (!msg.text) {
          if (onAnyMessage) onAnyMessage(msg);
          continue;
        }
        const mentioned = isMentionOfBot(msg.text, botId, msg.reply_to_message);
        console.log(`Message from ${msg.from?.first_name}: "${msg.text.slice(0, 50)}" mention=${mentioned}`);
        if (onAnyMessage) onAnyMessage(msg, mentioned);
        if (mentioned) {
          await onMessage(msg);
        }
      }
    } catch (err) {
      console.error('Polling exception:', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}
