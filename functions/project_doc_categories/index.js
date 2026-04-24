const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');
const bigquery = new BigQuery();
const PROJECT = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET = 'sunti';
const TABLE = 'project_doc_categories';

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
  return (await r.json()).email || null;
}
async function isAdmin(email) {
  const [rows] = await bigquery.query({
    query: `SELECT is_admin FROM \`${PROJECT}.${DATASET}.users\` WHERE email = @email`,
    params: { email },
  });
  return rows[0]?.is_admin === true;
}

const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;

exports.project_doc_categories = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  try {
    if (req.method === 'GET') {
      const [rows] = await bigquery.query({
        query: `SELECT id, name, name_en, name_th, sort_order FROM ${table} ORDER BY sort_order ASC, name ASC`,
      });
      res.json(rows);
      return;
    }

    if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }

    if (req.method === 'POST') {
      const { name, name_en, name_th, sort_order } = req.body || {};
      if (!name && !name_en) { res.status(400).json({ error: 'name required' }); return; }
      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table} (id, name, name_en, name_th, sort_order, created_by)
                VALUES (@id, @name, @name_en, @name_th, @sort_order, @email)`,
        params: { id, name: name || '', name_en: name_en || '', name_th: name_th || '', sort_order: parseInt(sort_order || 0), email },
      });
      res.json({ success: true, id });
      return;
    }

    if (req.method === 'PUT') {
      const id = (req.url || '').split('/').filter(Boolean).pop().split('?')[0];
      const { name, name_en, name_th, sort_order } = req.body || {};
      await bigquery.query({
        query: `UPDATE ${table} SET name = @name, name_en = @name_en, name_th = @name_th, sort_order = @sort_order WHERE id = @id`,
        params: { id, name: name || '', name_en: name_en || '', name_th: name_th || '', sort_order: parseInt(sort_order || 0) },
      });
      res.json({ success: true });
      return;
    }

    if (req.method === 'DELETE') {
      const id = (req.url || '').split('/').filter(Boolean).pop().split('?')[0];
      await bigquery.query({ query: `DELETE FROM ${table} WHERE id = @id`, params: { id } });
      res.json({ success: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
};
