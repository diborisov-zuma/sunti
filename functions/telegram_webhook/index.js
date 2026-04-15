const { BigQuery } = require('@google-cloud/bigquery');

const bigquery        = new BigQuery();
const PROJECT         = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET         = 'sunti';
const TELEGRAM_TOKEN  = '8766299522:AAGfJ9mdsOWv2f_HgNsRH0sjC3XweStQWRQ';
const TELEGRAM_API    = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function sendTelegram(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
}

async function linkUser(chatId, email, name) {
  const table = `\`${PROJECT}.${DATASET}.users\``;
  const [rows] = await bigquery.query({
    query: `SELECT id, email, name FROM ${table} WHERE email = @email`,
    params: { email },
  });

  if (!rows.length) {
    await sendTelegram(chatId,
      `❌ Пользователь с email <b>${email}</b> не найден в системе.\n\nСначала войди в приложение Sunti через Google.`
    );
    return;
  }

  await bigquery.query({
    query: `UPDATE ${table} SET telegram_chat_id = @chat_id WHERE email = @email`,
    params: { chat_id: String(chatId), email },
  });

  await sendTelegram(chatId,
    `✅ <b>Telegram успешно привязан!</b>\n\nТеперь ты будешь получать уведомления из Sunti.\n\nАккаунт: ${rows[0].name || email}`
  );
}

exports.telegram_webhook = async (req, res) => {
  // Telegram отправляет POST запросы
  if (req.method !== 'POST') { res.status(200).send('ok'); return; }

  try {
    const update = req.body;
    const message = update.message;
    if (!message) { res.status(200).send('ok'); return; }

    const chatId   = message.chat.id;
    const text     = message.text || '';
    const username = message.from.username || '';
    const name     = [message.from.first_name, message.from.last_name].filter(Boolean).join(' ');

    // Обрабатываем команду /start с email
    // Формат: /start di.borisov@gmail.com
    if (text.startsWith('/start')) {
      const parts = text.split(' ');
      const rawEmail = parts[1] ? parts[1].trim() : null;
      // Декодируем email обратно
      const email = rawEmail
        ? rawEmail
            .replace(/_dot_/g, '.')
            .replace(/_at_/g, '@')
            .replace(/_plus_/g, '+')
        : null;

      if (!email || !email.includes('@')) {
        await sendTelegram(chatId,
          `👋 Привет, ${name}!\n\nЧтобы привязать Telegram к приложению Sunti, перейди в приложение и нажми кнопку <b>Link Telegram</b>.`
        );
        res.status(200).send('ok');
        return;
      }

      await linkUser(chatId, email, name);
    } else {
      // Любое другое сообщение — подсказываем что делать
      await sendTelegram(chatId,
        `👋 Привет!\n\nЧтобы привязать Telegram к Sunti, перейди в приложение и нажми кнопку <b>Link Telegram</b>.`
      );
    }

    res.status(200).send('ok');
  } catch(e) {
    console.error(e);
    res.status(200).send('ok'); // Telegram требует 200 даже при ошибках
  }
};
