const { BigQuery } = require('@google-cloud/bigquery');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'users_folders';

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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

async function isAdmin(email) {
  const [rows] = await bigquery.query({
    query: `SELECT is_admin FROM \`${PROJECT}.${DATASET}.users\` WHERE email = @email`,
    params: { email },
  });
  return rows[0]?.is_admin === true;
}

exports.users_folders = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;

  try {

    // GET /users_folders?user_email=xxx — доступы конкретного пользователя
    // GET /users_folders?folder_id=xxx  — все пользователи папки
    if (req.method === 'GET') {
      const admin = await isAdmin(email);
      if (!admin) { res.status(403).json({ error: 'Forbidden' }); return; }

      const { user_email, folder_id } = req.query;

      if (user_email) {
        const [rows] = await bigquery.query({
          query: `SELECT uf.id, uf.user_email, uf.folder_id, uf.docs_access,
                         f.name as folder_name
                  FROM ${table} uf
                  JOIN \`${PROJECT}.${DATASET}.folders\` f ON f.id = uf.folder_id
                  WHERE uf.user_email = @user_email
                  ORDER BY f.name ASC`,
          params: { user_email },
        });
        res.json(rows);
        return;
      }

      if (folder_id) {
        const [rows] = await bigquery.query({
          query: `SELECT uf.id, uf.user_email, uf.folder_id, uf.docs_access,
                         u.name as user_name
                  FROM ${table} uf
                  JOIN \`${PROJECT}.${DATASET}.users\` u ON u.email = uf.user_email
                  WHERE uf.folder_id = @folder_id
                  ORDER BY u.name ASC`,
          params: { folder_id },
        });
        res.json(rows);
        return;
      }

      res.status(400).json({ error: 'user_email or folder_id required' });
      return;
    }

    // POST — создать запись доступа
    if (req.method === 'POST') {
      const admin = await isAdmin(email);
      if (!admin) { res.status(403).json({ error: 'Forbidden' }); return; }

      const { user_email, folder_id, docs_access } = req.body;
      if (!user_email || !folder_id || !docs_access) {
        res.status(400).json({ error: 'user_email, folder_id and docs_access are required' });
        return;
      }

      // Проверяем что такой записи ещё нет
      const [existing] = await bigquery.query({
        query: `SELECT id FROM ${table} WHERE user_email = @user_email AND folder_id = @folder_id`,
        params: { user_email, folder_id },
      });
      if (existing.length > 0) {
        res.status(409).json({ error: 'Access record already exists. Use PUT to update.' });
        return;
      }

      const { v4: uuidv4 } = require('uuid');
      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table} (id, user_email, folder_id, docs_access, created_at, updated_at)
                VALUES (@id, @user_email, @folder_id, @docs_access, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
        params: { id, user_email, folder_id, docs_access },
      });

      res.json({ success: true, id });
      return;
    }

    // PUT — обновить docs_access по id
    if (req.method === 'PUT') {
      const admin = await isAdmin(email);
      if (!admin) { res.status(403).json({ error: 'Forbidden' }); return; }

      const id = req.url.split('/').filter(Boolean).pop().split('?')[0];
      const { docs_access } = req.body;

      if (!id || !docs_access) {
        res.status(400).json({ error: 'id and docs_access are required' });
        return;
      }

      await bigquery.query({
        query: `UPDATE ${table} SET docs_access = @docs_access, updated_at = CURRENT_TIMESTAMP() WHERE id = @id`,
        params: { docs_access, id },
      });

      res.json({ success: true });
      return;
    }

    // DELETE — удалить запись доступа по id
    if (req.method === 'DELETE') {
      const admin = await isAdmin(email);
      if (!admin) { res.status(403).json({ error: 'Forbidden' }); return; }

      const id = req.url.split('/').filter(Boolean).pop().split('?')[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      await bigquery.query({
        query: `DELETE FROM ${table} WHERE id = @id`,
        params: { id },
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
