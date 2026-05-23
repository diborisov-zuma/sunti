const { BigQuery } = require('@google-cloud/bigquery');
const crypto = require('crypto');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'task_dependencies';

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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

exports.task_dependencies = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table     = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const tasksTbl  = `\`${PROJECT}.${DATASET}.tasks\``;
  const phasesTbl = `\`${PROJECT}.${DATASET}.phases\``;
  const path      = (req.url || '').split('?')[0];

  try {
    // GET /task_dependencies?folder_id=X
    if (req.method === 'GET') {
      const { folder_id } = req.query;
      if (!folder_id) { res.status(400).json({ error: 'folder_id is required' }); return; }

      const [rows] = await bigquery.query({
        query: `SELECT d.id, d.predecessor_id, d.successor_id, d.type, d.lag_days
                FROM ${table} d
                WHERE d.predecessor_id IN (
                  SELECT t.id FROM ${tasksTbl} t
                  JOIN ${phasesTbl} p ON t.phase_id = p.id
                  WHERE p.folder_id = @folder_id
                )`,
        params: { folder_id },
      });
      res.json(rows);
      return;
    }

    // POST /task_dependencies
    if (req.method === 'POST') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const b = req.body || {};
      if (!b.predecessor_id || !b.successor_id) {
        res.status(400).json({ error: 'predecessor_id and successor_id are required' });
        return;
      }
      const id = crypto.randomUUID();
      await bigquery.query({
        query: `INSERT INTO ${table}
                  (id, predecessor_id, successor_id, type, lag_days)
                VALUES
                  (@id, @predecessor_id, @successor_id, @type, @lag_days)`,
        params: {
          id,
          predecessor_id: b.predecessor_id,
          successor_id:   b.successor_id,
          type:            b.type || 'FS',
          lag_days:        b.lag_days != null ? b.lag_days : 0,
        },
      });
      res.json({ success: true, id });
      return;
    }

    // DELETE /task_dependencies/:id
    if (req.method === 'DELETE') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = path.split('/').filter(Boolean)[0];
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
