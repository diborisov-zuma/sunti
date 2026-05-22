const { BigQuery } = require('@google-cloud/bigquery');
const crypto = require('crypto');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'delivery_schedule';

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

exports.delivery_schedule = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const path  = (req.url || '').split('?')[0];

  try {
    // GET /delivery_schedule?line_item_id=X or ?contract_id=X
    if (req.method === 'GET') {
      const { line_item_id, contract_id } = req.query;
      if (!line_item_id && !contract_id) { res.status(400).json({ error: 'line_item_id or contract_id is required' }); return; }

      let where, params;
      if (line_item_id) {
        where = 'line_item_id = @line_item_id';
        params = { line_item_id };
      } else {
        where = 'contract_id = @contract_id';
        params = { contract_id };
      }

      const [rows] = await bigquery.query({
        query: `SELECT id, line_item_id, contract_id, batch_number, qty, unit,
                       production_days, production_start, production_end,
                       delivery_days, delivery_start, delivery_end,
                       lifecycle, notes
                FROM ${table}
                WHERE ${where}
                ORDER BY batch_number`,
        params,
      });
      res.json(rows);
      return;
    }

    // POST /delivery_schedule
    if (req.method === 'POST') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const b = req.body || {};
      if (!b.line_item_id && !b.contract_id) {
        res.status(400).json({ error: 'line_item_id or contract_id is required' });
        return;
      }
      const id = crypto.randomUUID();
      await bigquery.query({
        query: `INSERT INTO ${table}
                  (id, line_item_id, contract_id, batch_number, qty, unit,
                   production_days, production_start, production_end,
                   delivery_days, delivery_start, delivery_end,
                   lifecycle, notes)
                VALUES
                  (@id, @line_item_id, NULLIF(@contract_id,''), @batch_number, CAST(@qty AS NUMERIC), @unit,
                   @production_days,
                   IF(@production_start = '', NULL, DATE(@production_start)),
                   IF(@production_end = '', NULL, DATE(@production_end)),
                   @delivery_days,
                   IF(@delivery_start = '', NULL, DATE(@delivery_start)),
                   IF(@delivery_end = '', NULL, DATE(@delivery_end)),
                   NULLIF(@lifecycle,''), NULLIF(@notes,''))`,
        params: {
          id,
          line_item_id:    b.line_item_id || '',
          contract_id:     b.contract_id || '',
          batch_number:    b.batch_number != null ? b.batch_number : 1,
          qty:             b.qty != null ? String(b.qty) : '0',
          unit:            b.unit || '',
          production_days: b.production_days != null ? b.production_days : 0,
          production_start: b.production_start || '',
          production_end:   b.production_end || '',
          delivery_days:   b.delivery_days != null ? b.delivery_days : 0,
          delivery_start:  b.delivery_start || '',
          delivery_end:    b.delivery_end || '',
          lifecycle:       b.lifecycle || '',
          notes:           b.notes || '',
        },
      });
      res.json({ success: true, id });
      return;
    }

    // PUT /delivery_schedule/:id
    if (req.method === 'PUT') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = path.split('/').filter(Boolean)[0];
      const b = req.body || {};
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      await bigquery.query({
        query: `UPDATE ${table}
                SET qty              = CAST(@qty AS NUMERIC),
                    production_days  = @production_days,
                    production_start = IF(@production_start = '', NULL, DATE(@production_start)),
                    production_end   = IF(@production_end = '', NULL, DATE(@production_end)),
                    delivery_days    = @delivery_days,
                    delivery_start   = IF(@delivery_start = '', NULL, DATE(@delivery_start)),
                    delivery_end     = IF(@delivery_end = '', NULL, DATE(@delivery_end)),
                    lifecycle        = NULLIF(@lifecycle,''),
                    notes            = NULLIF(@notes,'')
                WHERE id = @id`,
        params: {
          id,
          qty:              b.qty != null ? String(b.qty) : '0',
          production_days:  b.production_days != null ? b.production_days : 0,
          production_start: b.production_start || '',
          production_end:   b.production_end || '',
          delivery_days:    b.delivery_days != null ? b.delivery_days : 0,
          delivery_start:   b.delivery_start || '',
          delivery_end:     b.delivery_end || '',
          lifecycle:        b.lifecycle || '',
          notes:            b.notes || '',
        },
      });
      res.json({ success: true });
      return;
    }

    // DELETE /delivery_schedule/:id
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
