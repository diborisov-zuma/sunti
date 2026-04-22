const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'contractors';

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

exports.contractors = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const user = await getUser(email);
  if (!user) { res.status(403).json({ error: 'Forbidden' }); return; }

  try {
    // GET — список контрагентов
    if (req.method === 'GET') {
      const { search, type, active } = req.query;
      let where = 'WHERE 1=1';
      const params = {};

      if (search) {
        where += ' AND (LOWER(name_th) LIKE LOWER(@search) OR LOWER(name_en) LIKE LOWER(@search) OR tax_id LIKE @search OR national_id LIKE @search)';
        params.search = `%${search.trim()}%`;
      }
      if (type) {
        where += ' AND type = @type';
        params.type = type;
      }
      if (active === 'true') {
        where += ' AND IFNULL(is_active, TRUE) = TRUE';
      } else if (active === 'false') {
        where += ' AND IFNULL(is_active, TRUE) = FALSE';
      }

      const [rows] = await bigquery.query({
        query: `SELECT id, tax_id, national_id, type, name_th, name_en,
                       address_th, address_en, branch, is_vat_registered,
                       default_wht_category, default_wht_rate,
                       IFNULL(is_active, TRUE) AS is_active,
                       notes, created_at, created_by
                FROM ${table}
                ${where}
                ORDER BY IFNULL(is_active, TRUE) DESC, name_en ASC, name_th ASC`,
        params,
      });
      res.json(rows);
      return;
    }

    // POST — создать
    if (req.method === 'POST') {
      if (!user.is_admin) { res.status(403).json({ error: 'Forbidden' }); return; }
      const b = req.body || {};
      if (!b.name_en && !b.name_th) {
        res.status(400).json({ error: 'name_en or name_th is required' });
        return;
      }
      const id = b.id || uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table}
                  (id, tax_id, national_id, type, name_th, name_en,
                   address_th, address_en, branch, is_vat_registered,
                   default_wht_category, default_wht_rate, is_active,
                   notes, created_at, created_by)
                VALUES
                  (@id, NULLIF(@tax_id,''), NULLIF(@national_id,''), NULLIF(@type,''),
                   NULLIF(@name_th,''), NULLIF(@name_en,''),
                   NULLIF(@address_th,''), NULLIF(@address_en,''),
                   NULLIF(@branch,''), @is_vat_registered,
                   NULLIF(@default_wht_category,''),
                   IF(@default_wht_rate = '', NULL, CAST(@default_wht_rate AS NUMERIC)),
                   TRUE, NULLIF(@notes,''),
                   CURRENT_TIMESTAMP(), @created_by)`,
        params: {
          id,
          tax_id:               b.tax_id || '',
          national_id:          b.national_id || '',
          type:                 b.type || '',
          name_th:              b.name_th || '',
          name_en:              b.name_en || '',
          address_th:           b.address_th || '',
          address_en:           b.address_en || '',
          branch:               b.branch || '',
          is_vat_registered:    !!b.is_vat_registered,
          default_wht_category: b.default_wht_category || '',
          default_wht_rate:     b.default_wht_rate != null ? String(b.default_wht_rate) : '',
          notes:                b.notes || '',
          created_by:           email,
        },
      });
      res.json({ success: true, id });
      return;
    }

    // PUT — редактировать
    if (req.method === 'PUT') {
      if (!user.is_admin) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = (req.url || '').split('/').filter(Boolean).pop().split('?')[0];
      const b = req.body || {};
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      await bigquery.query({
        query: `UPDATE ${table}
                SET tax_id               = NULLIF(@tax_id,''),
                    national_id          = NULLIF(@national_id,''),
                    type                 = NULLIF(@type,''),
                    name_th              = NULLIF(@name_th,''),
                    name_en              = NULLIF(@name_en,''),
                    address_th           = NULLIF(@address_th,''),
                    address_en           = NULLIF(@address_en,''),
                    branch               = NULLIF(@branch,''),
                    is_vat_registered    = @is_vat_registered,
                    default_wht_category = NULLIF(@default_wht_category,''),
                    default_wht_rate     = IF(@default_wht_rate = '', NULL, CAST(@default_wht_rate AS NUMERIC)),
                    is_active            = @is_active,
                    notes                = NULLIF(@notes,'')
                WHERE id = @id`,
        params: {
          id,
          tax_id:               b.tax_id || '',
          national_id:          b.national_id || '',
          type:                 b.type || '',
          name_th:              b.name_th || '',
          name_en:              b.name_en || '',
          address_th:           b.address_th || '',
          address_en:           b.address_en || '',
          branch:               b.branch || '',
          is_vat_registered:    !!b.is_vat_registered,
          default_wht_category: b.default_wht_category || '',
          default_wht_rate:     b.default_wht_rate != null ? String(b.default_wht_rate) : '',
          is_active:            b.is_active !== false,
          notes:                b.notes || '',
        },
      });
      res.json({ success: true });
      return;
    }

    // DELETE — hard delete
    if (req.method === 'DELETE') {
      if (!user.is_admin) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = (req.url || '').split('/').filter(Boolean).pop().split('?')[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }
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
