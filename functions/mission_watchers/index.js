const { BigQuery } = require('@google-cloud/bigquery');
const crypto = require('crypto');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'mission_watchers';

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

async function getUserByEmail(email) {
  const [rows] = await bigquery.query({
    query: `SELECT id, email, name FROM \`${PROJECT}.${DATASET}.users\` WHERE email = @email`,
    params: { email },
  });
  return rows[0] || null;
}

exports.mission_watchers = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table     = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const usersTbl  = `\`${PROJECT}.${DATASET}.users\``;
  const eventsTbl = `\`${PROJECT}.${DATASET}.mission_events\``;
  const path      = (req.url || '').split('?')[0];
  const segments  = path.split('/').filter(Boolean);

  try {
    // GET /mission_watchers?mission_id=X
    if (req.method === 'GET') {
      const { mission_id } = req.query;
      if (!mission_id) { res.status(400).json({ error: 'mission_id is required' }); return; }

      const [rows] = await bigquery.query({
        query: `SELECT w.*, u.name as user_name
                FROM ${table} w
                LEFT JOIN ${usersTbl} u ON w.user_id = u.id
                WHERE w.mission_id = @mission_id`,
        params: { mission_id },
      });
      res.json(rows);
      return;
    }

    // POST /mission_watchers
    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.mission_id || !b.user_id) { res.status(400).json({ error: 'mission_id and user_id are required' }); return; }

      const user = await getUserByEmail(email);
      if (!user) { res.status(403).json({ error: 'User not found' }); return; }

      // Check not already exists
      const [existing] = await bigquery.query({
        query: `SELECT id FROM ${table} WHERE mission_id = @mission_id AND user_id = @user_id`,
        params: { mission_id: b.mission_id, user_id: b.user_id },
      });
      if (existing.length > 0) { res.status(409).json({ error: 'Watcher already exists' }); return; }

      const id = crypto.randomUUID();
      await bigquery.query({
        query: `INSERT INTO ${table} (id, mission_id, user_id, added_at, added_by)
                VALUES (@id, @mission_id, @user_id, CURRENT_TIMESTAMP(), @added_by)`,
        params: { id, mission_id: b.mission_id, user_id: b.user_id, added_by: user.id },
      });

      // Log event
      await bigquery.query({
        query: `INSERT INTO ${eventsTbl} (id, mission_id, event_type, payload, actor_id, created_at)
                VALUES (@id, @mid, @type, @payload, @actor, CURRENT_TIMESTAMP())`,
        params: {
          id: crypto.randomUUID(),
          mid: b.mission_id,
          type: 'watcher_added',
          payload: JSON.stringify({ user_id: b.user_id }),
          actor: user.id,
        },
      });

      res.json({ success: true, id });
      return;
    }

    // DELETE /mission_watchers/:id
    if (req.method === 'DELETE') {
      const id = segments[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      const user = await getUserByEmail(email);
      if (!user) { res.status(403).json({ error: 'User not found' }); return; }

      // Get watcher to know mission_id for event
      const [rows] = await bigquery.query({
        query: `SELECT * FROM ${table} WHERE id = @id`,
        params: { id },
      });
      if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
      const watcher = rows[0];

      await bigquery.query({
        query: `DELETE FROM ${table} WHERE id = @id`,
        params: { id },
      });

      // Log event
      await bigquery.query({
        query: `INSERT INTO ${eventsTbl} (id, mission_id, event_type, payload, actor_id, created_at)
                VALUES (@id, @mid, @type, @payload, @actor, CURRENT_TIMESTAMP())`,
        params: {
          id: crypto.randomUUID(),
          mid: watcher.mission_id,
          type: 'watcher_removed',
          payload: JSON.stringify({ user_id: watcher.user_id }),
          actor: user.id,
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
