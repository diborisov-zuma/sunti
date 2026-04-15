const { BigQuery } = require('@google-cloud/bigquery');
const { Storage }  = require('@google-cloud/storage');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const storage  = new Storage();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'bank_statements';
const BUCKET   = 'sunti-site';
const SIGN_TTL_MS = 10 * 60 * 1000;

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
    query: `SELECT email, is_admin FROM \`${PROJECT}.${DATASET}.users\` WHERE email = @email`,
    params: { email },
  });
  return rows[0] || null;
}

async function getCompanyAccess(email, company_id) {
  const [rows] = await bigquery.query({
    query: `SELECT statement_access FROM \`${PROJECT}.${DATASET}.users_statements\`
            WHERE user_email = @email AND company_id = @company_id`,
    params: { email, company_id },
  });
  return rows[0]?.statement_access || 'none';
}

function parseKey(url) {
  const m = (url || '').match(/^https:\/\/storage\.googleapis\.com\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { bucket: m[1], key: decodeURIComponent(m[2]) };
}

function sanitize(name) {
  return (name || 'file').replace(/[^\w.\-]+/g, '_');
}

exports.bank_statements = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const path  = (req.url || '').split('?')[0];
  const user  = await getUser(email);
  if (!user) { res.status(403).json({ error: 'Forbidden' }); return; }

  try {
    // GET /bank_statements/my-companies — список доступных юр. лиц
    if (req.method === 'GET' && path === '/my-companies') {
      if (user.is_admin) {
        const [rows] = await bigquery.query({
          query: `SELECT id, name, registration_number FROM \`${PROJECT}.${DATASET}.companies\` ORDER BY name ASC`,
        });
        res.json(rows.map(c => ({ ...c, statement_access: 'editor' })));
        return;
      }
      const [rows] = await bigquery.query({
        query: `SELECT c.id, c.name, c.registration_number, us.statement_access
                FROM \`${PROJECT}.${DATASET}.users_statements\` us
                JOIN \`${PROJECT}.${DATASET}.companies\` c ON c.id = us.company_id
                WHERE us.user_email = @email AND us.statement_access != 'none'
                ORDER BY c.name ASC`,
        params: { email },
      });
      res.json(rows);
      return;
    }

    // GET /bank_statements/<id>/signed-download-url
    if (req.method === 'GET' && path.endsWith('/signed-download-url')) {
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }
      const [rows] = await bigquery.query({
        query: `SELECT company_id, file_url, file_name FROM ${table} WHERE id = @id`,
        params: { id },
      });
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      if (!user.is_admin) {
        const acc = await getCompanyAccess(email, rows[0].company_id);
        if (acc === 'none') { res.status(403).json({ error: 'Forbidden' }); return; }
      }
      const parsed = parseKey(rows[0].file_url);
      if (!parsed) { res.status(404).json({ error: 'No file' }); return; }
      const [url] = await storage.bucket(parsed.bucket).file(parsed.key).getSignedUrl({
        version: 'v4', action: 'read',
        expires: Date.now() + SIGN_TTL_MS,
        responseDisposition: `attachment; filename="${encodeURIComponent(rows[0].file_name || 'statement')}"`,
      });
      res.json({ url });
      return;
    }

    // POST /bank_statements/signed-upload-url → { upload_url, file_url }
    if (req.method === 'POST' && path === '/signed-upload-url') {
      const { company_id, statement_id, file_name, content_type } = req.body || {};
      if (!company_id || !statement_id || !file_name) {
        res.status(400).json({ error: 'company_id, statement_id and file_name are required' });
        return;
      }
      if (!user.is_admin) {
        const acc = await getCompanyAccess(email, company_id);
        if (acc !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }
      }
      const key = `${company_id}/statements/${statement_id}/${Date.now()}_${sanitize(file_name)}`;
      const [upload_url] = await storage.bucket(BUCKET).file(key).getSignedUrl({
        version: 'v4', action: 'write',
        expires: Date.now() + SIGN_TTL_MS,
        contentType: content_type || 'application/octet-stream',
      });
      res.json({ upload_url, file_url: `https://storage.googleapis.com/${BUCKET}/${key}` });
      return;
    }

    // GET /bank_statements?company_id=X&search=&date_from=&date_to=
    if (req.method === 'GET') {
      const { company_id, search, date_from, date_to } = req.query;
      if (!company_id) { res.status(400).json({ error: 'company_id is required' }); return; }
      if (!user.is_admin) {
        const acc = await getCompanyAccess(email, company_id);
        if (acc === 'none') { res.status(403).json({ error: 'Forbidden' }); return; }
      }
      let where = 'WHERE company_id = @company_id';
      const params = { company_id };
      if (search)    { where += ' AND LOWER(name) LIKE LOWER(@search)'; params.search = `%${search.trim()}%`; }
      if (date_from) { where += ' AND date >= @date_from'; params.date_from = date_from; }
      if (date_to)   { where += ' AND date <= @date_to';   params.date_to   = date_to; }
      if (req.query.account_id) { where += ' AND account_id = @account_id'; params.account_id = req.query.account_id; }

      const [rows] = await bigquery.query({
        query: `SELECT id, company_id, account_id, name, date, file_name, file_url, file_size, uploaded_at, uploaded_by
                FROM ${table} ${where}
                ORDER BY date DESC NULLS LAST, uploaded_at DESC`,
        params,
      });
      res.json(rows);
      return;
    }

    // POST — создать запись
    if (req.method === 'POST') {
      const { company_id, account_id, name, date, file_name, file_url, file_size } = req.body || {};
      if (!company_id || !name) { res.status(400).json({ error: 'company_id and name are required' }); return; }
      if (!user.is_admin) {
        const acc = await getCompanyAccess(email, company_id);
        if (acc !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }
      }
      const id = req.body.id || uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table}
                  (id, company_id, account_id, name, date, file_name, file_url, file_size, uploaded_by, uploaded_at)
                VALUES
                  (@id, @company_id, NULLIF(@account_id,''), @name, IF(@date = '', NULL, DATE(@date)),
                   NULLIF(@file_name,''), NULLIF(@file_url,''), @file_size, @uploaded_by, CURRENT_TIMESTAMP())`,
        params: {
          id, company_id,
          account_id: account_id || '',
          name,
          date:       date || '',
          file_name:  file_name || '',
          file_url:   file_url  || '',
          file_size:  parseInt(file_size || 0),
          uploaded_by: email,
        },
      });
      res.json({ success: true, id });
      return;
    }

    // PUT — редактировать
    if (req.method === 'PUT') {
      const id = path.split('/').filter(Boolean)[0];
      const { account_id, name, date, file_name, file_url, file_size, replace_file } = req.body || {};
      if (!id || !name) { res.status(400).json({ error: 'id and name are required' }); return; }

      const [rows] = await bigquery.query({
        query: `SELECT company_id, file_url AS old_file_url FROM ${table} WHERE id = @id`,
        params: { id },
      });
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      const cur = rows[0];

      if (!user.is_admin) {
        const acc = await getCompanyAccess(email, cur.company_id);
        if (acc !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }
      }

      // Если заменяется файл или явно сносится — удалить старый из GCS
      if (replace_file && cur.old_file_url) {
        const p = parseKey(cur.old_file_url);
        if (p) {
          try { await storage.bucket(p.bucket).file(p.key).delete({ ignoreNotFound: true }); }
          catch (e) { console.error('GCS delete failed', e.message); }
        }
      }

      await bigquery.query({
        query: `UPDATE ${table}
                SET account_id = NULLIF(@account_id,''),
                    name       = @name,
                    date       = IF(@date = '', NULL, DATE(@date)),
                    file_name  = IF(@replace_file, NULLIF(@file_name,''), file_name),
                    file_url   = IF(@replace_file, NULLIF(@file_url,''),  file_url),
                    file_size  = IF(@replace_file, @file_size,            file_size)
                WHERE id = @id`,
        params: {
          id,
          account_id: account_id || '',
          name,
          date:       date || '',
          file_name:  file_name || '',
          file_url:   file_url  || '',
          file_size:  parseInt(file_size || 0),
          replace_file: !!replace_file,
        },
      });
      res.json({ success: true });
      return;
    }

    // DELETE — удалить запись + GCS файл
    if (req.method === 'DELETE') {
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      const [rows] = await bigquery.query({
        query: `SELECT company_id, file_url FROM ${table} WHERE id = @id`,
        params: { id },
      });
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      if (!user.is_admin) {
        const acc = await getCompanyAccess(email, rows[0].company_id);
        if (acc !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }
      }
      if (rows[0].file_url) {
        const p = parseKey(rows[0].file_url);
        if (p) {
          try { await storage.bucket(p.bucket).file(p.key).delete({ ignoreNotFound: true }); }
          catch (e) { console.error('GCS delete failed', e.message); }
        }
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
