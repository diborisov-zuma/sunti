const { BigQuery } = require('@google-cloud/bigquery');
const crypto = require('crypto');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'mission_comments';

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

exports.mission_comments = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table    = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const usersTbl = `\`${PROJECT}.${DATASET}.users\``;
  const eventsTbl = `\`${PROJECT}.${DATASET}.mission_events\``;

  try {
    // GET /mission_comments?mission_id=X
    if (req.method === 'GET') {
      const { mission_id } = req.query;
      if (!mission_id) { res.status(400).json({ error: 'mission_id is required' }); return; }

      const [rows] = await bigquery.query({
        query: `SELECT c.*, u.name as author_name
                FROM ${table} c
                LEFT JOIN ${usersTbl} u ON c.author_id = u.id
                WHERE c.mission_id = @mission_id
                ORDER BY c.created_at ASC`,
        params: { mission_id },
      });
      res.json(rows);
      return;
    }

    // POST /mission_comments
    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.mission_id || !b.body) { res.status(400).json({ error: 'mission_id and body are required' }); return; }

      const user = await getUserByEmail(email);
      if (!user) { res.status(403).json({ error: 'User not found' }); return; }

      const id = crypto.randomUUID();
      await bigquery.query({
        query: `INSERT INTO ${table} (id, mission_id, author_id, body, attachments, created_at)
                VALUES (@id, @mission_id, @author_id, @body, @attachments, CURRENT_TIMESTAMP())`,
        params: {
          id,
          mission_id: b.mission_id,
          author_id: user.id,
          body: b.body,
          attachments: b.attachments ? JSON.stringify(b.attachments) : '[]',
        },
      });

      // Log event
      await bigquery.query({
        query: `INSERT INTO ${eventsTbl} (id, mission_id, event_type, payload, actor_id, created_at)
                VALUES (@id, @mid, @type, @payload, @actor, CURRENT_TIMESTAMP())`,
        params: {
          id: crypto.randomUUID(),
          mid: b.mission_id,
          type: 'comment_added',
          payload: JSON.stringify({ comment_id: id }),
          actor: user.id,
        },
      });

      res.json({ success: true, id });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
