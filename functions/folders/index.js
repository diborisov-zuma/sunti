const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'folders';

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

async function getUserInfo(email) {
  const [rows] = await bigquery.query({
    query: `SELECT is_admin FROM \`${PROJECT}.${DATASET}.users\` WHERE email = @email`,
    params: { email },
  });
  return rows[0] || null;
}

exports.folders = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;

  try {
    // GET — папки доступные пользователю
    if (req.method === 'GET') {
      const user = await getUserInfo(email);

      const coTable = `\`${PROJECT}.${DATASET}.companies\``;
      if (user?.is_admin) {
        const [rows] = await bigquery.query({
          query: `SELECT f.id, f.name, f.\`order\`, f.status, f.company_id, co.name AS company_name, IFNULL(f.is_template, FALSE) AS is_template
                  FROM ${table} f
                  LEFT JOIN ${coTable} co ON co.id = f.company_id
                  ORDER BY f.\`order\` ASC`,
        });
        res.json(rows);
      } else {
        // Each section gates folder visibility by its OWN access dimension.
        // ?access=docs|materials|sales|gantt selects the matching column;
        // default (contracts/finance/invoices) keeps the docs_access gate.
        const dimCol = {
          docs:      'docs_level',
          materials: 'materials_level',
          sales:     'sales_level',
          gantt:     'gantt_level',
          contracts: 'docs_access',
        }[String(req.query.access || '')] || 'docs_access';
        const [rows] = await bigquery.query({
          query: `SELECT f.id, f.name, f.\`order\`, f.status, f.company_id, co.name AS company_name, uf.docs_access, IFNULL(f.is_template, FALSE) AS is_template
                  FROM ${table} f
                  INNER JOIN \`${PROJECT}.${DATASET}.users_folders\` uf
                    ON uf.folder_id = f.id
                  LEFT JOIN ${coTable} co ON co.id = f.company_id
                  WHERE uf.user_email = @email
                    AND uf.${dimCol} != 'none'
                  ORDER BY f.\`order\` ASC`,
          params: { email },
        });
        res.json(rows);
      }
      return;
    }

    // POST — создать (только админ)
    if (req.method === 'POST') {
      const user = await getUserInfo(email);
      if (!user?.is_admin) { res.status(403).json({ error: 'Forbidden' }); return; }

      const { name, order, status, company_id, is_template } = req.body;
      if (!name || order === undefined || !status) {
        res.status(400).json({ error: 'name, order and status are required' });
        return;
      }
      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table} (id, name, \`order\`, status, company_id, is_template, created_at, created_by)
                VALUES (@id, @name, @order, @status, NULLIF(@company_id, ''), @is_template, CURRENT_TIMESTAMP(), @created_by)`,
        params: { id, name, order: parseInt(order), status, company_id: company_id || '', is_template: is_template === true, created_by: email },
      });
      res.json({ success: true, id, name });
      return;
    }

    // PUT — редактировать по id (только админ)
    if (req.method === 'PUT') {
      const user = await getUserInfo(email);
      if (!user?.is_admin) { res.status(403).json({ error: 'Forbidden' }); return; }

      const id = req.url.split('/').filter(Boolean).pop().split('?')[0];
      const { name, order, status, company_id } = req.body;
      const orderInt = parseInt(order || 1);
      if (!name || !id) { res.status(400).json({ error: 'name and id are required' }); return; }
      await bigquery.query({
        query: `UPDATE ${table}
                SET name = @name, \`order\` = ${orderInt}, status = @status,
                    company_id = NULLIF(@company_id, '')
                WHERE id = @id`,
        params: { name, status: status || 'active', company_id: company_id || '', id },
      });
      res.json({ success: true });
      return;
    }

    // DELETE — удалить по id (только админ)
    if (req.method === 'DELETE') {
      const user = await getUserInfo(email);
      if (!user?.is_admin) { res.status(403).json({ error: 'Forbidden' }); return; }

      const id = req.url.split('/').filter(Boolean).pop().split('?')[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      // Удаляем папку и все связанные записи в users_folders
      await bigquery.query({
        query: `DELETE FROM ${table} WHERE id = @id`,
        params: { id },
      });
      await bigquery.query({
        query: `DELETE FROM \`${PROJECT}.${DATASET}.users_folders\` WHERE folder_id = @id`,
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
