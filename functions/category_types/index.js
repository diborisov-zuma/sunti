const { BigQuery } = require('@google-cloud/bigquery');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'category_types';

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

exports.category_types = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const path  = (req.url || '').split('?')[0];

  try {
    if (req.method === 'GET') {
      const [rows] = await bigquery.query({
        query: `SELECT id, name, name_en, name_th, sort_order FROM ${table} ORDER BY sort_order NULLS LAST, name`,
      });
      res.json(rows);
      return;
    }

    if (req.method === 'PUT' && path === '/reorder') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const ids = (req.body && req.body.ids) || [];
      if (!Array.isArray(ids) || !ids.length) { res.status(400).json({ error: 'ids required' }); return; }
      const cases = ids.map((_, i) => `WHEN @id${i} THEN ${(i + 1) * 1000}`).join(' ');
      const params = { all_ids: ids };
      ids.forEach((id, i) => { params['id' + i] = id; });
      await bigquery.query({
        query: `UPDATE ${table} SET sort_order = CASE id ${cases} ELSE sort_order END WHERE id IN UNNEST(@all_ids)`,
        params,
      });
      res.json({ success: true });
      return;
    }

    if (req.method === 'POST') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const { id, name, name_en, name_th } = req.body || {};
      if (!id || !name) { res.status(400).json({ error: 'id and name are required' }); return; }
      await bigquery.query({
        query: `INSERT INTO ${table} (id, name, name_en, name_th, sort_order)
                VALUES (@id, @name, @name_en, @name_th,
                  (SELECT IFNULL(MAX(sort_order), 0) + 1000 FROM ${table}))`,
        params: { id, name, name_en: name_en || null, name_th: name_th || null },
      });
      res.json({ success: true, id });
      return;
    }

    if (req.method === 'PUT') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = path.split('/').filter(Boolean)[0];
      const { name, name_en, name_th } = req.body || {};
      if (!id || !name) { res.status(400).json({ error: 'id and name are required' }); return; }
      await bigquery.query({
        query: `UPDATE ${table} SET name=@name, name_en=@name_en, name_th=@name_th WHERE id=@id`,
        params: { id, name, name_en: name_en || null, name_th: name_th || null },
      });
      res.json({ success: true });
      return;
    }

    if (req.method === 'DELETE') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      await bigquery.query({ query: `DELETE FROM ${table} WHERE id=@id`, params: { id } });
      res.json({ success: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
