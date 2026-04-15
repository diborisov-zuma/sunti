const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'users';

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

exports.users = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;

  try {
    // GET — список всех активных пользователей
    if (req.method === 'GET') {
      const [rows] = await bigquery.query({
        query: `SELECT id, email, name, telegram_chat_id, telegram_username, first_login, last_login, is_active
                FROM ${table}
                WHERE is_active = true
                ORDER BY name ASC`,
      });
      res.json(rows);
      return;
    }

    // POST — автологин: создать или обновить пользователя
    if (req.method === 'POST') {
      const { name } = req.body;

      await bigquery.query({
        query: `MERGE \`${PROJECT}.${DATASET}.${TABLE}\` T
                USING (SELECT @email as email, @name as name) S
                ON T.email = S.email
                WHEN MATCHED THEN
                  UPDATE SET last_login = CURRENT_TIMESTAMP(), name = S.name
                WHEN NOT MATCHED THEN
                  INSERT (id, email, name, telegram_chat_id, first_login, last_login, is_active)
                  VALUES (GENERATE_UUID(), S.email, S.name, '', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), true)`,
        params: { email, name: name || email },
      });

      res.json({ success: true });
      return;
    }

    // PUT — обновить поля пользователя
    if (req.method === 'PUT') {
      const { telegram_chat_id, telegram_username, name, is_active } = req.body;
      const targetEmail = decodeURIComponent(req.url.split('/').filter(Boolean).pop().split('?')[0]);

      await bigquery.query({
        query: `UPDATE ${table}
                SET telegram_chat_id = @telegram_chat_id,
                    telegram_username = @telegram_username,
                    name = @name,
                    is_active = @is_active
                WHERE email = @email`,
        params: {
          telegram_chat_id: telegram_chat_id || '',
          telegram_username: telegram_username || '',
          name:             name || targetEmail,
          is_active:        is_active !== false,
          email:            targetEmail,
        },
      });

      res.json({ success: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });

  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
