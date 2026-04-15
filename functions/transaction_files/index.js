const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'transaction_files';

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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

exports.transaction_files = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;

  try {
    // GET — файлы по transaction_id
    if (req.method === 'GET') {
      const transactionId = req.query.transaction_id;
      if (!transactionId) { res.status(400).json({ error: 'transaction_id is required' }); return; }
      const [rows] = await bigquery.query({
        query: `SELECT id, transaction_id, name, file_name, file_url, file_size, uploaded_by, uploaded_at
                FROM ${table} WHERE transaction_id = @transaction_id ORDER BY uploaded_at DESC`,
        params: { transaction_id: transactionId },
      });
      res.json(rows);
      return;
    }

    // POST — добавить файл
    if (req.method === 'POST') {
      const { transaction_id, name, file_name, file_url, file_size } = req.body;
      if (!transaction_id || !file_url) { res.status(400).json({ error: 'transaction_id and file_url are required' }); return; }
      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table} (id, transaction_id, name, file_name, file_url, file_size, uploaded_by, uploaded_at)
                VALUES (@id, @transaction_id, @name, @file_name, @file_url, @file_size, @uploaded_by, CURRENT_TIMESTAMP())`,
        params: {
          id,
          transaction_id,
          name:        name      || file_name || '',
          file_name:   file_name || '',
          file_url,
          file_size:   parseInt(file_size || 0),
          uploaded_by: email,
        },
      });
      res.json({ success: true, id });
      return;
    }

    // DELETE
    if (req.method === 'DELETE') {
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
