const { BigQuery } = require('@google-cloud/bigquery');
const crypto = require('crypto');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'tasks';

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

exports.gantt_tasks = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table     = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const phasesTbl = `\`${PROJECT}.${DATASET}.phases\``;
  const depsTbl   = `\`${PROJECT}.${DATASET}.task_dependencies\``;
  const matTbl    = `\`${PROJECT}.${DATASET}.material_requirements\``;
  const path      = (req.url || '').split('?')[0];

  try {
    // GET /gantt_tasks?folder_id=X or ?group_id=X
    if (req.method === 'GET') {
      const { folder_id, group_id } = req.query;
      if (!folder_id && !group_id) { res.status(400).json({ error: 'folder_id or group_id is required' }); return; }

      let where, params;
      if (group_id) {
        where = 'p.group_id = @group_id';
        params = { group_id };
      } else {
        where = 'p.folder_id = @folder_id';
        params = { folder_id };
      }

      const [rows] = await bigquery.query({
        query: `SELECT t.id, t.phase_id, t.name, t.name_en, t.name_th,
                       t.planned_start, t.planned_end, t.actual_start, t.actual_end,
                       t.duration_days, t.is_critical, t.sort_order,
                       t.notes, t.notes_en, t.notes_th,
                       p.name AS phase_name, p.name_en AS phase_name_en, p.name_th AS phase_name_th
                FROM ${table} t
                JOIN ${phasesTbl} p ON t.phase_id = p.id
                WHERE ${where}
                ORDER BY p.sort_order, t.sort_order`,
        params,
      });
      res.json(rows);
      return;
    }

    // POST /gantt_tasks
    if (req.method === 'POST') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const b = req.body || {};
      if (!b.phase_id || !b.name) {
        res.status(400).json({ error: 'phase_id and name are required' });
        return;
      }
      const id = crypto.randomUUID();
      await bigquery.query({
        query: `INSERT INTO ${table}
                  (id, phase_id, name, name_en, name_th,
                   planned_start, planned_end, actual_start, actual_end,
                   duration_days, is_critical, sort_order, notes, notes_en, notes_th)
                VALUES
                  (@id, @phase_id, @name, NULLIF(@name_en,''), NULLIF(@name_th,''),
                   IF(@planned_start = '', NULL, DATE(@planned_start)),
                   IF(@planned_end = '', NULL, DATE(@planned_end)),
                   IF(@actual_start = '', NULL, DATE(@actual_start)),
                   IF(@actual_end = '', NULL, DATE(@actual_end)),
                   @duration_days, @is_critical, @sort_order,
                   NULLIF(@notes,''), NULLIF(@notes_en,''), NULLIF(@notes_th,''))`,
        params: {
          id,
          phase_id:      b.phase_id,
          name:          b.name,
          name_en:       b.name_en || '',
          name_th:       b.name_th || '',
          planned_start: b.planned_start || '',
          planned_end:   b.planned_end || '',
          actual_start:  b.actual_start || '',
          actual_end:    b.actual_end || '',
          duration_days: b.duration_days != null ? b.duration_days : 0,
          is_critical:   !!b.is_critical,
          sort_order:    b.sort_order != null ? b.sort_order : 0,
          notes:         b.notes || '',
          notes_en:      b.notes_en || '',
          notes_th:      b.notes_th || '',
        },
      });
      res.json({ success: true, id });
      return;
    }

    // PUT /gantt_tasks/:id
    if (req.method === 'PUT') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = path.split('/').filter(Boolean)[0];
      const b = req.body || {};
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      await bigquery.query({
        query: `UPDATE ${table}
                SET phase_id      = @phase_id,
                    name          = @name,
                    name_en       = NULLIF(@name_en,''),
                    name_th       = NULLIF(@name_th,''),
                    planned_start = IF(@planned_start = '', NULL, DATE(@planned_start)),
                    planned_end   = IF(@planned_end = '', NULL, DATE(@planned_end)),
                    actual_start  = IF(@actual_start = '', NULL, DATE(@actual_start)),
                    actual_end    = IF(@actual_end = '', NULL, DATE(@actual_end)),
                    duration_days = @duration_days,
                    is_critical   = @is_critical,
                    sort_order    = @sort_order,
                    notes         = NULLIF(@notes,''),
                    notes_en      = NULLIF(@notes_en,''),
                    notes_th      = NULLIF(@notes_th,'')
                WHERE id = @id`,
        params: {
          id,
          phase_id:      b.phase_id || '',
          name:          b.name || '',
          name_en:       b.name_en || '',
          name_th:       b.name_th || '',
          planned_start: b.planned_start || '',
          planned_end:   b.planned_end || '',
          actual_start:  b.actual_start || '',
          actual_end:    b.actual_end || '',
          duration_days: b.duration_days != null ? b.duration_days : 0,
          is_critical:   b.is_critical !== undefined ? !!b.is_critical : false,
          notes:         b.notes || '',
          notes_en:      b.notes_en || '',
          notes_th:      b.notes_th || '',
          sort_order:    b.sort_order != null ? b.sort_order : 0,
        },
      });
      res.json({ success: true });
      return;
    }

    // DELETE /gantt_tasks/:id
    if (req.method === 'DELETE') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      // Delete material_requirements for this task
      await bigquery.query({
        query: `DELETE FROM ${matTbl} WHERE task_id = @id`,
        params: { id },
      });

      // Delete task_dependencies where this task is predecessor or successor
      await bigquery.query({
        query: `DELETE FROM ${depsTbl}
                WHERE predecessor_id = @id OR successor_id = @id`,
        params: { id },
      });

      // Delete the task
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
