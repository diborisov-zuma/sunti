const { BigQuery } = require('@google-cloud/bigquery');
const crypto = require('crypto');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'tasks_groups';

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

async function isAdmin(email) {
  const [rows] = await bigquery.query({
    query: `SELECT is_admin FROM \`${PROJECT}.${DATASET}.users\` WHERE email = @email`,
    params: { email },
  });
  return rows[0]?.is_admin === true;
}

exports.tasks_groups = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const path  = (req.url || '').split('?')[0];

  try {
    // GET /tasks_groups?folder_id=X
    if (req.method === 'GET') {
      const { folder_id } = req.query;
      if (!folder_id) { res.status(400).json({ error: 'folder_id is required' }); return; }

      const [rows] = await bigquery.query({
        query: `SELECT id, folder_id, name, name_en, name_th, description,
                       responsible_email, status, sort_order, created_by, created_at
                FROM ${table}
                WHERE folder_id = @folder_id AND IFNULL(status, 'active') != 'archive'
                ORDER BY sort_order, created_at`,
        params: { folder_id },
      });
      res.json(rows);
      return;
    }

    // POST /tasks_groups
    if (req.method === 'POST') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const b = req.body || {};
      if (!b.folder_id || !b.name) { res.status(400).json({ error: 'folder_id and name required' }); return; }
      const id = crypto.randomUUID();
      await bigquery.query({
        query: `INSERT INTO ${table}
                  (id, folder_id, name, name_en, name_th, description, responsible_email, status, sort_order, created_by, created_at)
                VALUES
                  (@id, @folder_id, @name, NULLIF(@name_en,''), NULLIF(@name_th,''), NULLIF(@description,''),
                   NULLIF(@responsible_email,''), 'active', @sort_order, @created_by, CURRENT_TIMESTAMP())`,
        params: {
          id, folder_id: b.folder_id, name: b.name,
          name_en: b.name_en || '', name_th: b.name_th || '',
          description: b.description || '', responsible_email: b.responsible_email || '',
          sort_order: b.sort_order != null ? b.sort_order : 0, created_by: email,
        },
      });
      res.json({ success: true, id });
      return;
    }

    // PUT /tasks_groups/:id
    if (req.method === 'PUT') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = path.split('/').filter(Boolean)[0];
      const b = req.body || {};
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      await bigquery.query({
        query: `UPDATE ${table}
                SET name = @name, name_en = NULLIF(@name_en,''), name_th = NULLIF(@name_th,''),
                    description = NULLIF(@description,''), responsible_email = NULLIF(@responsible_email,''),
                    status = @status, sort_order = @sort_order
                WHERE id = @id`,
        params: {
          id, name: b.name || '', name_en: b.name_en || '', name_th: b.name_th || '',
          description: b.description || '', responsible_email: b.responsible_email || '',
          status: b.status || 'active', sort_order: b.sort_order != null ? b.sort_order : 0,
        },
      });
      res.json({ success: true });
      return;
    }

    // DELETE /tasks_groups/:id
    if (req.method === 'DELETE') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id required' }); return; }
      // Cascade: phases → tasks → dependencies + material_requirements
      const phasesTbl = `\`${PROJECT}.${DATASET}.phases\``;
      const tasksTbl = `\`${PROJECT}.${DATASET}.tasks\``;
      const depsTbl = `\`${PROJECT}.${DATASET}.task_dependencies\``;
      const matTbl = `\`${PROJECT}.${DATASET}.material_requirements\``;
      await bigquery.query({ query: `DELETE FROM ${matTbl} WHERE task_id IN (SELECT id FROM ${tasksTbl} WHERE phase_id IN (SELECT id FROM ${phasesTbl} WHERE group_id = @id))`, params: { id } });
      await bigquery.query({ query: `DELETE FROM ${depsTbl} WHERE predecessor_id IN (SELECT id FROM ${tasksTbl} WHERE phase_id IN (SELECT id FROM ${phasesTbl} WHERE group_id = @id)) OR successor_id IN (SELECT id FROM ${tasksTbl} WHERE phase_id IN (SELECT id FROM ${phasesTbl} WHERE group_id = @id))`, params: { id } });
      await bigquery.query({ query: `DELETE FROM ${tasksTbl} WHERE phase_id IN (SELECT id FROM ${phasesTbl} WHERE group_id = @id)`, params: { id } });
      await bigquery.query({ query: `DELETE FROM ${phasesTbl} WHERE group_id = @id`, params: { id } });
      await bigquery.query({ query: `DELETE FROM ${table} WHERE id = @id`, params: { id } });
      res.json({ success: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
};
