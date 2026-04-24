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

    // GET /users/me — данные текущего пользователя
    if (req.method === 'GET' && req.url.includes('/me')) {
      const [rows] = await bigquery.query({
        query: `SELECT u.id, u.email, u.name, u.telegram_chat_id, u.telegram_username,
                       u.is_admin, u.can_see_salary, u.is_active,
                       (SELECT COUNT(*) FROM \`${PROJECT}.${DATASET}.users_folders\`
                        WHERE user_email = u.email AND docs_access = 'editor') AS editor_folder_count,
                       (SELECT COUNT(*) FROM \`${PROJECT}.${DATASET}.users_folders\`
                        WHERE user_email = u.email AND docs_level IN ('viewer','editor')) AS docs_folder_count
                FROM ${table} u WHERE u.email = @email`,
        params: { email },
      });
      if (!rows.length) { res.status(404).json({ error: 'User not found' }); return; }
      const user = rows[0];
      user.has_contracts_access = user.is_admin === true || parseInt(user.editor_folder_count) > 0;
      user.has_docs_access = user.is_admin === true || parseInt(user.docs_folder_count) > 0;
      res.json(user);
      return;
    }

    // GET /users — список всех пользователей (только для админа)
    if (req.method === 'GET') {
      const [rows] = await bigquery.query({
        query: `SELECT id, email, name, telegram_chat_id, telegram_username,
                       is_admin, can_see_salary, first_login, last_login, is_active
                FROM ${table}
                ORDER BY name ASC`,
      });
      res.json(rows);
      return;
    }

    // POST — создать пользователя (только админ)
    if (req.method === 'POST') {
      const { name, email: targetEmail } = req.body;

      // Проверяем что вызывающий — админ
      const [callerRows] = await bigquery.query({
        query: `SELECT is_admin FROM ${table} WHERE email = @email`,
        params: { email },
      });
      if (!callerRows.length || !callerRows[0].is_admin) {
        res.status(403).json({ error: 'Only admins can create users' });
        return;
      }

      const newEmail = targetEmail || email;

      // Проверяем что пользователь ещё не существует
      const [existing] = await bigquery.query({
        query: `SELECT email FROM ${table} WHERE email = @email`,
        params: { email: newEmail },
      });
      if (existing.length) {
        res.status(409).json({ error: 'User already exists' });
        return;
      }

      await bigquery.query({
        query: `INSERT INTO ${table} (id, email, name, telegram_chat_id, first_login, last_login, is_active, is_admin, can_see_salary)
                VALUES (GENERATE_UUID(), @email, @name, '', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), true, false, false)`,
        params: { email: newEmail, name: name || newEmail },
      });

      res.json({ success: true });
      return;
    }

    // PUT — обновить поля пользователя (только для админа)
    if (req.method === 'PUT') {
      const { telegram_chat_id, telegram_username, name, is_active, is_admin, can_see_salary } = req.body;
      const targetEmail = decodeURIComponent(req.url.split('/').filter(Boolean).pop().split('?')[0]);

      await bigquery.query({
        query: `UPDATE ${table}
                SET telegram_chat_id  = @telegram_chat_id,
                    telegram_username = @telegram_username,
                    name              = @name,
                    is_active         = @is_active,
                    is_admin          = @is_admin,
                    can_see_salary    = @can_see_salary
                WHERE email = @email`,
        params: {
          telegram_chat_id:  telegram_chat_id  || '',
          telegram_username: telegram_username || '',
          name:              name || targetEmail,
          is_active:         is_active  !== false,
          is_admin:          is_admin   === true || is_admin   === 'true',
          can_see_salary:    can_see_salary === true || can_see_salary === 'true',
          email:             targetEmail,
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
