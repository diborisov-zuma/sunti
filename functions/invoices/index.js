const { BigQuery } = require('@google-cloud/bigquery');
const { Storage }  = require('@google-cloud/storage');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const storage  = new Storage();

async function deleteGcsFiles(urls) {
  for (const url of urls) {
    if (!url) continue;
    const m = url.match(/^https:\/\/storage\.googleapis\.com\/([^/]+)\/(.+)$/);
    if (!m) continue;
    try {
      await storage.bucket(m[1]).file(decodeURIComponent(m[2])).delete({ ignoreNotFound: true });
    } catch (e) {
      console.error('GCS delete failed', url, e.message);
    }
  }
}
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
      const folderIds  = (req.query.folder_ids || '').split(',').map(s => s.trim()).filter(Boolean);
      const status     = req.query.status;
      const categoryId = req.query.category_id;
      const search     = (req.query.search || '').trim();
      const dateFrom   = req.query.date_from;
      const dateTo     = req.query.date_to;
      const limit      = parseInt(req.query.limit  || 25);
      const offset     = parseInt(req.query.offset || 0);

      if (!folderId && !folderIds.length) { res.status(400).json({ error: 'folder_id or folder_ids is required' }); return; }

      const catTable = `\`${PROJECT}.${DATASET}.categories\``;

      let where, params;
      if (folderId) {
        where = `WHERE i.folder_id = @folder_id`;
        params = { folder_id: folderId };
      } else {
        where = `WHERE i.folder_id IN UNNEST(@folder_ids)`;
        params = { folder_ids: folderIds };
      }

      if (status && status !== 'all') {
        where += ` AND i.status = @status`;
        params.status = status;
      } else {
        // По умолчанию скрываем удалённые
        where += ` AND i.status != 'deleted'`;
      }

      if (categoryId && categoryId !== 'all') {
        where += ` AND i.category_id = @category_id`;
        params.category_id = categoryId;
      }

      if (search) {
        where += ` AND LOWER(i.name) LIKE LOWER(@search)`;
        params.search = `%${search}%`;
      }

      if (dateFrom) { where += ` AND i.date >= @date_from`; params.date_from = dateFrom; }
      if (dateTo)   { where += ` AND i.date <= @date_to`;   params.date_to   = dateTo; }

      const trxTable = `\`${PROJECT}.${DATASET}.transactions\``;
      const [rows] = await bigquery.query({
        query: `SELECT i.id, i.folder_id, i.name, i.status, i.direction, i.total_amount, i.paid_amount,
                       i.category_id, i.contractor_id, i.uploaded_by, i.uploaded_at, i.date,
                       c.name as category_name,
                       ct.name_en as contractor_name_en, ct.name_th as contractor_name_th,
                       (SELECT COUNT(*) FROM ${trxTable} t
                        WHERE t.invoice_id = i.id AND IFNULL(t.status, 'active') != 'deleted') AS trx_count
                FROM ${table} i
                LEFT JOIN ${catTable} c ON i.category_id = c.id
                LEFT JOIN \`${PROJECT}.${DATASET}.contractors\` ct ON i.contractor_id = ct.id
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
      const { folder_id, name, status, direction, total_amount, paid_amount, category_id, contractor_id, date } = req.body;
      if (!folder_id || !name) { res.status(400).json({ error: 'folder_id and name are required' }); return; }
      if (parseFloat(total_amount || 0) < 0 || parseFloat(paid_amount || 0) < 0) { res.status(400).json({ error: 'amounts must be non-negative' }); return; }
      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table} (id, folder_id, name, status, direction, total_amount, paid_amount, category_id, contractor_id, date, uploaded_by, uploaded_at)
                VALUES (@id, @folder_id, @name, @status, @direction, CAST(@total_amount AS NUMERIC), CAST(@paid_amount AS NUMERIC), NULLIF(@category_id, ''), NULLIF(@contractor_id, ''), IF(@date = '', NULL, DATE(@date)), @uploaded_by, CURRENT_TIMESTAMP())`,
        params: {
          id, folder_id, name,
          status:        status     || 'active',
          direction:     direction  || 'expense',
          total_amount:  parseFloat(total_amount || 0),
          paid_amount:   parseFloat(paid_amount  || 0),
          category_id:   category_id || '',
          contractor_id: contractor_id || '',
          date:          date || '',
          uploaded_by:   email,
        },
      });
      res.json({ success: true, id });
      return;
    }

    // PUT — редактировать
    if (req.method === 'PUT') {
      const id = req.url.split('/').filter(Boolean).pop().split('?')[0];
      const { name, status, direction, total_amount, paid_amount, category_id, contractor_id, date } = req.body;
      if (!name || !id) { res.status(400).json({ error: 'name and id are required' }); return; }
      if (parseFloat(total_amount || 0) < 0 || parseFloat(paid_amount || 0) < 0) { res.status(400).json({ error: 'amounts must be non-negative' }); return; }

      const [rows] = await bigquery.query({
        query: `SELECT folder_id, uploaded_by, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', uploaded_at) as uploaded_at FROM ${table} WHERE id = @id`,
        params: { id },
      });
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      const cur = rows[0];

      await bigquery.query({ query: `DELETE FROM ${table} WHERE id = @id`, params: { id } });
      await bigquery.query({
        query: `INSERT INTO ${table} (id, folder_id, name, status, direction, total_amount, paid_amount, category_id, contractor_id, date, uploaded_by, uploaded_at)
                VALUES (@id, @folder_id, @name, @status, @direction, CAST(@total_amount AS NUMERIC), CAST(@paid_amount AS NUMERIC), NULLIF(@category_id, ''), NULLIF(@contractor_id, ''), IF(@date = '', NULL, DATE(@date)), @uploaded_by, TIMESTAMP(@uploaded_at))`,
        params: {
          id, folder_id: cur.folder_id, name,
          status:        status     || 'active',
          direction:     direction  || 'expense',
          total_amount:  parseFloat(total_amount || 0),
          paid_amount:   parseFloat(paid_amount  || 0),
          category_id:   category_id || '',
          contractor_id: contractor_id || '',
          date:          date || '',
          uploaded_by:   cur.uploaded_by,
          uploaded_at:   cur.uploaded_at,
        },
      });
      res.json({ success: true });
      return;
    }

    // DELETE — каскадное удаление: invoice_files + transactions + transaction_files
    if (req.method === 'DELETE') {
      const id   = req.url.split('/').filter(Boolean).pop().split('?')[0];
      const hard = req.query.hard === 'true';
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      const invFilesTable = `\`${PROJECT}.${DATASET}.invoice_files\``;
      const trxTable      = `\`${PROJECT}.${DATASET}.transactions\``;
      const trxFilesTable = `\`${PROJECT}.${DATASET}.transaction_files\``;

      if (hard) {
        // Собираем URL всех файлов — для физического удаления из GCS
        const [invFiles] = await bigquery.query({
          query: `SELECT file_url FROM ${invFilesTable} WHERE invoice_id = @id`,
          params: { id },
        });
        const [trxs] = await bigquery.query({
          query: `SELECT id FROM ${trxTable} WHERE invoice_id = @id`,
          params: { id },
        });
        const trxIds = trxs.map(t => t.id);

        let trxFiles = [];
        if (trxIds.length) {
          const [rows] = await bigquery.query({
            query: `SELECT file_url FROM ${trxFilesTable} WHERE transaction_id IN UNNEST(@ids)`,
            params: { ids: trxIds },
          });
          trxFiles = rows;
        }

        await deleteGcsFiles([
          ...invFiles.map(f => f.file_url),
          ...trxFiles.map(f => f.file_url),
        ]);

        if (trxIds.length) {
          await bigquery.query({
            query: `DELETE FROM ${trxFilesTable} WHERE transaction_id IN UNNEST(@ids)`,
            params: { ids: trxIds },
          });
          await bigquery.query({
            query: `DELETE FROM ${trxTable} WHERE invoice_id = @id`,
            params: { id },
          });
        }
        await bigquery.query({ query: `DELETE FROM ${invFilesTable} WHERE invoice_id = @id`, params: { id } });
        await bigquery.query({ query: `DELETE FROM ${table} WHERE id = @id`, params: { id } });
      } else {
        // Мягкое удаление: инвойс и его транзакции → status='deleted'. Файлы сохраняются.
        const [rows] = await bigquery.query({
          query: `SELECT folder_id, name, direction, total_amount, paid_amount, category_id, contractor_id, uploaded_by, date,
                         FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', uploaded_at) as uploaded_at
                  FROM ${table} WHERE id = @id`,
          params: { id },
        });
        if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
        const cur = rows[0];

        await bigquery.query({ query: `DELETE FROM ${table} WHERE id = @id`, params: { id } });
        await bigquery.query({
          query: `INSERT INTO ${table} (id, folder_id, name, status, direction, total_amount, paid_amount, category_id, contractor_id, date, uploaded_by, uploaded_at)
                  VALUES (@id, @folder_id, @name, 'deleted', @direction, CAST(@total_amount AS NUMERIC), CAST(@paid_amount AS NUMERIC), NULLIF(@category_id,''), NULLIF(@contractor_id,''), IF(@date = '', NULL, DATE(@date)), @uploaded_by, TIMESTAMP(@uploaded_at))`,
          params: {
            id,
            folder_id:     cur.folder_id,
            name:          cur.name,
            direction:     cur.direction    || 'expense',
            total_amount:  cur.total_amount || 0,
            paid_amount:   cur.paid_amount  || 0,
            category_id:   cur.category_id || '',
            contractor_id: cur.contractor_id || '',
            date:          cur.date ? (cur.date.value || cur.date) : '',
            uploaded_by:   cur.uploaded_by,
            uploaded_at:   cur.uploaded_at,
          },
        });

        // Каскад: все активные транзакции инвойса → status='deleted'
        await bigquery.query({
          query: `UPDATE ${trxTable}
                  SET status = 'deleted'
                  WHERE invoice_id = @id
                    AND IFNULL(status, 'active') != 'deleted'`,
          params: { id },
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
