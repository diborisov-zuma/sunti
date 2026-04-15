const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'users_statements';

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

exports.users_statements = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;

  try {
    if (req.method === 'GET') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const { user_email, company_id } = req.query;

      if (user_email) {
        const [rows] = await bigquery.query({
          query: `SELECT us.id, us.user_email, us.company_id, us.statement_access,
                         c.name as company_name
                  FROM ${table} us
                  JOIN \`${PROJECT}.${DATASET}.companies\` c ON c.id = us.company_id
                  WHERE us.user_email = @user_email
                  ORDER BY c.name ASC`,
          params: { user_email },
        });
        res.json(rows);
        return;
      }

      if (company_id) {
        const [rows] = await bigquery.query({
          query: `SELECT us.id, us.user_email, us.company_id, us.statement_access,
                         u.name as user_name
                  FROM ${table} us
                  JOIN \`${PROJECT}.${DATASET}.users\` u ON u.email = us.user_email
                  WHERE us.company_id = @company_id
                  ORDER BY u.name ASC`,
          params: { company_id },
        });
        res.json(rows);
        return;
      }

      res.status(400).json({ error: 'user_email or company_id required' });
      return;
    }

    if (req.method === 'POST') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const { user_email, company_id, statement_access } = req.body;
      if (!user_email || !company_id || !statement_access) {
        res.status(400).json({ error: 'user_email, company_id and statement_access are required' });
        return;
      }
      const [existing] = await bigquery.query({
        query: `SELECT id FROM ${table} WHERE user_email = @user_email AND company_id = @company_id`,
        params: { user_email, company_id },
      });
      if (existing.length > 0) {
        res.status(409).json({ error: 'Access record already exists. Use PUT to update.' });
        return;
      }
      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table} (id, user_email, company_id, statement_access)
                VALUES (@id, @user_email, @company_id, @statement_access)`,
        params: { id, user_email, company_id, statement_access },
      });
      res.json({ success: true, id });
      return;
    }

    if (req.method === 'PUT') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = req.url.split('/').filter(Boolean).pop().split('?')[0];
      const { statement_access } = req.body;
      if (!id || !statement_access) { res.status(400).json({ error: 'id and statement_access are required' }); return; }
      await bigquery.query({
        query: `UPDATE ${table} SET statement_access = @statement_access WHERE id = @id`,
        params: { statement_access, id },
      });
      res.json({ success: true });
      return;
    }

    if (req.method === 'DELETE') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = req.url.split('/').filter(Boolean).pop().split('?')[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }
      await bigquery.query({ query: `DELETE FROM ${table} WHERE id = @id`, params: { id } });
      res.json({ success: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
