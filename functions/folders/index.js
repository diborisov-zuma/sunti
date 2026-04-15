const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'folders';

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

exports.folders = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;

  try {
    // GET — все папки
    if (req.method === 'GET') {
      const [rows] = await bigquery.query({
        query: `SELECT id, name, \`order\`, status FROM ${table} ORDER BY \`order\` ASC`,
      });
      res.json(rows);
      return;
    }

    // POST — создать
    if (req.method === 'POST') {
      const { name, order, status } = req.body;
      if (!name || order === undefined || !status) {
        res.status(400).json({ error: 'name, order and status are required' });
        return;
      }
      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table} (id, name, \`order\`, status, created_at, created_by)
                VALUES (@id, @name, @order, @status, CURRENT_TIMESTAMP(), @created_by)`,
        params: { id, name, order: parseInt(order), status, created_by: email },
      });
      res.json({ success: true, id, name });
      return;
    }

    // PUT — редактировать по id
    if (req.method === 'PUT') {
      const id = req.url.split('/').filter(Boolean).pop().split('?')[0];
      const { name, order, status } = req.body;
      const orderInt = parseInt(order || 1);
      console.log('PUT id:', id, 'body:', JSON.stringify(req.body));
      if (!name || !id) { res.status(400).json({ error: 'name and id are required' }); return; }
      const query = `UPDATE ${table} SET name = @name, \`order\` = ${orderInt}, status = @status WHERE id = @id`;
      await bigquery.query({
        query,
        params: { name, status: status || 'active', id },
      });
      res.json({ success: true });
      return;
    }

    // DELETE — удалить по id
    if (req.method === 'DELETE') {
      const id = req.url.split('/').filter(Boolean).pop().split('?')[0];
      console.log('DELETE id:', id);
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
