const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';

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

const puTable  = `\`${PROJECT}.${DATASET}.portal_users\``;
const pfTable  = `\`${PROJECT}.${DATASET}.portal_users_folders\``;
const psTable  = `\`${PROJECT}.${DATASET}.portal_users_sections\``;
const fldTable = `\`${PROJECT}.${DATASET}.folders\``;

exports.portal_users = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }

  const path = (req.url || '').split('?')[0];

  try {
    // GET /portal_users/:id/access — folders + sections for one user
    if (req.method === 'GET' && path.endsWith('/access')) {
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }
      const [folders] = await bigquery.query({
        query: `SELECT pf.id, pf.folder_id, f.name AS folder_name, f.company_id
                FROM ${pfTable} pf
                JOIN ${fldTable} f ON f.id = pf.folder_id
                WHERE pf.portal_user_id = @id
                ORDER BY f.name ASC`,
        params: { id },
      });
      const [sections] = await bigquery.query({
        query: `SELECT id, section, access_level FROM ${psTable} WHERE portal_user_id = @id`,
        params: { id },
      });
      res.json({ folders, sections });
      return;
    }

    // GET /portal_users — list all
    if (req.method === 'GET') {
      const [rows] = await bigquery.query({
        query: `SELECT pu.id, pu.email, pu.name, IFNULL(pu.is_active, TRUE) AS is_active,
                       pu.created_at, pu.created_by,
                       (SELECT COUNT(*) FROM ${pfTable} WHERE portal_user_id = pu.id) AS folder_count,
                       (SELECT COUNT(*) FROM ${psTable} WHERE portal_user_id = pu.id) AS section_count
                FROM ${puTable} pu
                ORDER BY pu.name ASC, pu.email ASC`,
      });
      res.json(rows);
      return;
    }

    // POST /portal_users — create user
    if (req.method === 'POST' && !path.includes('/folders') && !path.includes('/sections')) {
      const { name, email: userEmail, is_active } = req.body || {};
      if (!userEmail) { res.status(400).json({ error: 'email is required' }); return; }
      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${puTable} (id, email, name, is_active, created_at, created_by)
                VALUES (@id, @email, @name, @is_active, CURRENT_TIMESTAMP(), @created_by)`,
        params: { id, email: userEmail, name: name || '', is_active: is_active !== false, created_by: email },
      });
      res.json({ success: true, id });
      return;
    }

    // PUT /portal_users/:id — update user
    if (req.method === 'PUT' && !path.includes('/folders') && !path.includes('/sections')) {
      const id = path.split('/').filter(Boolean)[0];
      const { name, email: userEmail, is_active } = req.body || {};
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }
      await bigquery.query({
        query: `UPDATE ${puTable} SET name = @name, email = @email, is_active = @is_active WHERE id = @id`,
        params: { id, name: name || '', email: userEmail || '', is_active: is_active !== false },
      });
      res.json({ success: true });
      return;
    }

    // POST /portal_users/:id/folders — set folder access (replace all)
    if (req.method === 'POST' && path.endsWith('/folders')) {
      const id = path.split('/').filter(Boolean)[0];
      const { folder_ids } = req.body || {};
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }
      // Delete existing
      await bigquery.query({ query: `DELETE FROM ${pfTable} WHERE portal_user_id = @id`, params: { id } });
      // Insert new
      if (folder_ids && folder_ids.length) {
        const rows = folder_ids.map(fid => `('${uuidv4()}', '${id}', '${fid}')`).join(',');
        await bigquery.query({
          query: `INSERT INTO ${pfTable} (id, portal_user_id, folder_id) VALUES ${rows}`,
        });
      }
      res.json({ success: true });
      return;
    }

    // POST /portal_users/:id/sections — set section access (replace all)
    if (req.method === 'POST' && path.endsWith('/sections')) {
      const id = path.split('/').filter(Boolean)[0];
      const { sections } = req.body || {}; // [{ section, access_level }]
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }
      await bigquery.query({ query: `DELETE FROM ${psTable} WHERE portal_user_id = @id`, params: { id } });
      if (sections && sections.length) {
        const rows = sections.map(s => `('${uuidv4()}', '${id}', '${s.section}', '${s.access_level}')`).join(',');
        await bigquery.query({
          query: `INSERT INTO ${psTable} (id, portal_user_id, section, access_level) VALUES ${rows}`,
        });
      }
      res.json({ success: true });
      return;
    }

    // DELETE /portal_users/:id
    if (req.method === 'DELETE') {
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }
      await bigquery.query({ query: `DELETE FROM ${pfTable} WHERE portal_user_id = @id`, params: { id } });
      await bigquery.query({ query: `DELETE FROM ${psTable} WHERE portal_user_id = @id`, params: { id } });
      await bigquery.query({ query: `DELETE FROM ${puTable} WHERE id = @id`, params: { id } });
      res.json({ success: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
