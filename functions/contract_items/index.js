const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'contract_items';

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
    query: `SELECT email, is_admin FROM \`${PROJECT}.${DATASET}.users\` WHERE email = @email`,
    params: { email },
  });
  return rows[0] || null;
}

exports.contract_items = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const user = await getUser(email);
  if (!user) { res.status(403).json({ error: 'Forbidden' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const path  = (req.url || '').split('?')[0];

  try {
    // GET /contract_items?contract_id=X
    if (req.method === 'GET') {
      const contractId = req.query.contract_id;
      if (!contractId) { res.status(400).json({ error: 'contract_id required' }); return; }

      const [rows] = await bigquery.query({
        query: `SELECT id, contract_id, item_type, description, quantity, unit_price, amount, sort_order, created_at
                FROM ${table}
                WHERE contract_id = @contract_id
                ORDER BY sort_order, created_at`,
        params: { contract_id: contractId },
      });
      res.json(rows);
      return;
    }

    // POST /contract_items — create single item
    // POST /contract_items/batch — create multiple items
    if (req.method === 'POST') {
      const isBatch = path.endsWith('/batch');

      if (isBatch) {
        const { contract_id, items } = req.body || {};
        if (!contract_id || !items || !items.length) {
          res.status(400).json({ error: 'contract_id and items[] required' });
          return;
        }
        const values = items.map((it, i) => {
          return `(@id${i}, @contract_id, @item_type${i}, @desc${i}, CAST(@qty${i} AS NUMERIC), CAST(@price${i} AS NUMERIC), CAST(@amount${i} AS NUMERIC), ${i}, @created_by, CURRENT_TIMESTAMP())`;
        }).join(',\n');

        const params = { contract_id, created_by: email };
        items.forEach((it, i) => {
          params[`id${i}`] = uuidv4();
          params[`item_type${i}`] = it.item_type || 'goods';
          params[`desc${i}`] = it.description || '';
          params[`qty${i}`] = it.quantity != null ? String(it.quantity) : '1';
          params[`price${i}`] = it.unit_price != null ? String(it.unit_price) : '0';
          params[`amount${i}`] = it.amount != null ? String(it.amount) : '0';
        });

        await bigquery.query({
          query: `INSERT INTO ${table} (id, contract_id, item_type, description, quantity, unit_price, amount, sort_order, created_by, created_at)
                  VALUES ${values}`,
          params,
        });
        res.json({ success: true, count: items.length });
        return;
      }

      // Single item
      const b = req.body || {};
      if (!b.contract_id || !b.description) {
        res.status(400).json({ error: 'contract_id and description required' });
        return;
      }
      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table} (id, contract_id, item_type, description, quantity, unit_price, amount, sort_order, created_by, created_at)
                VALUES (@id, @contract_id, @item_type, @description, CAST(@quantity AS NUMERIC), CAST(@unit_price AS NUMERIC), CAST(@amount AS NUMERIC), @sort_order, @created_by, CURRENT_TIMESTAMP())`,
        params: {
          id,
          contract_id: b.contract_id,
          item_type: b.item_type || 'goods',
          description: b.description,
          quantity: b.quantity != null ? String(b.quantity) : '1',
          unit_price: b.unit_price != null ? String(b.unit_price) : '0',
          amount: b.amount != null ? String(b.amount) : '0',
          sort_order: parseInt(b.sort_order || 0),
          created_by: email,
        },
      });
      res.json({ success: true, id });
      return;
    }

    // PUT /contract_items/:id
    if (req.method === 'PUT') {
      const id = path.split('/').filter(Boolean)[0];
      const b = req.body || {};
      if (!id) { res.status(400).json({ error: 'id required' }); return; }

      await bigquery.query({
        query: `UPDATE ${table}
                SET item_type = @item_type,
                    description = @description,
                    quantity = CAST(@quantity AS NUMERIC),
                    unit_price = CAST(@unit_price AS NUMERIC),
                    amount = CAST(@amount AS NUMERIC),
                    sort_order = @sort_order
                WHERE id = @id`,
        params: {
          id,
          item_type: b.item_type || 'goods',
          description: b.description || '',
          quantity: b.quantity != null ? String(b.quantity) : '1',
          unit_price: b.unit_price != null ? String(b.unit_price) : '0',
          amount: b.amount != null ? String(b.amount) : '0',
          sort_order: parseInt(b.sort_order || 0),
        },
      });
      res.json({ success: true });
      return;
    }

    // DELETE /contract_items/:id
    if (req.method === 'DELETE') {
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
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
