const { BigQuery } = require('@google-cloud/bigquery');
const crypto = require('crypto');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'tasks_groups_watchers';

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function verifyToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.split(' ')[1];
  const r1 = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
  if (r1.ok) { const info = await r1.json(); return info.email || null; }
  const r2 = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
  if (r2.ok) { const info = await r2.json(); return info.email || null; }
  return null;
}

async function isAdmin(email) {
  const [rows] = await bigquery.query({
    query: `SELECT is_admin FROM \`${PROJECT}.${DATASET}.users\` WHERE email = @email`,
    params: { email },
  });
  return rows[0]?.is_admin === true;
}

exports.tasks_groups_watchers = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table    = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const usersTbl = `\`${PROJECT}.${DATASET}.users\``;
  const path     = (req.url || '').split('?')[0];
  const segments = path.split('/').filter(Boolean);

  try {
    // GET /tasks_groups_watchers?tasks_group_id=X
    if (req.method === 'GET') {
      const { tasks_group_id } = req.query;
      if (!tasks_group_id) { res.status(400).json({ error: 'tasks_group_id is required' }); return; }

      const [rows] = await bigquery.query({
        query: `SELECT w.*, u.name as user_name
                FROM ${table} w
                LEFT JOIN ${usersTbl} u ON w.user_id = u.id
                WHERE w.tasks_group_id = @tasks_group_id`,
        params: { tasks_group_id },
      });
      res.json(rows);
      return;
    }

    // POST /tasks_groups_watchers
    if (req.method === 'POST') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const b = req.body || {};
      if (!b.tasks_group_id || !b.user_id) { res.status(400).json({ error: 'tasks_group_id and user_id are required' }); return; }

      const id = crypto.randomUUID();
      await bigquery.query({
        query: `INSERT INTO ${table} (id, tasks_group_id, user_id, created_at)
                VALUES (@id, @tasks_group_id, @user_id, CURRENT_TIMESTAMP())`,
        params: { id, tasks_group_id: b.tasks_group_id, user_id: b.user_id },
      });
      res.json({ success: true, id });
      return;
    }

    // DELETE /tasks_groups_watchers/:id
    if (req.method === 'DELETE') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = segments[0];
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
