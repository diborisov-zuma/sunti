const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'buyers';

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

exports.buyers = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const user = await getUser(email);
  if (!user) { res.status(403).json({ error: 'Forbidden' }); return; }

  try {
    // GET — list buyers
    if (req.method === 'GET') {
      const { search, type, active } = req.query;
      let where = 'WHERE 1=1';
      const params = {};

      if (search) {
        where += ` AND (LOWER(name_en) LIKE LOWER(@search) OR LOWER(name_th) LIKE LOWER(@search)
                   OR email LIKE @search OR phone LIKE @search
                   OR passport_number LIKE @search OR national_id LIKE @search OR tax_id LIKE @search)`;
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
        query: `SELECT id, type, name_en, name_th, email, phone,
                       passport_number, national_id, tax_id, nationality,
                       address_en, address_th, notes,
                       IFNULL(is_active, TRUE) AS is_active,
                       created_at, created_by
                FROM ${table}
                ${where}
                ORDER BY IFNULL(is_active, TRUE) DESC, name_en ASC, name_th ASC`,
        params,
      });
      res.json(rows);
      return;
    }

    // POST — create
    if (req.method === 'POST') {
      if (!user.can_edit) { res.status(403).json({ error: 'Forbidden' }); return; }
      const b = req.body || {};
      if (!b.name_en && !b.name_th) {
        res.status(400).json({ error: 'name_en or name_th is required' });
        return;
      }
      const id = b.id || uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table}
                  (id, type, name_en, name_th, email, phone,
                   passport_number, national_id, tax_id, nationality,
                   address_en, address_th, notes, is_active,
                   created_at, created_by)
                VALUES
                  (@id, NULLIF(@type,''), NULLIF(@name_en,''), NULLIF(@name_th,''),
                   NULLIF(@email,''), NULLIF(@phone,''),
                   NULLIF(@passport_number,''), NULLIF(@national_id,''),
                   NULLIF(@tax_id,''), NULLIF(@nationality,''),
                   NULLIF(@address_en,''), NULLIF(@address_th,''),
                   NULLIF(@notes,''), TRUE,
                   CURRENT_TIMESTAMP(), @created_by)`,
        params: {
          id,
          type:             b.type || '',
          name_en:          b.name_en || '',
          name_th:          b.name_th || '',
          email:            b.email || '',
          phone:            b.phone || '',
          passport_number:  b.passport_number || '',
          national_id:      b.national_id || '',
          tax_id:           b.tax_id || '',
          nationality:      b.nationality || '',
          address_en:       b.address_en || '',
          address_th:       b.address_th || '',
          notes:            b.notes || '',
          created_by:       email,
        },
      });
      res.json({ success: true, id });
      return;
    }

    // PUT — update
    if (req.method === 'PUT') {
      if (!user.can_edit) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = (req.url || '').split('/').filter(Boolean).pop().split('?')[0];
      const b = req.body || {};
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      await bigquery.query({
        query: `UPDATE ${table}
                SET type             = NULLIF(@type,''),
                    name_en          = NULLIF(@name_en,''),
                    name_th          = NULLIF(@name_th,''),
                    email            = NULLIF(@email,''),
                    phone            = NULLIF(@phone,''),
                    passport_number  = NULLIF(@passport_number,''),
                    national_id      = NULLIF(@national_id,''),
                    tax_id           = NULLIF(@tax_id,''),
                    nationality      = NULLIF(@nationality,''),
                    address_en       = NULLIF(@address_en,''),
                    address_th       = NULLIF(@address_th,''),
                    notes            = NULLIF(@notes,''),
                    is_active        = @is_active
                WHERE id = @id`,
        params: {
          id,
          type:             b.type || '',
          name_en:          b.name_en || '',
          name_th:          b.name_th || '',
          email:            b.email || '',
          phone:            b.phone || '',
          passport_number:  b.passport_number || '',
          national_id:      b.national_id || '',
          tax_id:           b.tax_id || '',
          nationality:      b.nationality || '',
          address_en:       b.address_en || '',
          address_th:       b.address_th || '',
          notes:            b.notes || '',
          is_active:        b.is_active !== false,
        },
      });
      res.json({ success: true });
      return;
    }

    // DELETE
    if (req.method === 'DELETE') {
      if (!user.can_edit) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = (req.url || '').split('/').filter(Boolean).pop().split('?')[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }
      // Check if buyer has sales
      const [refs] = await bigquery.query({
        query: `SELECT COUNT(*) AS cnt FROM \`${PROJECT}.${DATASET}.sales\` WHERE buyer_id = @id`,
        params: { id },
      });
      if (refs[0] && parseInt(refs[0].cnt) > 0) {
        res.status(400).json({ error: 'Cannot delete buyer with existing sales. Deactivate instead.' });
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
