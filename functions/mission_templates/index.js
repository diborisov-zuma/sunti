const { BigQuery } = require('@google-cloud/bigquery');
const crypto = require('crypto');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'mission_templates';

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
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

exports.mission_templates = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table    = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const path     = (req.url || '').split('?')[0];
  const segments = path.split('/').filter(Boolean);

  try {
    // GET requests
    if (req.method === 'GET') {
      // GET /mission_templates/:id
      if (segments.length >= 1 && segments[0] !== '' && !req.query.status) {
        const id = segments[0];
        const [rows] = await bigquery.query({
          query: `SELECT * FROM ${table} WHERE id = @id`,
          params: { id },
        });
        if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
        res.json(rows[0]);
        return;
      }

      // GET /mission_templates or /mission_templates?status=X
      const { status } = req.query;
      let query = `SELECT * FROM ${table}`;
      const params = {};
      if (status) {
        query += ` WHERE status = @status`;
        params.status = status;
      }
      query += ` ORDER BY code`;
      const [rows] = await bigquery.query({ query, params });
      res.json(rows);
      return;
    }

    // POST /mission_templates/:id/test — dry-run
    if (req.method === 'POST' && segments.length >= 2 && segments[1] === 'test') {
      const id = segments[0];
      const [templates] = await bigquery.query({
        query: `SELECT * FROM ${table} WHERE id = @id`,
        params: { id },
      });
      if (templates.length === 0) { res.status(404).json({ error: 'Template not found' }); return; }

      const template = templates[0];
      let triggerSpec;
      try {
        triggerSpec = JSON.parse(template.trigger_spec || '{}');
      } catch { triggerSpec = {}; }

      if (!triggerSpec.condition_query) {
        res.status(400).json({ error: 'Template has no condition_query in trigger_spec' });
        return;
      }

      const [rows] = await bigquery.query({
        query: triggerSpec.condition_query,
      });
      res.json({ matches: rows, count: rows.length });
      return;
    }

    // POST /mission_templates — create
    if (req.method === 'POST') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const b = req.body || {};
      const id = crypto.randomUUID();
      await bigquery.query({
        query: `INSERT INTO ${table}
                  (id, code, title, description, default_priority, default_role, entity_type, trigger_type, trigger_spec, auto_create, status, created_at, updated_at)
                VALUES
                  (@id, @code, @title, @description, @default_priority, NULLIF(@default_role,''), NULLIF(@entity_type,''), NULLIF(@trigger_type,''), @trigger_spec, @auto_create, @status, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
        params: {
          id,
          code: b.code || '',
          title: b.title || '',
          description: b.description || '',
          default_priority: b.default_priority || 'medium',
          default_role: b.default_role || '',
          entity_type: b.entity_type || '',
          trigger_type: b.trigger_type || '',
          trigger_spec: b.trigger_spec ? JSON.stringify(b.trigger_spec) : '{}',
          auto_create: b.auto_create === true,
          status: b.status || 'active',
        },
      });
      res.json({ success: true, id });
      return;
    }

    // PATCH /mission_templates/:id
    if (req.method === 'PATCH') {
      if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
      const id = segments[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      const [existing] = await bigquery.query({
        query: `SELECT * FROM ${table} WHERE id = @id`,
        params: { id },
      });
      if (existing.length === 0) { res.status(404).json({ error: 'Not found' }); return; }

      const b = req.body || {};
      const sets = ['updated_at = CURRENT_TIMESTAMP()'];
      const params = { id };

      if (b.code !== undefined) { sets.push('code = @code'); params.code = b.code; }
      if (b.title !== undefined) { sets.push('title = @title'); params.title = b.title; }
      if (b.description !== undefined) { sets.push('description = @description'); params.description = b.description; }
      if (b.default_priority !== undefined) { sets.push('default_priority = @default_priority'); params.default_priority = b.default_priority; }
      if (b.default_role !== undefined) { sets.push('default_role = NULLIF(@default_role,\'\')'); params.default_role = b.default_role || ''; }
      if (b.entity_type !== undefined) { sets.push('entity_type = NULLIF(@entity_type,\'\')'); params.entity_type = b.entity_type || ''; }
      if (b.trigger_type !== undefined) { sets.push('trigger_type = NULLIF(@trigger_type,\'\')'); params.trigger_type = b.trigger_type || ''; }
      if (b.trigger_spec !== undefined) { sets.push('trigger_spec = @trigger_spec'); params.trigger_spec = JSON.stringify(b.trigger_spec); }
      if (b.auto_create !== undefined) { sets.push('auto_create = @auto_create'); params.auto_create = b.auto_create === true; }
      if (b.status !== undefined) { sets.push('status = @status'); params.status = b.status; }

      await bigquery.query({
        query: `UPDATE ${table} SET ${sets.join(', ')} WHERE id = @id`,
        params,
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
