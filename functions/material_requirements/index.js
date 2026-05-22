const { BigQuery } = require('@google-cloud/bigquery');
const crypto = require('crypto');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'material_requirements';

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

async function isAdmin(email) {
  const [rows] = await bigquery.query({
    query: `SELECT is_admin FROM \`${PROJECT}.${DATASET}.users\` WHERE email = @email`,
    params: { email },
  });
  return rows[0]?.is_admin === true;
}

exports.material_requirements = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table     = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const tasksTbl  = `\`${PROJECT}.${DATASET}.tasks\``;
  const phasesTbl = `\`${PROJECT}.${DATASET}.phases\``;
  const ciTbl     = `\`${PROJECT}.${DATASET}.contract_items\``;
  const dsTbl     = `\`${PROJECT}.${DATASET}.delivery_schedule\``;
  const ctrTbl    = `\`${PROJECT}.${DATASET}.contractors\``;
  const conTbl    = `\`${PROJECT}.${DATASET}.contracts\``;
  const path      = (req.url || '').split('?')[0];

  try {
    // GET /material_requirements?task_id=X or ?folder_id=X
    if (req.method === 'GET') {
      const { task_id, folder_id } = req.query;

      if (task_id) {
        // List for a specific task, join to contract_items and delivery_schedule
        // Also join to contracts for whole-contract mode (contract_id set, line_item_id null)
        const [rows] = await bigquery.query({
          query: `SELECT m.id, m.task_id, m.line_item_id, m.contract_id, m.category,
                         m.required_by_date, m.qty, m.unit, m.notes,
                         ci.description AS contract_item_name,
                         ci.amount AS contract_item_amount,
                         ds.lifecycle AS delivery_lifecycle,
                         ds.delivery_start, ds.delivery_end,
                         COALESCE(con2.name, con.name) AS contract_name,
                         COALESCE(con2.total_amount, con.total_amount) AS contract_total,
                         COALESCE(con2.paid_amount, con.paid_amount) AS contract_paid,
                         COALESCE(con2.status, con.status) AS contract_status,
                         COALESCE(ct2.name_en, ct.name_en) AS contractor_name_en,
                         COALESCE(ct2.name_th, ct.name_th) AS contractor_name_th
                  FROM ${table} m
                  LEFT JOIN ${ciTbl} ci ON m.line_item_id = ci.id
                  LEFT JOIN ${conTbl} con ON ci.contract_id = con.id
                  LEFT JOIN ${ctrTbl} ct ON con.contractor_id = ct.id
                  LEFT JOIN ${conTbl} con2 ON m.contract_id = con2.id
                  LEFT JOIN ${ctrTbl} ct2 ON con2.contractor_id = ct2.id
                  LEFT JOIN (
                    SELECT line_item_id, lifecycle, delivery_start, delivery_end
                    FROM ${dsTbl}
                    WHERE batch_number = 1
                  ) ds ON m.line_item_id = ds.line_item_id
                  WHERE m.task_id = @task_id
                  ORDER BY m.required_by_date`,
          params: { task_id },
        });
        res.json(rows);
        return;
      }

      if (folder_id) {
        // List ALL for a folder, join through tasks -> phases -> folder_id
        const [rows] = await bigquery.query({
          query: `SELECT m.id, m.task_id, m.line_item_id, m.contract_id, m.category,
                         m.required_by_date, m.qty, m.unit, m.notes,
                         t.name AS task_name, t.name_en AS task_name_en,
                         ci.description AS contract_item_name,
                         ci.amount AS contract_item_amount,
                         COALESCE(con2.name, con.name) AS contract_name,
                         COALESCE(con2.total_amount, con.total_amount) AS contract_total,
                         COALESCE(con2.paid_amount, con.paid_amount) AS contract_paid,
                         COALESCE(con2.status, con.status) AS contract_status,
                         COALESCE(ct2.name_en, ct.name_en) AS contractor_name_en,
                         COALESCE(ct2.name_th, ct.name_th) AS contractor_name_th
                  FROM ${table} m
                  JOIN ${tasksTbl} t ON m.task_id = t.id
                  JOIN ${phasesTbl} p ON t.phase_id = p.id
                  LEFT JOIN ${ciTbl} ci ON m.line_item_id = ci.id
                  LEFT JOIN ${conTbl} con ON ci.contract_id = con.id
                  LEFT JOIN ${ctrTbl} ct ON con.contractor_id = ct.id
                  LEFT JOIN ${conTbl} con2 ON m.contract_id = con2.id
                  LEFT JOIN ${ctrTbl} ct2 ON con2.contractor_id = ct2.id
                  WHERE p.folder_id = @folder_id
                  ORDER BY p.sort_order, t.sort_order, m.required_by_date`,
          params: { folder_id },
        });
        res.json(rows);
        return;
      }

      res.status(400).json({ error: 'task_id or folder_id is required' });
      return;
    }

    // POST /material_requirements
    if (req.method === 'POST') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const b = req.body || {};
      if (!b.task_id) {
        res.status(400).json({ error: 'task_id is required' });
        return;
      }
      const id = crypto.randomUUID();
      await bigquery.query({
        query: `INSERT INTO ${table}
                  (id, task_id, line_item_id, contract_id, category, required_by_date, qty, unit, notes)
                VALUES
                  (@id, @task_id, NULLIF(@line_item_id,''), NULLIF(@contract_id,''), NULLIF(@category,''),
                   IF(@required_by_date = '', NULL, DATE(@required_by_date)),
                   CAST(@qty AS NUMERIC), @unit, NULLIF(@notes,''))`,
        params: {
          id,
          task_id:          b.task_id,
          line_item_id:     b.line_item_id || '',
          contract_id:      b.contract_id || '',
          category:         b.category || '',
          required_by_date: b.required_by_date || '',
          qty:              b.qty != null ? String(b.qty) : '0',
          unit:             b.unit || '',
          notes:            b.notes || '',
        },
      });
      res.json({ success: true, id });
      return;
    }

    // PUT /material_requirements/:id
    if (req.method === 'PUT') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = path.split('/').filter(Boolean)[0];
      const b = req.body || {};
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      await bigquery.query({
        query: `UPDATE ${table}
                SET task_id          = @task_id,
                    line_item_id     = NULLIF(@line_item_id,''),
                    category         = NULLIF(@category,''),
                    required_by_date = IF(@required_by_date = '', NULL, DATE(@required_by_date)),
                    qty              = CAST(@qty AS NUMERIC),
                    unit             = @unit,
                    notes            = NULLIF(@notes,'')
                WHERE id = @id`,
        params: {
          id,
          task_id:          b.task_id || '',
          line_item_id:     b.line_item_id || '',
          category:         b.category || '',
          required_by_date: b.required_by_date || '',
          qty:              b.qty != null ? String(b.qty) : '0',
          unit:             b.unit || '',
          notes:            b.notes || '',
        },
      });
      res.json({ success: true });
      return;
    }

    // DELETE /material_requirements/:id
    if (req.method === 'DELETE') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      await bigquery.query({
        query: `DELETE FROM ${table} WHERE id = @id`,
        params: { id },
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
