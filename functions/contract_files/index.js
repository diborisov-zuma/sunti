const { BigQuery } = require('@google-cloud/bigquery');
const { Storage }  = require('@google-cloud/storage');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const storage  = new Storage();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'contract_files';
const BUCKET   = 'sunti-private';
const SIGN_TTL_MS = 10 * 60 * 1000;

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
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

function parseKey(url) {
  const m = (url || '').match(/^https:\/\/storage\.googleapis\.com\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { bucket: m[1], key: decodeURIComponent(m[2]) };
}

function sanitize(name) {
  return (name || 'file').replace(/[^\w.\-]+/g, '_');
}

exports.contract_files = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const path  = (req.url || '').split('?')[0];

  try {
    // POST /contract_files/signed-upload-url
    if (req.method === 'POST' && path === '/signed-upload-url') {
      const { contract_id, folder_id, file_name, content_type } = req.body || {};
      if (!contract_id || !folder_id || !file_name) {
        res.status(400).json({ error: 'contract_id, folder_id and file_name are required' });
        return;
      }
      const key = `${folder_id}/contracts/${contract_id}/${Date.now()}_${sanitize(file_name)}`;
      const [upload_url] = await storage.bucket(BUCKET).file(key).getSignedUrl({
        version: 'v4', action: 'write',
        expires: Date.now() + SIGN_TTL_MS,
        contentType: content_type || 'application/octet-stream',
      });
      res.json({ upload_url, file_url: `https://storage.googleapis.com/${BUCKET}/${key}` });
      return;
    }

    // GET /contract_files/<id>/signed-download-url
    if (req.method === 'GET' && path.endsWith('/signed-download-url')) {
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }
      const [rows] = await bigquery.query({
        query: `SELECT file_url, file_name FROM ${table} WHERE id = @id`,
        params: { id },
      });
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      const parsed = parseKey(rows[0].file_url);
      if (!parsed) { res.status(500).json({ error: 'Bad file_url' }); return; }
      const [url] = await storage.bucket(parsed.bucket).file(parsed.key).getSignedUrl({
        version: 'v4', action: 'read',
        expires: Date.now() + SIGN_TTL_MS,
        responseDisposition: `attachment; filename="${encodeURIComponent(rows[0].file_name || 'file')}"`,
      });
      res.json({ url });
      return;
    }

    // GET /contract_files?contract_id=xxx
    if (req.method === 'GET') {
      const contractId = req.query.contract_id;
      if (!contractId) { res.status(400).json({ error: 'contract_id is required' }); return; }
      const [rows] = await bigquery.query({
        query: `SELECT id, contract_id, file_name, file_url, file_size, uploaded_by, uploaded_at
                FROM ${table} WHERE contract_id = @contract_id ORDER BY uploaded_at DESC`,
        params: { contract_id: contractId },
      });
      res.json(rows);
      return;
    }

    // POST — register file after signed upload
    if (req.method === 'POST') {
      const { contract_id, file_name, file_url, file_size } = req.body;
      if (!contract_id || !file_url) {
        res.status(400).json({ error: 'contract_id and file_url are required' });
        return;
      }
      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table} (id, contract_id, file_name, file_url, file_size, uploaded_by, uploaded_at)
                VALUES (@id, @contract_id, @file_name, @file_url, @file_size, @uploaded_by, CURRENT_TIMESTAMP())`,
        params: {
          id, contract_id,
          file_name: file_name || '',
          file_url,
          file_size: parseInt(file_size || 0),
          uploaded_by: email,
        },
      });
      res.json({ success: true, id });
      return;
    }

    // DELETE
    if (req.method === 'DELETE') {
      const id = path.split('/').filter(Boolean).pop();
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }
      const [rows] = await bigquery.query({
        query: `SELECT file_url FROM ${table} WHERE id = @id`,
        params: { id },
      });
      if (rows.length) {
        const parsed = parseKey(rows[0].file_url);
        if (parsed) {
          try { await storage.bucket(parsed.bucket).file(parsed.key).delete({ ignoreNotFound: true }); }
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
