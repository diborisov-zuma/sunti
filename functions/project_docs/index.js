const { BigQuery } = require('@google-cloud/bigquery');
const { Storage }  = require('@google-cloud/storage');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const storage  = new Storage();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
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
  return (await r.json()).email || null;
}

async function getUser(email) {
  const [rows] = await bigquery.query({
    query: `SELECT u.email, u.is_admin,
                   (SELECT docs_level FROM \`${PROJECT}.${DATASET}.users_folders\`
                    WHERE user_email = u.email AND folder_id = @fid LIMIT 1) AS docs_level
            FROM \`${PROJECT}.${DATASET}.users\` u WHERE u.email = @email`,
    params: { email, fid: '__placeholder__' },
  });
  return rows[0] || null;
}

async function getDocsLevel(email, folderId) {
  const [rows] = await bigquery.query({
    query: `SELECT is_admin FROM \`${PROJECT}.${DATASET}.users\` WHERE email = @email`,
    params: { email },
  });
  if (rows[0]?.is_admin) return 'editor';
  const [uf] = await bigquery.query({
    query: `SELECT docs_level FROM \`${PROJECT}.${DATASET}.users_folders\`
            WHERE user_email = @email AND folder_id = @fid`,
    params: { email, fid: folderId },
  });
  return uf[0]?.docs_level || 'none';
}

function parseKey(url) {
  const m = (url || '').match(/^https:\/\/storage\.googleapis\.com\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { bucket: m[1], key: decodeURIComponent(m[2]) };
}

function sanitize(name) {
  return (name || 'file').replace(/[^\w.\-]+/g, '_');
}

const docTable = `\`${PROJECT}.${DATASET}.project_docs\``;
const verTable = `\`${PROJECT}.${DATASET}.project_doc_versions\``;
const catTable = `\`${PROJECT}.${DATASET}.project_doc_categories\``;
const vfTable  = `\`${PROJECT}.${DATASET}.project_doc_version_files\``;

let vfTableEnsured = false;
async function ensureVfTable() {
  if (vfTableEnsured) return;
  await bigquery.query({
    query: `CREATE TABLE IF NOT EXISTS ${vfTable} (
      id STRING NOT NULL,
      version_id STRING NOT NULL,
      document_id STRING NOT NULL,
      file_url STRING,
      file_name STRING,
      file_size INT64,
      uploaded_by STRING,
      uploaded_at TIMESTAMP
    )`,
  });
  vfTableEnsured = true;
}

exports.project_docs = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const path = (req.url || '').split('?')[0];

  try {
    // GET /project_docs/signed-upload-url
    if (req.method === 'POST' && path === '/signed-upload-url') {
      const { folder_id, document_id, file_name, content_type } = req.body || {};
      if (!folder_id || !document_id || !file_name) {
        res.status(400).json({ error: 'folder_id, document_id, file_name required' });
        return;
      }
      const level = await getDocsLevel(email, folder_id);
      if (level !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }

      const key = `${folder_id}/docs/${document_id}/${Date.now()}_${sanitize(file_name)}`;
      const [upload_url] = await storage.bucket(BUCKET).file(key).getSignedUrl({
        version: 'v4', action: 'write',
        expires: Date.now() + SIGN_TTL_MS,
        contentType: content_type || 'application/octet-stream',
      });
      res.json({ upload_url, file_url: `https://storage.googleapis.com/${BUCKET}/${key}` });
      return;
    }

    // GET /project_docs/:id/signed-download-url (version file — legacy or version_file)
    if (req.method === 'GET' && path.endsWith('/signed-download-url')) {
      const fileId = path.split('/').filter(Boolean)[0];
      // Try version_files table first, then fall back to versions table (legacy)
      await ensureVfTable();
      let fileUrl, fileName;
      const [vfRows] = await bigquery.query({
        query: `SELECT file_url, file_name FROM ${vfTable} WHERE id = @id`,
        params: { id: fileId },
      });
      if (vfRows.length) {
        fileUrl = vfRows[0].file_url; fileName = vfRows[0].file_name;
      } else {
        const [rows] = await bigquery.query({
          query: `SELECT file_url, file_name FROM ${verTable} WHERE id = @id`,
          params: { id: fileId },
        });
        if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
        fileUrl = rows[0].file_url; fileName = rows[0].file_name;
      }
      const parsed = parseKey(fileUrl);
      if (!parsed) { res.status(500).json({ error: 'Bad file URL' }); return; }
      const [url] = await storage.bucket(parsed.bucket).file(parsed.key).getSignedUrl({
        version: 'v4', action: 'read',
        expires: Date.now() + SIGN_TTL_MS,
        responseDisposition: `attachment; filename="${encodeURIComponent(fileName || 'file')}"`,
      });
      res.json({ url });
      return;
    }

    // GET /project_docs/:verId/files — list files for a version
    if (req.method === 'GET' && path.endsWith('/files')) {
      const verId = path.split('/').filter(Boolean)[0];
      await ensureVfTable();
      const [rows] = await bigquery.query({
        query: `SELECT id, file_url, file_name, file_size, uploaded_by, uploaded_at
                FROM ${vfTable} WHERE version_id = @verId ORDER BY uploaded_at ASC`,
        params: { verId },
      });
      // Also include legacy file from version row itself
      const [verRows] = await bigquery.query({
        query: `SELECT id, file_url, file_name, file_size FROM ${verTable} WHERE id = @id AND file_url IS NOT NULL AND file_url != ''`,
        params: { id: verId },
      });
      const legacyFiles = verRows.map(v => ({ id: v.id, file_name: v.file_name, file_size: v.file_size, legacy: true }));
      res.json([...legacyFiles, ...rows]);
      return;
    }

    // GET /project_docs/:docId/versions
    if (req.method === 'GET' && path.endsWith('/versions')) {
      const docId = path.split('/').filter(Boolean)[0];
      await ensureVfTable();
      const [rows] = await bigquery.query({
        query: `SELECT v.id, v.document_id, v.version_number, v.file_name, v.file_size, v.notes, v.uploaded_by, v.uploaded_at,
                       (SELECT COUNT(*) FROM ${vfTable} vf WHERE vf.version_id = v.id) AS files_count
                FROM ${verTable} v WHERE v.document_id = @docId ORDER BY v.version_number DESC`,
        params: { docId },
      });
      res.json(rows);
      return;
    }

    // GET /project_docs?folder_id=X
    if (req.method === 'GET') {
      const folderId = req.query.folder_id;
      if (!folderId) { res.status(400).json({ error: 'folder_id required' }); return; }

      const level = await getDocsLevel(email, folderId);
      if (level === 'none') { res.status(403).json({ error: 'Forbidden' }); return; }

      await ensureVfTable();
      const [rows] = await bigquery.query({
        query: `SELECT d.id, d.folder_id, d.category_id, d.name, d.description,
                       d.current_version, d.sort_order, d.status,
                       d.created_by, d.created_at,
                       c.name AS category_name, c.name_en AS category_name_en,
                       v.file_name AS latest_file_name, v.file_size AS latest_file_size,
                       v.notes AS latest_notes, v.uploaded_at AS latest_uploaded_at,
                       v.id AS latest_version_id,
                       (SELECT COUNT(*) FROM ${vfTable} vf WHERE vf.version_id = v.id) AS latest_files_count
                FROM ${docTable} d
                LEFT JOIN ${catTable} c ON d.category_id = c.id
                LEFT JOIN ${verTable} v ON v.document_id = d.id AND v.version_number = d.current_version
                WHERE d.folder_id = @fid AND IFNULL(d.status, 'active') != 'archived'
                ORDER BY c.sort_order ASC, d.sort_order ASC, d.name ASC`,
        params: { fid: folderId },
      });
      res.json({ rows, access_level: level });
      return;
    }

    // POST /project_docs/versions/:verId/add-files — add files to existing version
    if (req.method === 'POST' && path.includes('/versions/') && path.endsWith('/add-files')) {
      const parts = path.split('/').filter(Boolean);
      const verId = parts[parts.indexOf('versions') + 1];
      const { files } = req.body || {};
      if (!verId || !files || !files.length) { res.status(400).json({ error: 'version_id and files required' }); return; }

      const [verRows] = await bigquery.query({
        query: `SELECT v.document_id, d.folder_id FROM ${verTable} v JOIN ${docTable} d ON d.id = v.document_id WHERE v.id = @id`,
        params: { id: verId },
      });
      if (!verRows.length) { res.status(404).json({ error: 'Version not found' }); return; }
      const level = await getDocsLevel(email, verRows[0].folder_id);
      if (level !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }

      await ensureVfTable();
      for (const f of files) {
        const fId = uuidv4();
        await bigquery.query({
          query: `INSERT INTO ${vfTable} (id, version_id, document_id, file_url, file_name, file_size, uploaded_by, uploaded_at)
                  VALUES (@id, @verId, @docId, @file_url, @file_name, @file_size, @email, CURRENT_TIMESTAMP())`,
          params: { id: fId, verId, docId: verRows[0].document_id, file_url: f.file_url, file_name: f.file_name || '', file_size: parseInt(f.file_size || 0), email },
        });
      }
      res.json({ success: true, count: files.length });
      return;
    }

    // DELETE /project_docs/version-files/:fileId
    if (req.method === 'DELETE' && path.includes('/version-files/')) {
      const fileId = path.split('/').filter(Boolean).pop();
      await ensureVfTable();
      const [rows] = await bigquery.query({
        query: `SELECT vf.file_url, d.folder_id FROM ${vfTable} vf
                JOIN ${docTable} d ON d.id = vf.document_id WHERE vf.id = @id`,
        params: { id: fileId },
      });
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      const level = await getDocsLevel(email, rows[0].folder_id);
      if (level !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }
      // Delete from GCS
      const parsed = parseKey(rows[0].file_url);
      if (parsed) {
        try { await storage.bucket(parsed.bucket).file(parsed.key).delete({ ignoreNotFound: true }); }
        catch(e) { console.error('GCS delete failed', e.message); }
      }
      await bigquery.query({ query: `DELETE FROM ${vfTable} WHERE id = @id`, params: { id: fileId } });
      res.json({ success: true });
      return;
    }

    // POST /project_docs — create document
    if (req.method === 'POST' && !path.endsWith('/versions') && !path.endsWith('/add-files') && path !== '/signed-upload-url') {
      const b = req.body || {};
      if (!b.folder_id || !b.name) { res.status(400).json({ error: 'folder_id and name required' }); return; }

      const level = await getDocsLevel(email, b.folder_id);
      if (level !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }

      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${docTable} (id, folder_id, category_id, name, description, current_version, sort_order, status, created_by, created_at)
                VALUES (@id, @folder_id, NULLIF(@category_id,''), @name, NULLIF(@description,''), 0, @sort_order, 'active', @email, CURRENT_TIMESTAMP())`,
        params: {
          id, folder_id: b.folder_id, category_id: b.category_id || '',
          name: b.name, description: b.description || '',
          sort_order: parseInt(b.sort_order || 0), email,
        },
      });
      res.json({ success: true, id });
      return;
    }

    // POST /project_docs/:docId/versions — upload new version (supports multiple files)
    if (req.method === 'POST' && path.endsWith('/versions')) {
      const docId = path.split('/').filter(Boolean)[0];
      const { file_url, file_name, file_size, files, notes } = req.body || {};
      // Support both legacy single-file and new multi-file format
      const fileList = files && files.length ? files : (file_url ? [{ file_url, file_name, file_size }] : []);
      if (!docId || !fileList.length) { res.status(400).json({ error: 'document_id and at least one file required' }); return; }

      const [docRows] = await bigquery.query({
        query: `SELECT folder_id, current_version FROM ${docTable} WHERE id = @id`,
        params: { id: docId },
      });
      if (!docRows.length) { res.status(404).json({ error: 'Document not found' }); return; }

      const level = await getDocsLevel(email, docRows[0].folder_id);
      if (level !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }

      const newVersion = (parseInt(docRows[0].current_version) || 0) + 1;
      const verId = uuidv4();

      // Create version row (no file_url — files go to version_files table)
      await bigquery.query({
        query: `INSERT INTO ${verTable} (id, document_id, version_number, file_url, file_name, file_size, notes, uploaded_by, uploaded_at)
                VALUES (@id, @docId, @ver, NULL, NULL, NULL, NULLIF(@notes,''), @email, CURRENT_TIMESTAMP())`,
        params: { id: verId, docId, ver: newVersion, notes: notes || '', email },
      });

      // Insert files into version_files table
      await ensureVfTable();
      for (const f of fileList) {
        const fId = uuidv4();
        await bigquery.query({
          query: `INSERT INTO ${vfTable} (id, version_id, document_id, file_url, file_name, file_size, uploaded_by, uploaded_at)
                  VALUES (@id, @verId, @docId, @file_url, @file_name, @file_size, @email, CURRENT_TIMESTAMP())`,
          params: { id: fId, verId, docId, file_url: f.file_url, file_name: f.file_name || '', file_size: parseInt(f.file_size || 0), email },
        });
      }

      await bigquery.query({
        query: `UPDATE ${docTable} SET current_version = @ver WHERE id = @id`,
        params: { id: docId, ver: newVersion },
      });

      res.json({ success: true, id: verId, version_number: newVersion });
      return;
    }

    // PUT /project_docs/:id
    if (req.method === 'PUT') {
      const id = path.split('/').filter(Boolean)[0];
      const b = req.body || {};

      const [docRows] = await bigquery.query({
        query: `SELECT folder_id FROM ${docTable} WHERE id = @id`,
        params: { id },
      });
      if (!docRows.length) { res.status(404).json({ error: 'Not found' }); return; }

      const level = await getDocsLevel(email, docRows[0].folder_id);
      if (level !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }

      await bigquery.query({
        query: `UPDATE ${docTable}
                SET name = @name, description = NULLIF(@description,''),
                    category_id = NULLIF(@category_id,''),
                    sort_order = @sort_order, status = @status
                WHERE id = @id`,
        params: {
          id, name: b.name || '', description: b.description || '',
          category_id: b.category_id || '',
          sort_order: parseInt(b.sort_order || 0),
          status: b.status || 'active',
        },
      });
      res.json({ success: true });
      return;
    }

    // DELETE /project_docs/:id
    if (req.method === 'DELETE') {
      const id = path.split('/').filter(Boolean)[0];

      const [docRows] = await bigquery.query({
        query: `SELECT folder_id FROM ${docTable} WHERE id = @id`,
        params: { id },
      });
      if (!docRows.length) { res.status(404).json({ error: 'Not found' }); return; }

      const level = await getDocsLevel(email, docRows[0].folder_id);
      if (level !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }

      // Delete all files from GCS — from both legacy versions and version_files
      await ensureVfTable();
      const [versions] = await bigquery.query({
        query: `SELECT file_url FROM ${verTable} WHERE document_id = @id AND file_url IS NOT NULL AND file_url != ''`,
        params: { id },
      });
      const [vfFiles] = await bigquery.query({
        query: `SELECT file_url FROM ${vfTable} WHERE document_id = @id`,
        params: { id },
      });
      for (const v of [...versions, ...vfFiles]) {
        const parsed = parseKey(v.file_url);
        if (parsed) {
          try { await storage.bucket(parsed.bucket).file(parsed.key).delete({ ignoreNotFound: true }); }
          catch(e) { console.error('GCS delete failed', e.message); }
        }
      }

      await bigquery.query({ query: `DELETE FROM ${vfTable} WHERE document_id = @id`, params: { id } });
      await bigquery.query({ query: `DELETE FROM ${verTable} WHERE document_id = @id`, params: { id } });
      await bigquery.query({ query: `DELETE FROM ${docTable} WHERE id = @id`, params: { id } });
      res.json({ success: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
};
