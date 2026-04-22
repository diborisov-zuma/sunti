const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'bank_statement_lines';
const TRX_TABLE = 'transactions';

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
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

async function getUser(email) {
  const [rows] = await bigquery.query({
    query: `SELECT email, is_admin FROM \`${PROJECT}.${DATASET}.users\` WHERE email = @email`,
    params: { email },
  });
  return rows[0] || null;
}

async function getCompanyAccess(email, company_id) {
  const [rows] = await bigquery.query({
    query: `SELECT statement_access FROM \`${PROJECT}.${DATASET}.users_statements\`
            WHERE user_email = @email AND company_id = @company_id`,
    params: { email, company_id },
  });
  return rows[0]?.statement_access || 'none';
}

/**
 * Recalc invoice paid_amount (same logic as in transactions function).
 */
async function recalcInvoicePaid(invoiceId) {
  if (!invoiceId) return;
  const invTable = `\`${PROJECT}.${DATASET}.invoices\``;
  const trxTable = `\`${PROJECT}.${DATASET}.${TRX_TABLE}\``;
  const [invRows] = await bigquery.query({
    query: `SELECT direction FROM ${invTable} WHERE id = @id`,
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
}

exports.bank_statement_lines = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table    = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const trxTable = `\`${PROJECT}.${DATASET}.${TRX_TABLE}\``;
  const path     = (req.url || '').split('?')[0];
  const user     = await getUser(email);
  if (!user) { res.status(403).json({ error: 'Forbidden' }); return; }

  try {
    // ─── GET /bank_statement_lines?statement_id=X ───
    // Также поддерживает: account_id, match_status, date_from, date_to
    if (req.method === 'GET') {
      const { statement_id, account_id, company_id, match_status, date_from, date_to } = req.query;
      if (!statement_id && !account_id && !company_id) {
        res.status(400).json({ error: 'statement_id, account_id or company_id is required' });
        return;
      }

      let where = 'WHERE l.status = \'active\'';
      const params = {};

      if (statement_id) {
        where += ' AND l.statement_id = @statement_id';
        params.statement_id = statement_id;
      }
      if (account_id) {
        where += ' AND l.account_id = @account_id';
        params.account_id = account_id;
      }
      if (company_id) {
        where += ' AND l.company_id = @company_id';
        params.company_id = company_id;
      }
      if (match_status) {
        where += ' AND l.match_status = @match_status';
        params.match_status = match_status;
      }
      if (date_from) { where += ' AND l.date >= @date_from'; params.date_from = date_from; }
      if (date_to)   { where += ' AND l.date <= @date_to';   params.date_to   = date_to; }

      // RBAC check: нужен company_id для проверки доступа
      // Берём из первого параметра, где он есть
      let rbacCompanyId = company_id;
      if (!rbacCompanyId && statement_id) {
        const [stRows] = await bigquery.query({
          query: `SELECT company_id FROM \`${PROJECT}.${DATASET}.bank_statements\` WHERE id = @id`,
          params: { id: statement_id },
        });
        rbacCompanyId = stRows[0]?.company_id;
      }
      if (rbacCompanyId && !user.is_admin) {
        const acc = await getCompanyAccess(email, rbacCompanyId);
        if (acc === 'none') { res.status(403).json({ error: 'Forbidden' }); return; }
      }

      const [rows] = await bigquery.query({
        query: `SELECT l.id, l.statement_id, l.account_id, l.company_id,
                       l.line_number, l.date, l.value_date, l.amount, l.direction,
                       l.description, l.counterparty, l.reference, l.running_balance,
                       l.currency, l.transaction_id, l.match_status,
                       l.matched_by, l.matched_at, l.imported_at,
                       t.description AS transaction_description,
                       t.category_id AS transaction_category_id,
                       t.folder_id   AS transaction_folder_id
                FROM ${table} l
                LEFT JOIN ${trxTable} t ON l.transaction_id = t.id
                ${where}
                ORDER BY l.line_number ASC`,
        params,
      });
      res.json(rows);
      return;
    }

    // ─── PATCH /bank_statement_lines/<id>/match ───
    // Body: { transaction_id }
    if (req.method === 'PATCH' && path.endsWith('/match')) {
      const id = path.split('/').filter(Boolean)[0];
      const { transaction_id } = req.body || {};
      if (!id || !transaction_id) {
        res.status(400).json({ error: 'id and transaction_id are required' });
        return;
      }

      // Читаем строку
      const [lineRows] = await bigquery.query({
        query: `SELECT account_id, company_id, match_status FROM ${table} WHERE id = @id AND status = 'active'`,
        params: { id },
      });
      if (!lineRows.length) { res.status(404).json({ error: 'Line not found' }); return; }
      const line = lineRows[0];

      // RBAC
      if (!user.is_admin) {
        const acc = await getCompanyAccess(email, line.company_id);
        if (acc !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }
      }

      // Проверяем транзакцию
      const [trxRows] = await bigquery.query({
        query: `SELECT id, account_id FROM ${trxTable} WHERE id = @id AND IFNULL(status, 'active') != 'deleted'`,
        params: { id: transaction_id },
      });
      if (!trxRows.length) { res.status(404).json({ error: 'Transaction not found' }); return; }

      // Инвариант: account_id должен совпадать
      if (trxRows[0].account_id && line.account_id && trxRows[0].account_id !== line.account_id) {
        res.status(400).json({ error: 'account_id mismatch between line and transaction' });
        return;
      }

      // Обновляем строку
      await bigquery.query({
        query: `UPDATE ${table}
                SET transaction_id = @transaction_id,
                    match_status   = 'matched',
                    matched_by     = @email,
                    matched_at     = CURRENT_TIMESTAMP()
                WHERE id = @id`,
        params: { id, transaction_id, email },
      });

      // Обратная ссылка в transactions
      await bigquery.query({
        query: `UPDATE ${trxTable} SET statement_line_id = @line_id WHERE id = @trx_id`,
        params: { line_id: id, trx_id: transaction_id },
      });

      res.json({ success: true });
      return;
    }

    // ─── PATCH /bank_statement_lines/<id>/unmatch ───
    if (req.method === 'PATCH' && path.endsWith('/unmatch')) {
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      const [lineRows] = await bigquery.query({
        query: `SELECT company_id, transaction_id, match_status FROM ${table} WHERE id = @id AND status = 'active'`,
        params: { id },
      });
      if (!lineRows.length) { res.status(404).json({ error: 'Line not found' }); return; }
      const line = lineRows[0];

      if (!user.is_admin) {
        const acc = await getCompanyAccess(email, line.company_id);
        if (acc !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }
      }

      if (line.match_status !== 'matched' && line.match_status !== 'manual_created') {
        res.status(400).json({ error: 'Line is not matched' });
        return;
      }

      // Очищаем обратную ссылку в transactions
      if (line.transaction_id) {
        await bigquery.query({
          query: `UPDATE ${trxTable} SET statement_line_id = NULL WHERE id = @trx_id`,
          params: { trx_id: line.transaction_id },
        });
      }

      // Сбрасываем матчинг
      await bigquery.query({
        query: `UPDATE ${table}
                SET transaction_id = NULL,
                    match_status   = 'unmatched',
                    matched_by     = NULL,
                    matched_at     = NULL
                WHERE id = @id`,
        params: { id },
      });

      res.json({ success: true });
      return;
    }

    // ─── PATCH /bank_statement_lines/<id>/ignore ───
    if (req.method === 'PATCH' && path.endsWith('/ignore')) {
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      const [lineRows] = await bigquery.query({
        query: `SELECT company_id, match_status FROM ${table} WHERE id = @id AND status = 'active'`,
        params: { id },
      });
      if (!lineRows.length) { res.status(404).json({ error: 'Line not found' }); return; }

      if (!user.is_admin) {
        const acc = await getCompanyAccess(email, lineRows[0].company_id);
        if (acc !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }
      }

      await bigquery.query({
        query: `UPDATE ${table}
                SET match_status = 'ignored',
                    matched_by   = @email,
                    matched_at   = CURRENT_TIMESTAMP()
                WHERE id = @id`,
        params: { id, email },
      });

      res.json({ success: true });
      return;
    }

    // ─── PATCH /bank_statement_lines/<id>/unignore ───
    if (req.method === 'PATCH' && path.endsWith('/unignore')) {
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      const [lineRows] = await bigquery.query({
        query: `SELECT company_id, match_status FROM ${table} WHERE id = @id AND status = 'active'`,
        params: { id },
      });
      if (!lineRows.length) { res.status(404).json({ error: 'Line not found' }); return; }

      if (!user.is_admin) {
        const acc = await getCompanyAccess(email, lineRows[0].company_id);
        if (acc !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }
      }

      await bigquery.query({
        query: `UPDATE ${table}
                SET match_status = 'unmatched',
                    matched_by   = NULL,
                    matched_at   = NULL
                WHERE id = @id`,
        params: { id, email },
      });

      res.json({ success: true });
      return;
    }

    // ─── POST /bank_statement_lines/<id>/create-transaction ───
    // Создаёт транзакцию из строки выписки и сразу линкует.
    // Body: { category_id, folder_id, description?, account_id? }
    if (req.method === 'POST' && path.endsWith('/create-transaction')) {
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      const { category_id, folder_id, description: descOverride, account_id: accOverride } = req.body || {};
      if (!category_id || !folder_id) {
        res.status(400).json({ error: 'category_id and folder_id are required' });
        return;
      }

      // Читаем строку выписки
      const [lineRows] = await bigquery.query({
        query: `SELECT * FROM ${table} WHERE id = @id AND status = 'active'`,
        params: { id },
      });
      if (!lineRows.length) { res.status(404).json({ error: 'Line not found' }); return; }
      const line = lineRows[0];

      if (line.match_status === 'matched' || line.match_status === 'manual_created') {
        res.status(400).json({ error: 'Line is already matched' });
        return;
      }

      // RBAC
      if (!user.is_admin) {
        const acc = await getCompanyAccess(email, line.company_id);
        if (acc !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }
      }

      const trxId = uuidv4();
      const accountId = accOverride || line.account_id;
      const trxDesc = descOverride || line.description || '';

      // Создаём транзакцию
      await bigquery.query({
        query: `INSERT INTO ${trxTable}
                  (id, date, amount, direction, account_id, category_id, folder_id,
                   description, statement_line_id, created_at)
                VALUES
                  (@id, @date, CAST(@amount AS NUMERIC), @direction, NULLIF(@account_id,''),
                   NULLIF(@category_id,''), NULLIF(@folder_id,''),
                   @description, @line_id, CURRENT_TIMESTAMP())`,
        params: {
          id: trxId,
          date: line.date?.value || line.date,
          amount: parseFloat(line.amount),
          direction: line.direction,
          account_id: accountId || '',
          category_id: category_id || '',
          folder_id: folder_id || '',
          description: trxDesc,
          line_id: id,
        },
      });

      // Обновляем строку выписки
      await bigquery.query({
        query: `UPDATE ${table}
                SET transaction_id = @trx_id,
                    match_status   = 'manual_created',
                    matched_by     = @email,
                    matched_at     = CURRENT_TIMESTAMP()
                WHERE id = @id`,
        params: { id, trx_id: trxId, email },
      });

      res.json({ success: true, transaction_id: trxId });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
