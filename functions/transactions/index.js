const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'transactions';

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

exports.transactions = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table      = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const catTable   = `\`${PROJECT}.${DATASET}.categories\``;

  try {
    // GET — транзакции по invoice_id или folder_id
    if (req.method === 'GET') {
      const invoiceId = req.query.invoice_id;
      const folderId  = req.query.folder_id;

      let where = '';
      const params = {};

      if (invoiceId) {
        where = 'WHERE t.invoice_id = @invoice_id AND IFNULL(t.status, \'active\') != \'deleted\'';
        params.invoice_id = invoiceId;
      } else if (folderId) {
        where = 'WHERE t.folder_id = @folder_id AND IFNULL(t.status, \'active\') != \'deleted\'';
        params.folder_id = folderId;
      } else {
        res.status(400).json({ error: 'invoice_id or folder_id is required' });
        return;
      }

      const [rows] = await bigquery.query({
        query: `SELECT t.id, t.date, t.amount, t.direction, t.account_id,
                       t.counterparty_id, t.category_id, t.invoice_id, t.folder_id,
                       t.description, t.created_at,
                       c.name as category_name
                FROM ${table} t
                LEFT JOIN ${catTable} c ON t.category_id = c.id
                ${where}
                ORDER BY t.date DESC`,
        params,
      });
      res.json(rows);
      return;
    }

    // POST — создать транзакцию
    if (req.method === 'POST') {
      const { date, amount, direction, account_id, counterparty_id, category_id, invoice_id, folder_id, description } = req.body;
      if (!date || !amount || !direction) {
        res.status(400).json({ error: 'date, amount and direction are required' });
        return;
      }
      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table} (id, date, amount, direction, account_id, counterparty_id, category_id, invoice_id, folder_id, description, created_at)
                VALUES (@id, @date, @amount, @direction, NULLIF(@account_id,''), NULLIF(@counterparty_id,''), NULLIF(@category_id,''), NULLIF(@invoice_id,''), NULLIF(@folder_id,''), @description, CURRENT_TIMESTAMP())`,
        params: {
          id,
          date,
          amount:          parseFloat(amount),
          direction,
          account_id:      account_id      || '',
          counterparty_id: counterparty_id || '',
          category_id:     category_id     || '',
          invoice_id:      invoice_id      || '',
          folder_id:       folder_id       || '',
          description:     description     || '',
        },
      });
      res.json({ success: true, id });
      return;
    }

    // PUT — редактировать транзакцию
    if (req.method === 'PUT') {
      const id = req.url.split('/').filter(Boolean).pop().split('?')[0];
      const { date, amount, direction, account_id, counterparty_id, category_id, folder_id, description } = req.body;
      if (!id || !date || !amount) { res.status(400).json({ error: 'id, date and amount are required' }); return; }

      const [rows] = await bigquery.query({
        query: `SELECT invoice_id, folder_id, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', created_at) as created_at FROM ${table} WHERE id = @id`,
        params: { id },
      });
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      const cur = rows[0];

      await bigquery.query({ query: `DELETE FROM ${table} WHERE id = @id`, params: { id } });
      await bigquery.query({
        query: `INSERT INTO ${table} (id, date, amount, direction, account_id, counterparty_id, category_id, invoice_id, folder_id, description, created_at)
                VALUES (@id, @date, @amount, @direction, NULLIF(@account_id,''), NULLIF(@counterparty_id,''), NULLIF(@category_id,''), NULLIF(@invoice_id,''), NULLIF(@folder_id,''), @description, TIMESTAMP(@created_at))`,
        params: {
          id,
          date,
          amount:          parseFloat(amount),
          direction,
          account_id:      account_id      || '',
          counterparty_id: counterparty_id || '',
          category_id:     category_id     || '',
          invoice_id:      cur.invoice_id  || '',
          folder_id:       folder_id       || cur.folder_id || '',
          description:     description     || '',
          created_at:      cur.created_at,
        },
      });
      res.json({ success: true });
      return;
    }

    // DELETE — мягкое или полное удаление
    if (req.method === 'DELETE') {
      const id   = req.url.split('/').filter(Boolean).pop().split('?')[0];
      const hard = req.query.hard === 'true';
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      if (hard) {
        const filesTable = `\`${PROJECT}.${DATASET}.transaction_files\``;
        await bigquery.query({ query: `DELETE FROM ${filesTable} WHERE transaction_id = @id`, params: { id } });
        await bigquery.query({ query: `DELETE FROM ${table} WHERE id = @id`, params: { id } });
      } else {
        // Мягкое удаление — обновляем статус через DELETE+INSERT
        const [rows] = await bigquery.query({
          query: `SELECT date, amount, direction, account_id, counterparty_id, category_id,
                         invoice_id, folder_id, description,
                         FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', created_at) as created_at
                  FROM ${table} WHERE id = @id`,
          params: { id },
        });
        if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
        const cur = rows[0];

        await bigquery.query({ query: `DELETE FROM ${table} WHERE id = @id`, params: { id } });
        await bigquery.query({
          query: `INSERT INTO ${table} (id, date, amount, direction, account_id, counterparty_id, category_id, invoice_id, folder_id, description, status, created_at)
                  VALUES (@id, @date, @amount, @direction, NULLIF(@account_id,''), NULLIF(@counterparty_id,''), NULLIF(@category_id,''), NULLIF(@invoice_id,''), NULLIF(@folder_id,''), @description, 'deleted', TIMESTAMP(@created_at))`,
          params: {
            id,
            date:            cur.date,
            amount:          cur.amount,
            direction:       cur.direction,
            account_id:      cur.account_id      || '',
            counterparty_id: cur.counterparty_id || '',
            category_id:     cur.category_id     || '',
            invoice_id:      cur.invoice_id      || '',
            folder_id:       cur.folder_id       || '',
            description:     cur.description     || '',
            created_at:      cur.created_at,
          },
        });
      }

      res.json({ success: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });

  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
