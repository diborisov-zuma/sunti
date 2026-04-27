const { BigQuery } = require('@google-cloud/bigquery');
const bigquery = new BigQuery();
const PROJECT = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET = 'sunti';

const contactTable = `\`${PROJECT}.${DATASET}.wa_contacts\``;
const msgTable     = `\`${PROJECT}.${DATASET}.wa_messages\``;

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function verifyToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.split(' ')[1];
  const r = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
  if (!r.ok) return null;
  return (await r.json()).email || null;
}

async function isAdmin(email) {
  const [rows] = await bigquery.query({
    query: `SELECT is_admin FROM \`${PROJECT}.${DATASET}.users\` WHERE email = @email`,
    params: { email },
  });
  return rows[0]?.is_admin === true;
}

exports.wa_inbox = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }
  if (!(await isAdmin(email))) { res.status(403).json({ error: 'Forbidden' }); return; }

  const path = (req.url || '').split('?')[0];

  try {
    // GET /wa_inbox/contacts — list chats
    if (req.method === 'GET' && (path === '/contacts' || path === '/')) {
      const filter = req.query.filter || 'all'; // all, new, client, agent, unknown
      let where = 'WHERE 1=1';
      if (filter === 'new') where += ' AND is_new = TRUE';
      else if (filter === 'client') where += " AND contact_type = 'client'";
      else if (filter === 'agent') where += " AND contact_type = 'agent'";
      else if (filter === 'unknown') where += " AND (contact_type = 'unknown' OR contact_type IS NULL)";

      const search = req.query.search;
      if (search) {
        where += ' AND (LOWER(name) LIKE LOWER(@search) OR phone LIKE @search)';
      }

      const [rows] = await bigquery.query({
        query: `SELECT c.id, c.phone, c.name, c.contact_type, c.contact_type_by,
                       c.notes, c.first_message_at, c.last_message_at,
                       c.message_count, c.is_new,
                       lm.text AS last_text
                FROM ${contactTable} c
                LEFT JOIN (
                  SELECT contact_id, text, ROW_NUMBER() OVER (PARTITION BY contact_id ORDER BY created_at DESC) AS rn
                  FROM ${msgTable}
                ) lm ON lm.contact_id = c.id AND lm.rn = 1
                ${where}
                ORDER BY c.last_message_at DESC
                LIMIT 100`,
        params: search ? { search: `%${search.trim()}%` } : {},
      });
      res.json(rows);
      return;
    }

    // GET /wa_inbox/messages?contact_id=X — messages for a contact
    if (req.method === 'GET' && path === '/messages') {
      const contactId = req.query.contact_id;
      if (!contactId) { res.status(400).json({ error: 'contact_id required' }); return; }

      const limit = parseInt(req.query.limit || 50);
      const offset = parseInt(req.query.offset || 0);

      const [rows] = await bigquery.query({
        query: `SELECT id, contact_id, phone, direction, message_type, text,
                       media_url, media_filename, media_size, created_at
                FROM ${msgTable}
                WHERE contact_id = @cid
                ORDER BY created_at ASC
                LIMIT ${limit} OFFSET ${offset}`,
        params: { cid: contactId },
      });

      // Mark as not new (we've seen it)
      await bigquery.query({
        query: `UPDATE ${contactTable} SET is_new = FALSE WHERE id = @id AND is_new = TRUE`,
        params: { id: contactId },
      });

      res.json(rows);
      return;
    }

    // PUT /wa_inbox/contacts/:id — update contact (type, notes)
    if (req.method === 'PUT') {
      const id = path.split('/').filter(Boolean).pop().split('?')[0];
      const { contact_type, notes } = req.body || {};
      if (!id) { res.status(400).json({ error: 'id required' }); return; }

      const sets = [];
      const params = { id };
      if (contact_type !== undefined) {
        sets.push('contact_type = @ct, contact_type_by = \'manual\'');
        params.ct = contact_type;
      }
      if (notes !== undefined) {
        sets.push('notes = @notes');
        params.notes = notes;
      }

      if (sets.length) {
        await bigquery.query({
          query: `UPDATE ${contactTable} SET ${sets.join(', ')} WHERE id = @id`,
          params,
        });
      }
      res.json({ success: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
};
