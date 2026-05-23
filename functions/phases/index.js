const { BigQuery } = require('@google-cloud/bigquery');
const crypto = require('crypto');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'phases';

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

exports.phases = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table    = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const tasksTbl = `\`${PROJECT}.${DATASET}.tasks\``;
  const depsTbl  = `\`${PROJECT}.${DATASET}.task_dependencies\``;
  const matTbl   = `\`${PROJECT}.${DATASET}.material_requirements\``;
  const path     = (req.url || '').split('?')[0];

  try {
    // GET /phases?folder_id=X
    if (req.method === 'GET') {
      const { folder_id } = req.query;
      if (!folder_id) { res.status(400).json({ error: 'folder_id is required' }); return; }

      const [rows] = await bigquery.query({
        query: `SELECT id, folder_id, name, name_en, name_th, sort_order
                FROM ${table}
                WHERE folder_id = @folder_id
                ORDER BY sort_order`,
        params: { folder_id },
      });
      res.json(rows);
      return;
    }

    // POST /phases
    if (req.method === 'POST') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const b = req.body || {};
      if (!b.folder_id || !b.name) {
        res.status(400).json({ error: 'folder_id and name are required' });
        return;
      }
      const id = crypto.randomUUID();
      await bigquery.query({
        query: `INSERT INTO ${table}
                  (id, folder_id, name, name_en, name_th, sort_order)
                VALUES
                  (@id, @folder_id, @name, NULLIF(@name_en,''), NULLIF(@name_th,''), @sort_order)`,
        params: {
          id,
          folder_id:  b.folder_id,
          name:       b.name,
          name_en:    b.name_en || '',
          name_th:    b.name_th || '',
          sort_order: b.sort_order != null ? b.sort_order : 0,
        },
      });
      res.json({ success: true, id });
      return;
    }

    // PUT /phases/:id
    if (req.method === 'PUT') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = path.split('/').filter(Boolean)[0];
      const b = req.body || {};
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      await bigquery.query({
        query: `UPDATE ${table}
                SET name       = @name,
                    name_en    = NULLIF(@name_en,''),
                    name_th    = NULLIF(@name_th,''),
                    sort_order = @sort_order
                WHERE id = @id`,
        params: {
          id,
          name:       b.name || '',
          name_en:    b.name_en || '',
          name_th:    b.name_th || '',
          sort_order: b.sort_order != null ? b.sort_order : 0,
        },
      });
      res.json({ success: true });
      return;
    }

    // DELETE /phases/:id
    if (req.method === 'DELETE') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      // Delete material_requirements for tasks in this phase
      await bigquery.query({
        query: `DELETE FROM ${matTbl}
                WHERE task_id IN (SELECT id FROM ${tasksTbl} WHERE phase_id = @id)`,
        params: { id },
      });

      // Delete task_dependencies for tasks in this phase
      await bigquery.query({
        query: `DELETE FROM ${depsTbl}
                WHERE predecessor_id IN (SELECT id FROM ${tasksTbl} WHERE phase_id = @id)
                   OR successor_id IN (SELECT id FROM ${tasksTbl} WHERE phase_id = @id)`,
        params: { id },
      });

      // Delete all tasks in this phase
      await bigquery.query({
        query: `DELETE FROM ${tasksTbl} WHERE phase_id = @id`,
        params: { id },
      });

      // Delete the phase
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
