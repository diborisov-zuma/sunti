const { BigQuery } = require('@google-cloud/bigquery');
const crypto = require('crypto');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'missions';

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
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

async function getUserByEmail(email) {
  const [rows] = await bigquery.query({
    query: `SELECT id, email, name FROM \`${PROJECT}.${DATASET}.users\` WHERE email = @email`,
    params: { email },
  });
  return rows[0] || null;
}

async function logEvent(missionId, eventType, payload, actorId) {
  await bigquery.query({
    query: `INSERT INTO \`${PROJECT}.${DATASET}.mission_events\` (id, mission_id, event_type, payload, actor_id, created_at) VALUES (@id, @mid, @type, @payload, @actor, CURRENT_TIMESTAMP())`,
    params: { id: crypto.randomUUID(), mid: missionId, type: eventType, payload: JSON.stringify(payload || {}), actor: actorId },
  });
}

exports.missions = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table       = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const eventsTbl   = `\`${PROJECT}.${DATASET}.mission_events\``;
  const watchersTbl = `\`${PROJECT}.${DATASET}.mission_watchers\``;
  const usersTbl    = `\`${PROJECT}.${DATASET}.users\``;
  const path        = (req.url || '').split('?')[0];
  const segments    = path.split('/').filter(Boolean);

  try {
    // GET requests
    if (req.method === 'GET') {
      const { assignee_id, entity_type, entity_id, needs_triage, view, user_id } = req.query;

      // GET /missions/:id — single mission
      if (segments.length >= 1 && segments[0] !== '' && !assignee_id && !entity_type && !needs_triage && !view) {
        const id = segments[0];
        const [rows] = await bigquery.query({
          query: `SELECT m.*, (SELECT COUNT(*) FROM ${eventsTbl} WHERE mission_id = m.id) as events_count
                  FROM ${table} m WHERE m.id = @id`,
          params: { id },
        });
        if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
        const [watchers] = await bigquery.query({
          query: `SELECT w.id, w.user_id, u.name as user_name
                  FROM ${watchersTbl} w LEFT JOIN ${usersTbl} u ON w.user_id = u.id
                  WHERE w.mission_id = @id`,
          params: { id },
        });
        rows[0].watchers = watchers;
        res.json(rows[0]);
        return;
      }

      // GET /missions?view=dashboard&user_id=X
      if (view === 'dashboard' && user_id) {
        const [rows] = await bigquery.query({
          query: `SELECT m.*,
                    CASE
                      WHEN m.status IN ('open','in_progress','blocked') AND m.due_at < CURRENT_TIMESTAMP() THEN 'overdue'
                      WHEN DATE(m.due_at) = CURRENT_DATE() THEN 'today'
                      WHEN m.due_at <= TIMESTAMP_ADD(CURRENT_TIMESTAMP(), INTERVAL 7 DAY) THEN 'this_week'
                      WHEN m.due_at IS NULL AND m.status NOT IN ('done','cancelled') THEN 'no_date'
                      WHEN m.status = 'done' AND DATE(m.closed_at) = CURRENT_DATE() THEN 'done_today'
                      ELSE 'other'
                    END as \`group\`,
                    CASE WHEN w.user_id IS NOT NULL AND m.assignee_id != @user_id THEN true ELSE false END as is_watching
                  FROM ${table} m
                  LEFT JOIN ${watchersTbl} w ON w.mission_id = m.id AND w.user_id = @user_id
                  WHERE m.assignee_id = @user_id
                     OR w.user_id IS NOT NULL
                  ORDER BY m.due_at ASC`,
          params: { user_id },
        });
        res.json(rows);
        return;
      }

      // GET /missions?needs_triage=true
      if (needs_triage === 'true') {
        if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }
        const [rows] = await bigquery.query({
          query: `SELECT * FROM ${table} WHERE needs_triage = true ORDER BY created_at DESC`,
        });
        res.json(rows);
        return;
      }

      // GET /missions?entity_type=X&entity_id=Y
      if (entity_type && entity_id) {
        const [rows] = await bigquery.query({
          query: `SELECT * FROM ${table} WHERE entity_type = @entity_type AND entity_id = @entity_id ORDER BY created_at DESC`,
          params: { entity_type, entity_id },
        });
        res.json(rows);
        return;
      }

      // GET /missions?assignee_id=X
      if (assignee_id) {
        const [rows] = await bigquery.query({
          query: `SELECT * FROM ${table} WHERE assignee_id = @assignee_id ORDER BY created_at DESC`,
          params: { assignee_id },
        });
        res.json(rows);
        return;
      }

      res.status(400).json({ error: 'Query parameter required: assignee_id, entity_type+entity_id, needs_triage, or view=dashboard' });
      return;
    }

    // POST /missions/:id/reopen
    if (req.method === 'POST' && segments.length >= 2 && segments[1] === 'reopen') {
      const id = segments[0];
      const user = await getUserByEmail(email);
      if (!user) { res.status(403).json({ error: 'User not found' }); return; }

      await bigquery.query({
        query: `UPDATE ${table} SET status = 'in_progress', closed_at = NULL, closed_by = NULL, updated_at = CURRENT_TIMESTAMP() WHERE id = @id`,
        params: { id },
      });
      await logEvent(id, 'reopened', {}, user.id);
      res.json({ success: true });
      return;
    }

    // POST /missions — create
    if (req.method === 'POST') {
      const b = req.body || {};
      const user = await getUserByEmail(email);
      if (!user) { res.status(403).json({ error: 'User not found' }); return; }

      const id = crypto.randomUUID();
      await bigquery.query({
        query: `INSERT INTO ${table}
                  (id, title, description, status, priority, assignee_id, author_id, entity_type, entity_id,
                   due_at, needs_triage, source, template_id, parent_id, closed_at, closed_by, created_at, updated_at)
                VALUES
                  (@id, @title, @description, @status, @priority, NULLIF(@assignee_id,''), @author_id, NULLIF(@entity_type,''), NULLIF(@entity_id,''),
                   @due_at, @needs_triage, NULLIF(@source,''), NULLIF(@template_id,''), NULLIF(@parent_id,''), NULL, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
        params: {
          id,
          title: b.title || '',
          description: b.description || '',
          status: b.status || 'open',
          priority: b.priority || 'medium',
          assignee_id: b.assignee_id || '',
          author_id: b.author_id || user.id,
          entity_type: b.entity_type || '',
          entity_id: b.entity_id || '',
          due_at: b.due_at ? bigquery.timestamp(new Date(b.due_at)) : null,
          needs_triage: b.needs_triage === true,
          source: b.source || '',
          template_id: b.template_id || '',
          parent_id: b.parent_id || '',
        },
      });
      await logEvent(id, 'created', { title: b.title }, user.id);
      res.json({ success: true, id });
      return;
    }

    // PATCH /missions/:id — partial update
    if (req.method === 'PATCH') {
      const id = segments[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      const user = await getUserByEmail(email);
      if (!user) { res.status(403).json({ error: 'User not found' }); return; }

      const [existing] = await bigquery.query({
        query: `SELECT * FROM ${table} WHERE id = @id`,
        params: { id },
      });
      if (existing.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
      const old = existing[0];
      const b = req.body || {};

      const sets = ['updated_at = CURRENT_TIMESTAMP()'];
      const params = { id };

      if (b.title !== undefined) { sets.push('title = @title'); params.title = b.title; }
      if (b.description !== undefined) { sets.push('description = @description'); params.description = b.description; }
      if (b.priority !== undefined) { sets.push('priority = @priority'); params.priority = b.priority; }
      if (b.assignee_id !== undefined) { sets.push('assignee_id = NULLIF(@assignee_id,\'\')'); params.assignee_id = b.assignee_id || ''; }
      if (b.entity_type !== undefined) { sets.push('entity_type = NULLIF(@entity_type,\'\')'); params.entity_type = b.entity_type || ''; }
      if (b.entity_id !== undefined) { sets.push('entity_id = NULLIF(@entity_id,\'\')'); params.entity_id = b.entity_id || ''; }
      if (b.needs_triage !== undefined) { sets.push('needs_triage = @needs_triage'); params.needs_triage = b.needs_triage === true; }
      if (b.source !== undefined) { sets.push('source = NULLIF(@source,\'\')'); params.source = b.source || ''; }
      if (b.template_id !== undefined) { sets.push('template_id = NULLIF(@template_id,\'\')'); params.template_id = b.template_id || ''; }
      if (b.parent_id !== undefined) { sets.push('parent_id = NULLIF(@parent_id,\'\')'); params.parent_id = b.parent_id || ''; }

      if (b.due_at !== undefined) {
        sets.push('due_at = @due_at');
        params.due_at = b.due_at ? bigquery.timestamp(new Date(b.due_at)) : null;
      }

      if (b.status !== undefined) {
        sets.push('status = @status');
        params.status = b.status;
        if ((b.status === 'done' || b.status === 'cancelled') && old.status !== 'done' && old.status !== 'cancelled') {
          sets.push('closed_at = CURRENT_TIMESTAMP()');
          sets.push('closed_by = @closed_by');
          params.closed_by = user.id;
        }
      }

      await bigquery.query({
        query: `UPDATE ${table} SET ${sets.join(', ')} WHERE id = @id`,
        params,
      });

      // Track changes and create events
      if (b.status !== undefined && b.status !== old.status) {
        await logEvent(id, 'status_changed', { from: old.status, to: b.status }, user.id);
      }
      if (b.assignee_id !== undefined && b.assignee_id !== old.assignee_id) {
        await logEvent(id, 'assigned', { from: old.assignee_id, to: b.assignee_id }, user.id);
      }
      if (b.due_at !== undefined) {
        const oldDue = old.due_at ? old.due_at.value || String(old.due_at) : null;
        const newDue = b.due_at || null;
        if (oldDue !== newDue) {
          await logEvent(id, 'due_changed', { from: oldDue, to: newDue }, user.id);
        }
      }
      if (b.priority !== undefined && b.priority !== old.priority) {
        await logEvent(id, 'priority_changed', { from: old.priority, to: b.priority }, user.id);
      }

      res.json({ success: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
