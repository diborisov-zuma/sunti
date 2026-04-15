const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'company_accounts';

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
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

exports.company_accounts = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;

  try {
    if (req.method === 'GET') {
      const companyId = req.query.company_id;
      let query = `SELECT id, company_id, name, bank_name, bank_account, IFNULL(is_active, TRUE) AS is_active
                   FROM ${table}
                   ORDER BY IFNULL(is_active, TRUE) DESC, name ASC`;
      const params = {};
      if (companyId) {
        query = `SELECT id, company_id, name, bank_name, bank_account, IFNULL(is_active, TRUE) AS is_active
                 FROM ${table}
                 WHERE company_id = @company_id
                 ORDER BY IFNULL(is_active, TRUE) DESC, name ASC`;
        params.company_id = companyId;
      }
      const [rows] = await bigquery.query({ query, params });
      res.json(rows);
      return;
    }

    if (req.method === 'POST') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const { company_id, name, bank_name, bank_account, is_active } = req.body;
      if (!name) { res.status(400).json({ error: 'name is required' }); return; }
      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table} (id, company_id, name, bank_name, bank_account, is_active)
                VALUES (@id, NULLIF(@company_id, ''), @name, @bank_name, @bank_account, @is_active)`,
        params: {
          id,
          company_id:   company_id || '',
          name,
          bank_name:    bank_name    || null,
          bank_account: bank_account || null,
          is_active:    is_active !== false,
        },
      });
      res.json({ success: true, id });
      return;
    }

    if (req.method === 'PUT') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = req.url.split('/').filter(Boolean).pop().split('?')[0];
      const { company_id, name, bank_name, bank_account, is_active } = req.body;
      if (!id || !name) { res.status(400).json({ error: 'id and name are required' }); return; }
      await bigquery.query({
        query: `UPDATE ${table}
                SET company_id = NULLIF(@company_id, ''), name = @name,
                    bank_name = @bank_name, bank_account = @bank_account,
                    is_active = @is_active
                WHERE id = @id`,
        params: {
          id,
          company_id:   company_id || '',
          name,
          bank_name:    bank_name    || null,
          bank_account: bank_account || null,
          is_active:    is_active !== false,
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
