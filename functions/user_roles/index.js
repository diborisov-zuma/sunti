const { BigQuery } = require('@google-cloud/bigquery');
const crypto = require('crypto');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'user_roles';

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

exports.user_roles = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table    = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const usersTbl = `\`${PROJECT}.${DATASET}.users\``;
  const path     = (req.url || '').split('?')[0];
  const segments = path.split('/').filter(Boolean);

  try {
    // GET /user_roles or /user_roles?role=X
    if (req.method === 'GET') {
      const { role } = req.query;
      let query = `SELECT r.*, u.name as user_name, u.email as user_email
                   FROM ${table} r
                   LEFT JOIN ${usersTbl} u ON r.user_id = u.id`;
      const params = {};
      if (role) {
        query += ` WHERE r.role = @role`;
        params.role = role;
      }
      query += ` ORDER BY r.role, u.name`;
      const [rows] = await bigquery.query({ query, params });
      res.json(rows);
      return;
    }

    // POST /user_roles
    if (req.method === 'POST') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const b = req.body || {};
      if (!b.user_id || !b.role) { res.status(400).json({ error: 'user_id and role are required' }); return; }

      // Check not duplicate
      const [existing] = await bigquery.query({
        query: `SELECT id FROM ${table} WHERE user_id = @user_id AND role = @role`,
        params: { user_id: b.user_id, role: b.role },
      });
      if (existing.length > 0) { res.status(409).json({ error: 'Role already assigned to this user' }); return; }

      const id = crypto.randomUUID();
      await bigquery.query({
        query: `INSERT INTO ${table} (id, user_id, role, is_primary, created_at)
                VALUES (@id, @user_id, @role, @is_primary, CURRENT_TIMESTAMP())`,
        params: {
          id,
          user_id: b.user_id,
          role: b.role,
          is_primary: b.is_primary === true,
        },
      });
      res.json({ success: true, id });
      return;
    }

    // DELETE /user_roles/:id
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
