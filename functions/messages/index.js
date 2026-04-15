const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery       = new BigQuery();
const PROJECT        = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET        = 'sunti';
const TELEGRAM_TOKEN = '8766299522:AAGfJ9mdsOWv2f_HgNsRH0sjC3XweStQWRQ';
const TELEGRAM_API   = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const APP_URL        = 'https://project-9718e7d4-4cd7-4f52-8d6.web.app';

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function verifyToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.split(' ')[1];
  const r = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
  if (!r.ok) return null;
  const info = await r.json();
  return info.email || null;
}

async function sendTelegram(chatId, text) {
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch(e) {
    console.error('Telegram error:', e.message);
  }
}

async function getUserByEmail(email) {
  const t = `\`${PROJECT}.${DATASET}.users\``;
  const [rows] = await bigquery.query({
    query: `SELECT email, name, telegram_chat_id, telegram_username FROM ${t} WHERE email = @email`,
    params: { email },
  });
  return rows[0] || null;
}

async function getUsersByEmails(emails) {
  if (!emails.length) return [];
  const t = `\`${PROJECT}.${DATASET}.users\``;
  const placeholders = emails.map((_, i) => `@e${i}`).join(', ');
  const params = {};
  emails.forEach((e, i) => { params[`e${i}`] = e; });
  const [rows] = await bigquery.query({
    query: `SELECT email, name, telegram_chat_id, telegram_username FROM ${t} WHERE email IN (${placeholders})`,
    params,
  });
  return rows;
}

async function notifyUser(user, text) {
  // Сначала пробуем через chat_id (прямое сообщение)
  if (user.telegram_chat_id && user.telegram_chat_id !== '') {
    await sendTelegram(user.telegram_chat_id, text);
  }
  // Если нет chat_id но есть username — логируем (нельзя отправить без chat_id)
}

exports.messages = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const msgTable = `\`${PROJECT}.${DATASET}.messages\``;
  const recTable = `\`${PROJECT}.${DATASET}.message_recipients\``;

  try {

    // GET /messages/unread — непрочитанные для текущего пользователя (для шапки)
    if (req.method === 'GET' && req.url.includes('unread')) {
      const documentType = req.query.document_type;
      const documentIds  = req.query.document_ids ? req.query.document_ids.split(',') : null;

      // Batch запрос — для конкретного списка документов
      if (documentIds && documentIds.length > 0) {
        const placeholders = documentIds.map((_, i) => `@did${i}`).join(', ');
        const params = { email };
        documentIds.forEach((id, i) => { params[`did${i}`] = id; });
        if (documentType) params.document_type = documentType;

        const [rows] = await bigquery.query({
          query: `SELECT m.document_id, COUNT(*) as unread_count
                  FROM ${msgTable} m
                  JOIN ${recTable} r ON m.id = r.message_id
                  WHERE r.recipient_email = @email
                    AND r.is_read = false
                    AND m.document_id IN (${placeholders})
                    ${documentType ? 'AND m.document_type = @document_type' : ''}
                  GROUP BY m.document_id`,
          params,
        });
        // Возвращаем как объект { document_id: count }
        const result = {};
        rows.forEach(r => { result[r.document_id] = parseInt(r.unread_count); });
        res.json(result);
        return;
      }

      // Общий список непрочитанных (для шапки)
      const [rows] = await bigquery.query({
        query: `SELECT m.document_id, m.document_type, COUNT(*) as unread_count
                FROM ${msgTable} m
                JOIN ${recTable} r ON m.id = r.message_id
                WHERE r.recipient_email = @email AND r.is_read = false
                GROUP BY m.document_id, m.document_type`,
        params: { email },
      });
      res.json(rows);
      return;
    }

    // GET /messages?document_id=xxx&document_type=invoice
    if (req.method === 'GET') {
      const documentId   = req.query.document_id;
      const documentType = req.query.document_type;
      if (!documentId || !documentType) {
        res.status(400).json({ error: 'document_id and document_type are required' });
        return;
      }

      const [rows] = await bigquery.query({
        query: `SELECT m.id, m.document_id, m.document_type, m.parent_id,
                       m.text, m.from_user, m.created_at,
                       r.is_read, r.read_at
                FROM ${msgTable} m
                LEFT JOIN ${recTable} r
                  ON m.id = r.message_id AND r.recipient_email = @email
                WHERE m.document_id = @document_id AND m.document_type = @document_type
                ORDER BY m.created_at ASC`,
        params: { document_id: documentId, document_type: documentType, email },
      });

      res.json(rows);
      return;
    }

    // POST — отправить сообщение
    if (req.method === 'POST') {
      const { document_id, document_type, document_name, parent_id, text, to_users } = req.body;

      if (!document_id || !document_type || !text) {
        res.status(400).json({ error: 'document_id, document_type and text are required' });
        return;
      }

      const toUsersArr = Array.isArray(to_users) ? to_users : [];
      const msgId = uuidv4();

      // Сохраняем сообщение
      await bigquery.query({
        query: `INSERT INTO ${msgTable} (id, document_id, document_type, parent_id, text, from_user, created_at)
                VALUES (@id, @document_id, @document_type, NULLIF(@parent_id,''), @text, @from_user, CURRENT_TIMESTAMP())`,
        params: {
          id:            msgId,
          document_id,
          document_type,
          parent_id:     parent_id || '',
          text,
          from_user:     email,
        },
      });

      // Сохраняем получателей
      for (const recipientEmail of toUsersArr) {
        await bigquery.query({
          query: `INSERT INTO ${recTable} (id, message_id, recipient_email, is_read)
                  VALUES (@id, @message_id, @recipient_email, false)`,
          params: {
            id:              uuidv4(),
            message_id:      msgId,
            recipient_email: recipientEmail,
          },
        });
      }

      // Telegram уведомления
      const sender     = await getUserByEmail(email);
      const senderName = sender ? sender.name : email;
      const pageMap    = { invoice: 'invoices.html', transaction: 'invoices.html' };
      const page       = pageMap[document_type] || 'invoices.html';
      const docLink    = `${APP_URL}/${page}?document_id=${document_id}&type=${document_type}`;
      const isReply    = !!parent_id;

      // Уведомляем получателей
      if (toUsersArr.length > 0) {
        const recipients = await getUsersByEmails(toUsersArr);
        for (const recipient of recipients) {
          const msg = isReply
            ? `💬 <b>${senderName}</b> ответил на вопрос\n\n📄 ${document_name || document_id}\n\n<i>${text}</i>\n\n🔗 <a href="${docLink}">Открыть</a>`
            : `❓ <b>${senderName}</b> задал вопрос\n\n📄 ${document_name || document_id}\n\n<i>${text}</i>\n\n🔗 <a href="${docLink}">Открыть</a>`;
          await notifyUser(recipient, msg);
        }
      }

      // Если ответ — уведомляем автора вопроса
      if (isReply) {
        const [parentRows] = await bigquery.query({
          query: `SELECT from_user FROM ${msgTable} WHERE id = @id`,
          params: { id: parent_id },
        });
        if (parentRows.length && parentRows[0].from_user !== email) {
          const author = await getUserByEmail(parentRows[0].from_user);
          if (author) {
            const msg = `✅ <b>${senderName}</b> ответил на ваш вопрос\n\n📄 ${document_name || document_id}\n\n<i>${text}</i>\n\n🔗 <a href="${docLink}">Открыть</a>`;
            await notifyUser(author, msg);
          }
        }
      }

      res.json({ success: true, id: msgId });
      return;
    }

    // PUT /messages/:id/read — отметить как прочитанное
    if (req.method === 'PUT') {
      const messageId = req.url.split('/').filter(Boolean).pop().split('?')[0];
      if (messageId === 'read-all') {
        // Пометить все как прочитанные для документа
        const { document_id, document_type } = req.body;
        await bigquery.query({
          query: `UPDATE ${recTable} r
                  SET is_read = true, read_at = CURRENT_TIMESTAMP()
                  WHERE r.recipient_email = @email
                    AND r.is_read = false
                    AND r.message_id IN (
                      SELECT id FROM ${msgTable}
                      WHERE document_id = @document_id AND document_type = @document_type
                    )`,
          params: { email, document_id, document_type },
        });
      } else {
        // Пометить одно сообщение
        await bigquery.query({
          query: `UPDATE ${recTable}
                  SET is_read = true, read_at = CURRENT_TIMESTAMP()
                  WHERE message_id = @message_id AND recipient_email = @email`,
          params: { message_id: messageId, email },
        });
      }
      res.json({ success: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });

  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
