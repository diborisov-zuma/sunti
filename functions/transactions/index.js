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

async function recalcContractPaid(contractId) {
  if (!contractId) return;
  const cTable = `\`${PROJECT}.${DATASET}.contracts\``;
  const iTable = `\`${PROJECT}.${DATASET}.invoices\``;
  const tTable = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  // paid = SUM(invoice paid amounts) + SUM(direct contract transactions without invoice)
  await bigquery.query({
    query: `UPDATE ${cTable}
            SET paid_amount = CAST((
              COALESCE((SELECT SUM(paid_amount) FROM ${iTable}
                WHERE contract_id = @id AND IFNULL(status, 'active') != 'deleted'), 0)
              + COALESCE((SELECT SUM(amount) FROM ${tTable}
                WHERE contract_id = @id AND invoice_id IS NULL AND IFNULL(status, 'active') != 'deleted'), 0)
            ) AS NUMERIC)
            WHERE id = @id`,
    params: { id: contractId },
  });
}

async function recalcInvoicePaid(invoiceId) {
  if (!invoiceId) return;
  const invTable = `\`${PROJECT}.${DATASET}.invoices\``;
  const trxTable = `\`${PROJECT}.${DATASET}.transactions\``;
  const [invRows] = await bigquery.query({
    query: `SELECT direction, contract_id FROM ${invTable} WHERE id = @id`,
    params: { id: invoiceId },
  });
  if (!invRows.length) return;
  const dir = invRows[0].direction || 'expense';
  await bigquery.query({
    query: `UPDATE ${invTable}
            SET paid_amount = IFNULL((
              SELECT SUM(CASE WHEN direction = @dir THEN amount ELSE -amount END)
              FROM ${trxTable}
              WHERE invoice_id = @id AND IFNULL(status, 'active') != 'deleted'
            ), 0)
            WHERE id = @id`,
    params: { id: invoiceId, dir },
  });

  // Cascade to contract
  if (invRows[0].contract_id) {
    await recalcContractPaid(invRows[0].contract_id);
  }
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
      const folderIds = (req.query.folder_ids || '').split(',').map(s => s.trim()).filter(Boolean);
      const status    = req.query.status || 'active';

      let where = '';
      const params = {};
      const statusClause = status === 'deleted'
        ? 'IFNULL(t.status, \'active\') = \'deleted\''
        : 'IFNULL(t.status, \'active\') != \'deleted\'';

      const { amount_min, amount_max, category_id, search } = req.query;
      const extras = [];
      if (amount_min) { extras.push(`t.amount >= @amount_min`); params.amount_min = parseFloat(amount_min); }
      if (amount_max) { extras.push(`t.amount <= @amount_max`); params.amount_max = parseFloat(amount_max); }
      if (req.query.date_from) { extras.push(`t.date >= @date_from`); params.date_from = req.query.date_from; }
      if (req.query.date_to)   { extras.push(`t.date <= @date_to`);   params.date_to   = req.query.date_to; }
      if (req.query.only_unlinked) extras.push(`t.invoice_id IS NULL`);
      if (category_id) { extras.push(`t.category_id = @cat_id`); params.cat_id = category_id; }
      if (search) { extras.push(`LOWER(t.description) LIKE LOWER(@search)`); params.search = `%${search.trim()}%`; }
      const extraClause = extras.length ? ' AND ' + extras.join(' AND ') : '';

      const contractId = req.query.contract_id;
      if (contractId) {
        where = `WHERE t.contract_id = @contract_id AND t.invoice_id IS NULL AND ${statusClause}` + extraClause;
        params.contract_id = contractId;
      } else if (invoiceId) {
        where = `WHERE t.invoice_id = @invoice_id AND ${statusClause}` + extraClause;
        params.invoice_id = invoiceId;
      } else if (folderId) {
        where = `WHERE t.folder_id = @folder_id AND ${statusClause}` + extraClause;
        params.folder_id = folderId;
      } else if (folderIds.length) {
        where = `WHERE t.folder_id IN UNNEST(@folder_ids) AND ${statusClause}` + extraClause;
        params.folder_ids = folderIds;
      } else {
        res.status(400).json({ error: 'invoice_id, folder_id or folder_ids is required' });
        return;
      }

      const accTable = `\`${PROJECT}.${DATASET}.company_accounts\``;
      const [rows] = await bigquery.query({
        query: `SELECT t.id, t.date, t.amount, t.direction, t.account_id,
                       t.counterparty_id, t.category_id, t.invoice_id, t.folder_id,
                       t.contractor_id, t.description, t.created_at, t.statement_line_id,
                       IFNULL(t.status, 'active') AS status,
                       c.name as category_name,
                       a.name as account_name,
                       ct.name_en as contractor_name_en, ct.name_th as contractor_name_th
                FROM ${table} t
                LEFT JOIN ${catTable} c ON t.category_id = c.id
                LEFT JOIN ${accTable} a ON t.account_id  = a.id
                LEFT JOIN \`${PROJECT}.${DATASET}.contractors\` ct ON t.contractor_id = ct.id
                ${where}
                ORDER BY t.date DESC`,
        params,
      });
      res.json(rows);
      return;
    }

    // POST — создать транзакцию
    if (req.method === 'POST') {
      const { date, amount, direction, account_id, counterparty_id, category_id, invoice_id, folder_id, contractor_id, contract_id, description } = req.body;
      if (!date || !amount || !direction) {
        res.status(400).json({ error: 'date, amount and direction are required' });
        return;
      }
      if (parseFloat(amount) < 0) { res.status(400).json({ error: 'amount must be non-negative' }); return; }
      if (invoice_id) {
        const [invRows] = await bigquery.query({
          query: `SELECT folder_id FROM \`${PROJECT}.${DATASET}.invoices\` WHERE id = @id`,
          params: { id: invoice_id },
        });
        if (!invRows.length) { res.status(400).json({ error: 'invoice not found' }); return; }
        if (folder_id && invRows[0].folder_id !== folder_id) {
          res.status(400).json({ error: 'transaction.folder_id must match invoice.folder_id' });
          return;
        }
      }
      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table} (id, date, amount, direction, account_id, counterparty_id, category_id, invoice_id, folder_id, contractor_id, contract_id, description, created_at)
                VALUES (@id, @date, CAST(@amount AS NUMERIC), @direction, NULLIF(@account_id,''), NULLIF(@counterparty_id,''), NULLIF(@category_id,''), NULLIF(@invoice_id,''), NULLIF(@folder_id,''), NULLIF(@contractor_id,''), NULLIF(@contract_id,''), @description, CURRENT_TIMESTAMP())`,
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
          contractor_id:   contractor_id   || '',
          contract_id:     contract_id     || '',
          description:     description     || '',
        },
      });
      if (invoice_id) await recalcInvoicePaid(invoice_id);
      if (contract_id) await recalcContractPaid(contract_id);
      res.json({ success: true, id });
      return;
    }

    // PUT — редактировать транзакцию
    if (req.method === 'PUT') {
      const id = req.url.split('/').filter(Boolean).pop().split('?')[0];
      const { date, amount, direction, account_id, counterparty_id, category_id, folder_id, invoice_id, contractor_id, description } = req.body;
      if (!id || !date || !amount) { res.status(400).json({ error: 'id, date and amount are required' }); return; }
      if (parseFloat(amount) < 0) { res.status(400).json({ error: 'amount must be non-negative' }); return; }
      if (invoice_id) {
        const [invRows] = await bigquery.query({
          query: `SELECT folder_id FROM \`${PROJECT}.${DATASET}.invoices\` WHERE id = @id`,
          params: { id: invoice_id },
        });
        if (!invRows.length) { res.status(400).json({ error: 'invoice not found' }); return; }
        const targetFolder = folder_id || invRows[0].folder_id;
        if (targetFolder !== invRows[0].folder_id) {
          res.status(400).json({ error: 'transaction.folder_id must match invoice.folder_id' });
          return;
        }
      }

      const [rows] = await bigquery.query({
        query: `SELECT invoice_id, folder_id, contractor_id, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', created_at) as created_at FROM ${table} WHERE id = @id`,
        params: { id },
      });
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      const cur = rows[0];

      await bigquery.query({ query: `DELETE FROM ${table} WHERE id = @id`, params: { id } });
      await bigquery.query({
        query: `INSERT INTO ${table} (id, date, amount, direction, account_id, counterparty_id, category_id, invoice_id, folder_id, contractor_id, description, created_at)
                VALUES (@id, @date, CAST(@amount AS NUMERIC), @direction, NULLIF(@account_id,''), NULLIF(@counterparty_id,''), NULLIF(@category_id,''), NULLIF(@invoice_id,''), NULLIF(@folder_id,''), NULLIF(@contractor_id,''), @description, TIMESTAMP(@created_at))`,
        params: {
          id,
          date,
          amount:          parseFloat(amount),
          direction,
          account_id:      account_id      || '',
          counterparty_id: counterparty_id || '',
          category_id:     category_id     || '',
          invoice_id:      (invoice_id !== undefined ? (invoice_id || '') : (cur.invoice_id || '')),
          folder_id:       folder_id       || cur.folder_id || '',
          contractor_id:   (contractor_id !== undefined ? (contractor_id || '') : (cur.contractor_id || '')),
          description:     description     || '',
          created_at:      cur.created_at,
        },
      });
      const oldInv = cur.invoice_id || '';
      const newInv = (invoice_id !== undefined ? (invoice_id || '') : oldInv);
      if (oldInv) await recalcInvoicePaid(oldInv);
      if (newInv && newInv !== oldInv) await recalcInvoicePaid(newInv);
      res.json({ success: true });
      return;
    }

    // DELETE — мягкое или полное удаление
    if (req.method === 'DELETE') {
      const id   = req.url.split('/').filter(Boolean).pop().split('?')[0];
      const hard = req.query.hard === 'true';
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      // сохраняем invoice_id ДО изменений для recalc
      const [preRows] = await bigquery.query({
        query: `SELECT invoice_id FROM ${table} WHERE id = @id`, params: { id },
      });
      const linkedInv = preRows[0]?.invoice_id || '';

      if (hard) {
        const filesTable = `\`${PROJECT}.${DATASET}.transaction_files\``;
        await bigquery.query({ query: `DELETE FROM ${filesTable} WHERE transaction_id = @id`, params: { id } });
        await bigquery.query({ query: `DELETE FROM ${table} WHERE id = @id`, params: { id } });
      } else {
        // Мягкое удаление — обновляем статус через DELETE+INSERT
        const [rows] = await bigquery.query({
          query: `SELECT date, amount, direction, account_id, counterparty_id, category_id,
                         invoice_id, folder_id, contractor_id, description,
                         FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%S', created_at) as created_at
                  FROM ${table} WHERE id = @id`,
          params: { id },
        });
        if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
        const cur = rows[0];

        await bigquery.query({ query: `DELETE FROM ${table} WHERE id = @id`, params: { id } });
        await bigquery.query({
          query: `INSERT INTO ${table} (id, date, amount, direction, account_id, counterparty_id, category_id, invoice_id, folder_id, contractor_id, description, status, created_at)
                  VALUES (@id, @date, CAST(@amount AS NUMERIC), @direction, NULLIF(@account_id,''), NULLIF(@counterparty_id,''), NULLIF(@category_id,''), NULLIF(@invoice_id,''), NULLIF(@folder_id,''), NULLIF(@contractor_id,''), @description, 'deleted', TIMESTAMP(@created_at))`,
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
            contractor_id:   cur.contractor_id   || '',
            description:     cur.description     || '',
            created_at:      cur.created_at,
          },
        });
      }
      if (linkedInv) await recalcInvoicePaid(linkedInv);

      res.json({ success: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });

  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
