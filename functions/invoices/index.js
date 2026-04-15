const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'invoices';

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

exports.invoices = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;

  try {
    // GET — накладные по folder_id с фильтром и пагинацией
    if (req.method === 'GET') {
      const folderId   = req.query.folder_id;
      const status     = req.query.status;
      const categoryId = req.query.category_id;
      const limit      = parseInt(req.query.limit  || 25);
      const offset     = parseInt(req.query.offset || 0);

      if (!folderId) { res.status(400).json({ error: 'folder_id is required' }); return; }

      const catTable = `\`${PROJECT}.${DATASET}.categories\``;

      let where = `WHERE i.folder_id = @folder_id`;
      const params = { folder_id: folderId };

      if (status && status !== 'all') {
        where += ` AND i.status = @status`;
        params.status = status;
      }

      if (categoryId && categoryId !== 'all') {
        where += ` AND i.category_id = @category_id`;
        params.category_id = categoryId;
      }

      const [rows] = await bigquery.query({
        query: `SELECT i.id, i.folder_id, i.name, i.status, i.direction, i.total_amount, i.paid_amount,
                       i.category_id, i.uploaded_by, i.uploaded_at,
                       c.name as category_name
                FROM ${table} i
                LEFT JOIN ${catTable} c ON i.category_id = c.id
                ${where}
                ORDER BY i.uploaded_at DESC
                LIMIT ${limit} OFFSET ${offset}`,
        params,
      });

      const [totals] = await bigquery.query({
        query: `SELECT COUNT(*) as total_count,
                       SUM(CASE WHEN i.direction = 'expense' THEN i.total_amount ELSE 0 END) as sum_expense_total,
                       SUM(CASE WHEN i.direction = 'expense' THEN i.paid_amount  ELSE 0 END) as sum_expense_paid,
                       SUM(CASE WHEN i.direction = 'income'  THEN i.total_amount ELSE 0 END) as sum_income_total,
                       SUM(CASE WHEN i.direction = 'income'  THEN i.paid_amount  ELSE 0 END) as sum_income_paid
                FROM ${table} i ${where}`,
        params,
      });

      res.json({
        rows,
        total_count:       parseInt(totals[0].total_count)        || 0,
        sum_expense_total: parseFloat(totals[0].sum_expense_total) || 0,
        sum_expense_paid:  parseFloat(totals[0].sum_expense_paid)  || 0,
        sum_income_total:  parseFloat(totals[0].sum_income_total)  || 0,
        sum_income_paid:   parseFloat(totals[0].sum_income_paid)   || 0,
      });
      return;
    }

    // POST — создать накладную
    if (req.method === 'POST') {
      const { folder_id, name, status, direction, total_amount, paid_amount, category_id } = req.body;
      if (!folder_id || !name) { res.status(400).json({ error: 'folder_id and name are required' }); return; }
      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table} (id, folder_id, name, status, direction, total_amount, paid_amount, category_id, uploaded_by, uploaded_at)
                VALUES (@id, @folder_id, @name, @status, @direction, @total_amount, @paid_amount, NULLIF(@category_id, ''), @uploaded_by, CURRENT_TIMESTAMP())`,
        params: {
          id, folder_id, name,
          status:       status     || 'active',
          direction:    direction  || 'expense',
          total_amount: parseFloat(total_amount || 0),
          paid_amount:  parseFloat(paid_amount  || 0),
          category_id:  category_id || '',
          uploaded_by:  email,
        },
      });
      res.json({ success: true, id });
      return;
    }

    // PUT — редактировать
    if (req.method === 'PUT') {
      const id = req.url.split('/').filter(Boolean).pop().split('?')[0];
      const { name, status, direction, total_amount, paid_amount, category_id } = req.body;
      if (!name || !id) { res.status(400).json({ error: 'name and id are required' }); return; }

      const [rows] = await bigquery.query({
        query: `SELECT folder_id, uploaded_by, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', uploaded_at) as uploaded_at FROM ${table} WHERE id = @id`,
        params: { id },
      });
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      const cur = rows[0];

      await bigquery.query({ query: `DELETE FROM ${table} WHERE id = @id`, params: { id } });
      await bigquery.query({
        query: `INSERT INTO ${table} (id, folder_id, name, status, direction, total_amount, paid_amount, category_id, uploaded_by, uploaded_at)
                VALUES (@id, @folder_id, @name, @status, @direction, @total_amount, @paid_amount, NULLIF(@category_id, ''), @uploaded_by, TIMESTAMP(@uploaded_at))`,
        params: {
          id, folder_id: cur.folder_id, name,
          status:       status     || 'active',
          direction:    direction  || 'expense',
          total_amount: parseFloat(total_amount || 0),
          paid_amount:  parseFloat(paid_amount  || 0),
          category_id:  category_id || '',
          uploaded_by:  cur.uploaded_by,
          uploaded_at:  cur.uploaded_at,
        },
      });
      res.json({ success: true });
      return;
    }

    // DELETE
    if (req.method === 'DELETE') {
      const id = req.url.split('/').filter(Boolean).pop().split('?')[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      // Каскадное удаление файлов
      const filesTable = `\`${PROJECT}.${DATASET}.invoice_files\``;
      await bigquery.query({ query: `DELETE FROM ${filesTable} WHERE invoice_id = @id`, params: { id } });
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
