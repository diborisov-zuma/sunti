const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'sales_payments';

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

async function getUser(email) {
  const [rows] = await bigquery.query({
    query: `SELECT u.email, u.is_admin,
                   (SELECT COUNT(*) FROM \`${PROJECT}.${DATASET}.users_folders\`
                    WHERE user_email = u.email AND docs_access = 'editor') AS editor_count
            FROM \`${PROJECT}.${DATASET}.users\` u WHERE u.email = @email`,
    params: { email },
  });
  if (!rows[0]) return null;
  rows[0].can_edit = rows[0].is_admin === true || parseInt(rows[0].editor_count) > 0;
  return rows[0];
}

// Cascade: payment → schedule.paid_amount → contract.paid_amount → sale.paid_amount
async function cascadeRecalc(contractId, scheduleId) {
  // 1. Recalc schedule paid_amount + status
  if (scheduleId) {
    await bigquery.query({
      query: `UPDATE \`${PROJECT}.${DATASET}.payment_schedules\`
              SET paid_amount = CAST(COALESCE((
                SELECT SUM(CAST(amount AS NUMERIC))
                FROM \`${PROJECT}.${DATASET}.${TABLE}\`
                WHERE schedule_id = @scheduleId AND status = 'confirmed'
              ), 0) AS NUMERIC),
              status = CASE
                WHEN CAST(COALESCE((
                  SELECT SUM(CAST(amount AS NUMERIC))
                  FROM \`${PROJECT}.${DATASET}.${TABLE}\`
                  WHERE schedule_id = @scheduleId AND status = 'confirmed'
                ), 0) AS NUMERIC) >= amount THEN 'paid'
                WHEN CAST(COALESCE((
                  SELECT SUM(CAST(amount AS NUMERIC))
                  FROM \`${PROJECT}.${DATASET}.${TABLE}\`
                  WHERE schedule_id = @scheduleId AND status = 'confirmed'
                ), 0) AS NUMERIC) > 0 THEN 'partially_paid'
                WHEN due_date < CURRENT_DATE() THEN 'overdue'
                ELSE 'upcoming'
              END
              WHERE id = @scheduleId`,
      params: { scheduleId },
    });
  }

  // 2. Recalc contract paid_amount
  await bigquery.query({
    query: `UPDATE \`${PROJECT}.${DATASET}.sales_contracts\`
            SET paid_amount = CAST(COALESCE((
              SELECT SUM(CAST(amount AS NUMERIC))
              FROM \`${PROJECT}.${DATASET}.${TABLE}\`
              WHERE contract_id = @contractId AND status = 'confirmed'
            ), 0) AS NUMERIC)
            WHERE id = @contractId`,
    params: { contractId },
  });

  // 3. Recalc sale paid_amount
  const [sc] = await bigquery.query({
    query: `SELECT sale_id FROM \`${PROJECT}.${DATASET}.sales_contracts\` WHERE id = @contractId`,
    params: { contractId },
  });
  const saleId = sc[0]?.sale_id;
  if (saleId) {
    await bigquery.query({
      query: `UPDATE \`${PROJECT}.${DATASET}.sales\`
              SET paid_amount = CAST(COALESCE((
                SELECT SUM(CAST(COALESCE(paid_amount, 0) AS NUMERIC))
                FROM \`${PROJECT}.${DATASET}.sales_contracts\`
                WHERE sale_id = @saleId AND status != 'terminated'
              ), 0) AS NUMERIC)
              WHERE id = @saleId`,
      params: { saleId },
    });
  }
}

exports.sales_payments = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const user = await getUser(email);
  if (!user) { res.status(403).json({ error: 'Forbidden' }); return; }

  const urlParts = (req.url || '').split('/').filter(Boolean);

  try {
    // GET — list payments for a contract
    if (req.method === 'GET') {
      const { contract_id, sale_id } = req.query;

      let where = 'WHERE 1=1';
      const params = {};
      if (contract_id) { where += ' AND sp.contract_id = @contract_id'; params.contract_id = contract_id; }
      if (sale_id) {
        where += ` AND sp.contract_id IN (
          SELECT id FROM \`${PROJECT}.${DATASET}.sales_contracts\` WHERE sale_id = @sale_id
        )`;
        params.sale_id = sale_id;
      }

      const [rows] = await bigquery.query({
        query: `SELECT sp.*,
                  ps.name AS schedule_name, ps.milestone_type,
                  ca.name AS account_name, ca.bank_name
                FROM ${table} sp
                LEFT JOIN \`${PROJECT}.${DATASET}.payment_schedules\` ps ON ps.id = sp.schedule_id
                LEFT JOIN \`${PROJECT}.${DATASET}.company_accounts\` ca ON ca.id = sp.account_id
                ${where}
                ORDER BY sp.payment_date DESC, sp.created_at DESC`,
        params,
      });
      res.json(rows);
      return;
    }

    // POST — create payment
    if (req.method === 'POST') {
      if (!user.can_edit) { res.status(403).json({ error: 'Forbidden' }); return; }
      const b = req.body || {};
      if (!b.contract_id || !b.amount || !b.payment_date) {
        res.status(400).json({ error: 'contract_id, amount and payment_date are required' });
        return;
      }

      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table}
                  (id, contract_id, schedule_id, amount, payment_date,
                   payment_method, reference, account_id, receipt_number,
                   status, notes, created_by, created_at)
                VALUES
                  (@id, @contract_id, NULLIF(@schedule_id,''),
                   CAST(@amount AS NUMERIC),
                   CAST(@payment_date AS DATE),
                   NULLIF(@payment_method,''), NULLIF(@reference,''),
                   NULLIF(@account_id,''), NULLIF(@receipt_number,''),
                   @status, NULLIF(@notes,''),
                   @created_by, CURRENT_TIMESTAMP())`,
        params: {
          id,
          contract_id:    b.contract_id,
          schedule_id:    b.schedule_id || '',
          amount:         String(b.amount),
          payment_date:   b.payment_date,
          payment_method: b.payment_method || '',
          reference:      b.reference || '',
          account_id:     b.account_id || '',
          receipt_number: b.receipt_number || '',
          status:         b.status || 'confirmed',
          notes:          b.notes || '',
          created_by:     email,
        },
      });

      await cascadeRecalc(b.contract_id, b.schedule_id || null);
      res.json({ success: true, id });
      return;
    }

    // PUT — update
    if (req.method === 'PUT') {
      if (!user.can_edit) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = urlParts[urlParts.length - 1];
      const b = req.body || {};
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      // Get old data for recalc
      const [old] = await bigquery.query({
        query: `SELECT contract_id, schedule_id FROM ${table} WHERE id = @id`,
        params: { id },
      });
      const oldRow = old[0];

      await bigquery.query({
        query: `UPDATE ${table}
                SET schedule_id     = NULLIF(@schedule_id,''),
                    amount          = CAST(@amount AS NUMERIC),
                    payment_date    = CAST(@payment_date AS DATE),
                    payment_method  = NULLIF(@payment_method,''),
                    reference       = NULLIF(@reference,''),
                    account_id      = NULLIF(@account_id,''),
                    receipt_number  = NULLIF(@receipt_number,''),
                    status          = @status,
                    notes           = NULLIF(@notes,'')
                WHERE id = @id`,
        params: {
          id,
          schedule_id:    b.schedule_id || '',
          amount:         String(b.amount || 0),
          payment_date:   b.payment_date,
          payment_method: b.payment_method || '',
          reference:      b.reference || '',
          account_id:     b.account_id || '',
          receipt_number: b.receipt_number || '',
          status:         b.status || 'confirmed',
          notes:          b.notes || '',
        },
      });

      // Recalc old and new schedules
      if (oldRow) {
        await cascadeRecalc(oldRow.contract_id, oldRow.schedule_id);
        if (b.schedule_id && b.schedule_id !== oldRow.schedule_id) {
          await cascadeRecalc(oldRow.contract_id, b.schedule_id);
        }
      }
      res.json({ success: true });
      return;
    }

    // DELETE
    if (req.method === 'DELETE') {
      if (!user.can_edit) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = urlParts[urlParts.length - 1];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      const [old] = await bigquery.query({
        query: `SELECT contract_id, schedule_id FROM ${table} WHERE id = @id`,
        params: { id },
      });
      const oldRow = old[0];

      await bigquery.query({ query: `DELETE FROM ${table} WHERE id = @id`, params: { id } });

      if (oldRow) await cascadeRecalc(oldRow.contract_id, oldRow.schedule_id);
      res.json({ success: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
