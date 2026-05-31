const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'sales_contracts';

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function verifyToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.split(' ')[1];
  const r1 = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
  if (r1.ok) { const info = await r1.json(); return info.email || null; }
  const r2 = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
  if (r2.ok) { const info = await r2.json(); return info.email || null; }
  return null;
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

async function recalcContractPaid(contractId) {
  await bigquery.query({
    query: `UPDATE \`${PROJECT}.${DATASET}.${TABLE}\`
            SET paid_amount = CAST(COALESCE((
              SELECT SUM(CAST(amount AS NUMERIC))
              FROM \`${PROJECT}.${DATASET}.sales_payments\`
              WHERE contract_id = @contractId AND status = 'confirmed'
            ), 0) AS NUMERIC)
            WHERE id = @contractId`,
    params: { contractId },
  });
}

async function recalcSalePaid(saleId) {
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

exports.sales_contracts = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const user = await getUser(email);
  if (!user) { res.status(403).json({ error: 'Forbidden' }); return; }

  const urlParts = (req.url || '').split('/').filter(Boolean);

  try {
    // GET — list contracts for a sale
    if (req.method === 'GET') {
      const { sale_id } = req.query;
      if (!sale_id) { res.status(400).json({ error: 'sale_id is required' }); return; }

      const [rows] = await bigquery.query({
        query: `SELECT sc.*,
                  (SELECT COUNT(*) FROM \`${PROJECT}.${DATASET}.payment_schedules\` ps
                   WHERE ps.contract_id = sc.id) AS schedule_count,
                  (SELECT COUNT(*) FROM \`${PROJECT}.${DATASET}.sales_payments\` sp
                   WHERE sp.contract_id = sc.id AND sp.status = 'confirmed') AS payments_count
                FROM ${table} sc
                WHERE sc.sale_id = @sale_id
                ORDER BY sc.sort_order ASC, sc.date ASC`,
        params: { sale_id },
      });
      res.json(rows);
      return;
    }

    // POST — create
    if (req.method === 'POST') {
      if (!user.can_edit) { res.status(403).json({ error: 'Forbidden' }); return; }
      const b = req.body || {};
      if (!b.sale_id || !b.contract_type) {
        res.status(400).json({ error: 'sale_id and contract_type are required' });
        return;
      }
      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table}
                  (id, sale_id, contract_type, contract_number, name, date,
                   total_amount, paid_amount, status,
                   expected_completion, actual_completion, notes, sort_order,
                   created_by, created_at)
                VALUES
                  (@id, @sale_id, @contract_type, NULLIF(@contract_number,''),
                   NULLIF(@name,''),
                   IF(@date = '', NULL, CAST(@date AS DATE)),
                   CAST(@total_amount AS NUMERIC),
                   CAST('0' AS NUMERIC),
                   @status,
                   IF(@expected_completion = '', NULL, CAST(@expected_completion AS DATE)),
                   IF(@actual_completion = '', NULL, CAST(@actual_completion AS DATE)),
                   NULLIF(@notes,''), @sort_order,
                   @created_by, CURRENT_TIMESTAMP())`,
        params: {
          id,
          sale_id:              b.sale_id,
          contract_type:        b.contract_type,
          contract_number:      b.contract_number || '',
          name:                 b.name || '',
          date:                 b.date || '',
          total_amount:         String(b.total_amount || 0),
          status:               b.status || 'draft',
          expected_completion:  b.expected_completion || '',
          actual_completion:    b.actual_completion || '',
          notes:                b.notes || '',
          sort_order:           b.sort_order || 0,
          created_by:           email,
        },
      });
      // Recalc sale total
      await recalcSaleTotal(b.sale_id);
      res.json({ success: true, id });
      return;
    }

    // PUT — update
    if (req.method === 'PUT') {
      if (!user.can_edit) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = urlParts[urlParts.length - 1];
      const b = req.body || {};
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      // Get sale_id for recalc
      const [existing] = await bigquery.query({
        query: `SELECT sale_id FROM ${table} WHERE id = @id`, params: { id },
      });
      const saleId = existing[0]?.sale_id;

      await bigquery.query({
        query: `UPDATE ${table}
                SET contract_type       = @contract_type,
                    contract_number     = NULLIF(@contract_number,''),
                    name                = NULLIF(@name,''),
                    date                = IF(@date = '', NULL, CAST(@date AS DATE)),
                    total_amount        = CAST(@total_amount AS NUMERIC),
                    status              = @status,
                    expected_completion = IF(@expected_completion = '', NULL, CAST(@expected_completion AS DATE)),
                    actual_completion   = IF(@actual_completion = '', NULL, CAST(@actual_completion AS DATE)),
                    notes               = NULLIF(@notes,''),
                    sort_order          = @sort_order
                WHERE id = @id`,
        params: {
          id,
          contract_type:        b.contract_type || 'land_purchase',
          contract_number:      b.contract_number || '',
          name:                 b.name || '',
          date:                 b.date || '',
          total_amount:         String(b.total_amount || 0),
          status:               b.status || 'draft',
          expected_completion:  b.expected_completion || '',
          actual_completion:    b.actual_completion || '',
          notes:                b.notes || '',
          sort_order:           b.sort_order || 0,
        },
      });
      if (saleId) await recalcSaleTotal(saleId);
      res.json({ success: true });
      return;
    }

    // DELETE
    if (req.method === 'DELETE') {
      if (!user.can_edit) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = urlParts[urlParts.length - 1];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      const [existing] = await bigquery.query({
        query: `SELECT sale_id FROM ${table} WHERE id = @id`, params: { id },
      });
      const saleId = existing[0]?.sale_id;

      // Check payments
      const [pmt] = await bigquery.query({
        query: `SELECT COUNT(*) AS cnt FROM \`${PROJECT}.${DATASET}.sales_payments\`
                WHERE contract_id = @id AND status = 'confirmed'`,
        params: { id },
      });
      if (pmt[0] && parseInt(pmt[0].cnt) > 0) {
        res.status(400).json({ error: 'Cannot delete contract with confirmed payments' });
        return;
      }

      // Delete schedule + contract
      await bigquery.query({
        query: `DELETE FROM \`${PROJECT}.${DATASET}.payment_schedules\` WHERE contract_id = @id`,
        params: { id },
      });
      await bigquery.query({ query: `DELETE FROM ${table} WHERE id = @id`, params: { id } });

      if (saleId) await recalcSaleTotal(saleId);
      res.json({ success: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};

async function recalcSaleTotal(saleId) {
  await bigquery.query({
    query: `UPDATE \`${PROJECT}.${DATASET}.sales\`
            SET total_amount = CAST(COALESCE((
              SELECT SUM(CAST(COALESCE(total_amount, 0) AS NUMERIC))
              FROM \`${PROJECT}.${DATASET}.sales_contracts\`
              WHERE sale_id = @saleId AND status != 'terminated'
            ), 0) AS NUMERIC),
            paid_amount = CAST(COALESCE((
              SELECT SUM(CAST(COALESCE(paid_amount, 0) AS NUMERIC))
              FROM \`${PROJECT}.${DATASET}.sales_contracts\`
              WHERE sale_id = @saleId AND status != 'terminated'
            ), 0) AS NUMERIC)
            WHERE id = @saleId`,
    params: { saleId },
  });
}
