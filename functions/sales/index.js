const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'sales';

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

async function recalcSalePaid(saleId) {
  await bigquery.query({
    query: `UPDATE \`${PROJECT}.${DATASET}.${TABLE}\`
            SET paid_amount = CAST(COALESCE((
              SELECT SUM(CAST(COALESCE(paid_amount, 0) AS NUMERIC))
              FROM \`${PROJECT}.${DATASET}.sales_contracts\`
              WHERE sale_id = @saleId AND status != 'terminated'
            ), 0) AS NUMERIC)
            WHERE id = @saleId`,
    params: { saleId },
  });
}

exports.sales = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const user = await getUser(email);
  if (!user) { res.status(403).json({ error: 'Forbidden' }); return; }

  // Route: POST /sales/:id/recalc
  const urlParts = (req.url || '').split('/').filter(Boolean);
  if (req.method === 'POST' && urlParts.length >= 2 && urlParts[urlParts.length - 1] === 'recalc') {
    const saleId = urlParts[urlParts.length - 2];
    try {
      await recalcSalePaid(saleId);
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
    return;
  }

  try {
    // GET — list sales
    if (req.method === 'GET') {
      const { folder_id, buyer_id, company_id, status } = req.query;
      let where = 'WHERE 1=1';
      const params = {};

      if (folder_id) { where += ' AND s.folder_id = @folder_id'; params.folder_id = folder_id; }
      if (buyer_id)  { where += ' AND s.buyer_id = @buyer_id';   params.buyer_id = buyer_id; }
      if (company_id){ where += ' AND s.company_id = @company_id'; params.company_id = company_id; }
      if (status)    { where += ' AND s.status = @status';        params.status = status; }

      const [rows] = await bigquery.query({
        query: `SELECT s.*,
                       b.name_en AS buyer_name_en, b.name_th AS buyer_name_th,
                       b.email AS buyer_email, b.phone AS buyer_phone,
                       f.name AS folder_name,
                       co.name AS company_name,
                       (SELECT COUNT(*) FROM \`${PROJECT}.${DATASET}.sales_contracts\` sc
                        WHERE sc.sale_id = s.id AND sc.status != 'terminated') AS contracts_count
                FROM ${table} s
                LEFT JOIN \`${PROJECT}.${DATASET}.buyers\` b ON b.id = s.buyer_id
                LEFT JOIN \`${PROJECT}.${DATASET}.folders\` f ON f.id = s.folder_id
                LEFT JOIN \`${PROJECT}.${DATASET}.companies\` co ON co.id = s.company_id
                ${where}
                ORDER BY s.created_at DESC`,
        params,
      });
      res.json(rows);
      return;
    }

    // POST — create
    if (req.method === 'POST') {
      if (!user.can_edit) { res.status(403).json({ error: 'Forbidden' }); return; }
      const b = req.body || {};
      if (!b.folder_id || !b.buyer_id || !b.company_id) {
        res.status(400).json({ error: 'folder_id, buyer_id and company_id are required' });
        return;
      }
      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table}
                  (id, folder_id, buyer_id, company_id, name, status,
                   reservation_date, reservation_amount,
                   total_amount, paid_amount,
                   transfer_date, notes, created_by, created_at)
                VALUES
                  (@id, @folder_id, @buyer_id, @company_id,
                   NULLIF(@name,''), @status,
                   IF(@reservation_date = '', NULL, CAST(@reservation_date AS DATE)),
                   CAST(@reservation_amount AS NUMERIC),
                   CAST(@total_amount AS NUMERIC),
                   CAST('0' AS NUMERIC),
                   IF(@transfer_date = '', NULL, CAST(@transfer_date AS DATE)),
                   NULLIF(@notes,''), @created_by, CURRENT_TIMESTAMP())`,
        params: {
          id,
          folder_id:          b.folder_id,
          buyer_id:           b.buyer_id,
          company_id:         b.company_id,
          name:               b.name || '',
          status:             b.status || 'reservation',
          reservation_date:   b.reservation_date || '',
          reservation_amount: String(b.reservation_amount || 0),
          total_amount:       String(b.total_amount || 0),
          transfer_date:      b.transfer_date || '',
          notes:              b.notes || '',
          created_by:         email,
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
                SET folder_id          = @folder_id,
                    buyer_id           = @buyer_id,
                    company_id         = @company_id,
                    name               = NULLIF(@name,''),
                    status             = @status,
                    reservation_date   = IF(@reservation_date = '', NULL, CAST(@reservation_date AS DATE)),
                    reservation_amount = CAST(@reservation_amount AS NUMERIC),
                    total_amount       = CAST(@total_amount AS NUMERIC),
                    transfer_date      = IF(@transfer_date = '', NULL, CAST(@transfer_date AS DATE)),
                    notes              = NULLIF(@notes,'')
                WHERE id = @id`,
        params: {
          id,
          folder_id:          b.folder_id,
          buyer_id:           b.buyer_id,
          company_id:         b.company_id,
          name:               b.name || '',
          status:             b.status || 'reservation',
          reservation_date:   b.reservation_date || '',
          reservation_amount: String(b.reservation_amount || 0),
          total_amount:       String(b.total_amount || 0),
          transfer_date:      b.transfer_date || '',
          notes:              b.notes || '',
        },
      });
      res.json({ success: true });
      return;
    }

    // DELETE — soft: set status=cancelled
    if (req.method === 'DELETE') {
      if (!user.can_edit) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = urlParts[urlParts.length - 1];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }
      await bigquery.query({
        query: `UPDATE ${table} SET status = 'cancelled' WHERE id = @id`,
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
