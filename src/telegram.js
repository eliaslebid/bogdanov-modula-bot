import { config } from './config.js';

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

export async function startPolling(onMessage) {
  const me = await getMe();
  const botId = me.id;
  let offset = 0;

  console.log(`Polling as @${me.username} (id: ${botId})`);

  while (true) {
    try {
      const res = await fetch(`${API}/getUpdates?offset=${offset}&timeout=30`);
      const data = await res.json();
      if (!data.ok) {
        console.error('Polling error:', data);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      for (const update of data.result) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg || !msg.text) continue;
        const isReplyToBot = msg.reply_to_message && msg.reply_to_message.from?.id === botId;
        const mentionsBot = msg.text.toLowerCase().includes('@bogdanov_modula_bot')
          || msg.text.toLowerCase().includes('богданов')
          || msg.text.toLowerCase().includes('bogdanov');
        if (isReplyToBot || mentionsBot) {
          await onMessage(msg);
        }
      }
    } catch (err) {
      console.error('Polling exception:', err.message);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}
