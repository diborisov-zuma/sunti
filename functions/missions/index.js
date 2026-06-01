const { BigQuery } = require('@google-cloud/bigquery');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'missions';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8766299522:AAGfJ9mdsOWv2f_HgNsRH0sjC3XweStQWRQ';

// Fixed enums — single source of truth, exposed via GET /missions/meta
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const STATUSES   = ['open', 'in_progress', 'blocked', 'done', 'cancelled'];

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');
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

// Resolve an assignee by email → users.id (case-insensitive). Null if not found.
async function resolveAssigneeId(email) {
  const [rows] = await bigquery.query({
    query: `SELECT id FROM \`${PROJECT}.${DATASET}.users\` WHERE LOWER(email) = LOWER(@email) LIMIT 1`,
    params: { email },
  });
  return rows[0]?.id || null;
}

// Translate ru title/description → en + th via Haiku. Never throws — returns blanks on failure.
async function translateFields(title, description) {
  const out = { title_en: '', title_th: '', description_en: '', description_th: '' };
  if (!process.env.ANTHROPIC_API_KEY) return out;
  const parts = [];
  if (title)       parts.push(`TITLE: ${title}`);
  if (description) parts.push(`DESCRIPTION: ${description}`);
  if (!parts.length) return out;
  try {
    const client = new Anthropic();
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Translate the following task fields from Russian to English and Thai.\n` +
          `Return ONLY a JSON object with keys title_en, title_th, description_en, description_th. ` +
          `Use empty string for any field not provided. No explanation.\n\n${parts.join('\n')}`,
      }],
    });
    const content = msg.content[0]?.text || '{}';
    const m = content.match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : {};
    return {
      title_en: j.title_en || '',
      title_th: j.title_th || '',
      description_en: j.description_en || '',
      description_th: j.description_th || '',
    };
  } catch (e) {
    console.error('translateFields failed:', e.message);
    return out;
  }
}

// Push a Telegram message to the assignee if they linked their chat. Never throws.
async function notifyAssigneeTg(assigneeId, mission) {
  try {
    const [rows] = await bigquery.query({
      query: `SELECT telegram_chat_id FROM \`${PROJECT}.${DATASET}.users\` WHERE id = @id LIMIT 1`,
      params: { id: assigneeId },
    });
    const chatId = rows[0]?.telegram_chat_id;
    if (!chatId) return;
    let text = `📋 <b>Новая задача</b>\n${mission.title || ''}`;
    if (mission.due_at) text += `\n🗓 Срок: ${String(mission.due_at).slice(0, 10)}`;
    await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    console.error('notifyAssigneeTg failed:', e.message);
  }
}

exports.missions = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  // Auth: either a Google OAuth token (browser) or a machine API key (bot).
  const apiKey = req.headers['x-api-key'];
  const isBot  = !!apiKey && !!process.env.BOT_API_KEY && apiKey === process.env.BOT_API_KEY;
  const email  = isBot ? (process.env.BOT_USER_EMAIL || 'di.borisov@gmail.com') : await verifyToken(req);
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

      // GET /missions/meta — enums + active user roster (for the bot to build a valid payload)
      if (segments[0] === 'meta') {
        const [users] = await bigquery.query({
          query: `SELECT id, name, email FROM ${usersTbl} WHERE is_active IS NOT FALSE ORDER BY name`,
        });
        res.json({ priorities: PRIORITIES, statuses: STATUSES, users });
        return;
      }

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
          query: `SELECT m.*, m.assignee_id AS assignee_user_id,
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
      const title = b.title_ru || b.title || '';
      const description = b.description_ru || b.description || '';

      // Resolve assignee: explicit id wins, else by email; bot defaults to author (self).
      let assignee = b.assignee_user_id || b.assignee_id || '';
      if (!assignee && b.assignee_email) {
        const aid = await resolveAssigneeId(b.assignee_email);
        if (!aid) { res.status(400).json({ error: `Assignee not found: ${b.assignee_email}` }); return; }
        assignee = aid;
      }
      if (!assignee && isBot) assignee = user.id;

      // Server-side ru→en/th translation for bot-created missions when not supplied.
      let titleEn = b.title_en || '', titleTh = b.title_th || '';
      let descEn  = b.description_en || '', descTh = b.description_th || '';
      if (isBot && (!titleEn || !titleTh || (description && (!descEn || !descTh)))) {
        const tr = await translateFields(title, description);
        titleEn = titleEn || tr.title_en; titleTh = titleTh || tr.title_th;
        descEn  = descEn  || tr.description_en; descTh = descTh || tr.description_th;
      }

      await bigquery.query({
        query: `INSERT INTO ${table}
                  (id, title, title_en, title_th, description, description_en, description_th,
                   status, priority, assignee_id, author_id, entity_type, entity_id,
                   due_at, needs_triage, template_id, parent_mission_id, closed_at, closed_by, created_at, updated_at)
                VALUES
                  (@id, @title, NULLIF(@title_en,''), NULLIF(@title_th,''),
                   @description, NULLIF(@description_en,''), NULLIF(@description_th,''),
                   @status, @priority, NULLIF(@assignee_id,''), @author_id, NULLIF(@entity_type,''), NULLIF(@entity_id,''),
                   @due_at, @needs_triage, NULLIF(@template_id,''), NULLIF(@parent_mission_id,''), NULL, NULL, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP())`,
        params: {
          id,
          title,
          title_en: titleEn,
          title_th: titleTh,
          description,
          description_en: descEn,
          description_th: descTh,
          status: b.status || 'open',
          priority: b.priority || 'normal',
          assignee_id: assignee,
          author_id: b.author_id || user.id,
          entity_type: b.entity_type || '',
          entity_id: b.entity_id || '',
          due_at: b.due_at ? bigquery.timestamp(new Date(b.due_at)) : null,
          needs_triage: b.needs_triage === true,
          template_id: b.template_id || '',
          parent_mission_id: b.parent_mission_id || '',
        },
      });

      // Create watchers
      const watcherIds = b.watcher_user_ids || [];
      for (const wid of watcherIds) {
        await bigquery.query({
          query: `INSERT INTO ${watchersTbl} (id, mission_id, user_id, added_at, added_by) VALUES (@id, @mid, @uid, CURRENT_TIMESTAMP(), @by)`,
          params: { id: crypto.randomUUID(), mid: id, uid: wid, by: user.id },
        });
      }

      await logEvent(id, 'created', { title }, user.id);

      if (b.notify_tg === true && assignee) {
        await notifyAssigneeTg(assignee, { title, due_at: b.due_at });
      }

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

      if (b.title !== undefined || b.title_ru !== undefined) { sets.push('title = @title'); params.title = b.title_ru || b.title || ''; }
      if (b.title_en !== undefined) { sets.push('title_en = NULLIF(@title_en,\'\')'); params.title_en = b.title_en || ''; }
      if (b.title_th !== undefined) { sets.push('title_th = NULLIF(@title_th,\'\')'); params.title_th = b.title_th || ''; }
      if (b.description !== undefined || b.description_ru !== undefined) { sets.push('description = @description'); params.description = b.description_ru || b.description || ''; }
      if (b.description_en !== undefined) { sets.push('description_en = NULLIF(@description_en,\'\')'); params.description_en = b.description_en || ''; }
      if (b.description_th !== undefined) { sets.push('description_th = NULLIF(@description_th,\'\')'); params.description_th = b.description_th || ''; }
      if (b.priority !== undefined) { sets.push('priority = @priority'); params.priority = b.priority; }
      const patchAssignee = b.assignee_user_id !== undefined ? b.assignee_user_id : b.assignee_id;
      if (patchAssignee !== undefined) { sets.push('assignee_id = NULLIF(@assignee_id,\'\')'); params.assignee_id = patchAssignee || ''; }
      if (b.entity_type !== undefined) { sets.push('entity_type = NULLIF(@entity_type,\'\')'); params.entity_type = b.entity_type || ''; }
      if (b.entity_id !== undefined) { sets.push('entity_id = NULLIF(@entity_id,\'\')'); params.entity_id = b.entity_id || ''; }
      if (b.needs_triage !== undefined) { sets.push('needs_triage = @needs_triage'); params.needs_triage = b.needs_triage === true; }
      if (b.template_id !== undefined) { sets.push('template_id = NULLIF(@template_id,\'\')'); params.template_id = b.template_id || ''; }
      if (b.parent_mission_id !== undefined) { sets.push('parent_mission_id = NULLIF(@parent_mission_id,\'\')'); params.parent_mission_id = b.parent_mission_id || ''; }

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
