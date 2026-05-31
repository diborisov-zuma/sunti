const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'payment_schedules';

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

async function recalcSchedulePaid(scheduleId) {
  await bigquery.query({
    query: `UPDATE \`${PROJECT}.${DATASET}.${TABLE}\`
            SET paid_amount = CAST(COALESCE((
              SELECT SUM(CAST(amount AS NUMERIC))
              FROM \`${PROJECT}.${DATASET}.sales_payments\`
              WHERE schedule_id = @scheduleId AND status = 'confirmed'
            ), 0) AS NUMERIC),
            status = CASE
              WHEN CAST(COALESCE((
                SELECT SUM(CAST(amount AS NUMERIC))
                FROM \`${PROJECT}.${DATASET}.sales_payments\`
                WHERE schedule_id = @scheduleId AND status = 'confirmed'
              ), 0) AS NUMERIC) >= amount THEN 'paid'
              WHEN CAST(COALESCE((
                SELECT SUM(CAST(amount AS NUMERIC))
                FROM \`${PROJECT}.${DATASET}.sales_payments\`
                WHERE schedule_id = @scheduleId AND status = 'confirmed'
              ), 0) AS NUMERIC) > 0 THEN 'partially_paid'
              WHEN due_date < CURRENT_DATE() THEN 'overdue'
              ELSE 'upcoming'
            END
            WHERE id = @scheduleId`,
    params: { scheduleId },
  });
}

exports.payment_schedules = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const user = await getUser(email);
  if (!user) { res.status(403).json({ error: 'Forbidden' }); return; }

  const urlParts = (req.url || '').split('/').filter(Boolean);

  // Route: POST /payment_schedules/batch
  if (req.method === 'POST' && urlParts.length >= 1 && urlParts[urlParts.length - 1] === 'batch') {
    if (!user.can_edit) { res.status(403).json({ error: 'Forbidden' }); return; }
    const b = req.body || {};
    if (!b.contract_id || !b.items || !b.items.length) {
      res.status(400).json({ error: 'contract_id and items[] are required' });
      return;
    }
    try {
      const rows = b.items.map((item, i) => ({
        id: uuidv4(),
        contract_id: b.contract_id,
        name: item.name || '',
        milestone_type: item.milestone_type || 'installment',
        due_date: item.due_date || null,
        amount: String(item.amount || 0),
        percentage: String(item.percentage || 0),
        sort_order: item.sort_order != null ? item.sort_order : i,
        notes: item.notes || '',
      }));

      for (const r of rows) {
        await bigquery.query({
          query: `INSERT INTO ${table}
                    (id, contract_id, name, milestone_type, due_date,
                     amount, percentage, paid_amount, status, sort_order, notes,
                     created_by, created_at)
                  VALUES
                    (@id, @contract_id, NULLIF(@name,''), @milestone_type,
                     IF(@due_date = '', NULL, CAST(@due_date AS DATE)),
                     CAST(@amount AS NUMERIC), CAST(@percentage AS NUMERIC),
                     CAST('0' AS NUMERIC), 'upcoming', @sort_order, NULLIF(@notes,''),
                     @created_by, CURRENT_TIMESTAMP())`,
          params: { ...r, due_date: r.due_date || '', created_by: email },
        });
      }
      res.json({ success: true, count: rows.length });
    } catch(e) { res.status(500).json({ error: e.message }); }
    return;
  }

  try {
    // GET — list schedule items for a contract
    if (req.method === 'GET') {
      const { contract_id } = req.query;
      if (!contract_id) { res.status(400).json({ error: 'contract_id is required' }); return; }

      const [rows] = await bigquery.query({
        query: `SELECT ps.*,
                  (SELECT COUNT(*) FROM \`${PROJECT}.${DATASET}.sales_payments\` sp
                   WHERE sp.schedule_id = ps.id AND sp.status = 'confirmed') AS payments_count
                FROM ${table} ps
                WHERE ps.contract_id = @contract_id
                ORDER BY ps.sort_order ASC, ps.due_date ASC`,
        params: { contract_id },
      });
      res.json(rows);
      return;
    }

    // POST — create single
    if (req.method === 'POST') {
      if (!user.can_edit) { res.status(403).json({ error: 'Forbidden' }); return; }
      const b = req.body || {};
      if (!b.contract_id) { res.status(400).json({ error: 'contract_id is required' }); return; }

      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table}
                  (id, contract_id, name, milestone_type, due_date,
                   amount, percentage, paid_amount, status, sort_order, notes,
                   created_by, created_at)
                VALUES
                  (@id, @contract_id, NULLIF(@name,''), @milestone_type,
                   IF(@due_date = '', NULL, CAST(@due_date AS DATE)),
                   CAST(@amount AS NUMERIC), CAST(@percentage AS NUMERIC),
                   CAST('0' AS NUMERIC), 'upcoming', @sort_order, NULLIF(@notes,''),
                   @created_by, CURRENT_TIMESTAMP())`,
        params: {
          id,
          contract_id:    b.contract_id,
          name:           b.name || '',
          milestone_type: b.milestone_type || 'installment',
          due_date:       b.due_date || '',
          amount:         String(b.amount || 0),
          percentage:     String(b.percentage || 0),
          sort_order:     b.sort_order || 0,
          notes:          b.notes || '',
          created_by:     email,
        },
      });
      res.json({ success: true, id });
      return;
    }

    // PUT — update
    if (req.method === 'PUT') {
      if (!user.can_edit) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = urlParts[urlParts.length - 1];
      const b = req.body || {};
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      await bigquery.query({
        query: `UPDATE ${table}
                SET name           = NULLIF(@name,''),
                    milestone_type = @milestone_type,
                    due_date       = IF(@due_date = '', NULL, CAST(@due_date AS DATE)),
                    amount         = CAST(@amount AS NUMERIC),
                    percentage     = CAST(@percentage AS NUMERIC),
                    sort_order     = @sort_order,
                    notes          = NULLIF(@notes,'')
                WHERE id = @id`,
        params: {
          id,
          name:           b.name || '',
          milestone_type: b.milestone_type || 'installment',
          due_date:       b.due_date || '',
          amount:         String(b.amount || 0),
          percentage:     String(b.percentage || 0),
          sort_order:     b.sort_order || 0,
          notes:          b.notes || '',
        },
      });
      res.json({ success: true });
      return;
    }

    // DELETE
    if (req.method === 'DELETE') {
      if (!user.can_edit) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = urlParts[urlParts.length - 1];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      // Check payments
      const [pmt] = await bigquery.query({
        query: `SELECT COUNT(*) AS cnt FROM \`${PROJECT}.${DATASET}.sales_payments\`
                WHERE schedule_id = @id AND status = 'confirmed'`,
        params: { id },
      });
      if (pmt[0] && parseInt(pmt[0].cnt) > 0) {
        res.status(400).json({ error: 'Cannot delete milestone with confirmed payments' });
        return;
      }

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
