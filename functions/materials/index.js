const { BigQuery } = require('@google-cloud/bigquery');
const { Storage }  = require('@google-cloud/storage');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');

const bigquery = new BigQuery();
const storage  = new Storage();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const BUCKET   = 'sunti-site';
const SIGN_TTL_MS = 10 * 60 * 1000;

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
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

async function getMaterialsLevel(email, folderId) {
  const [uRows] = await bigquery.query({
    query: `SELECT is_admin FROM \`${PROJECT}.${DATASET}.users\` WHERE email = @email`,
    params: { email },
  });
  if (uRows[0]?.is_admin) return 'editor';
  const [uf] = await bigquery.query({
    query: `SELECT materials_level FROM \`${PROJECT}.${DATASET}.users_folders\`
            WHERE user_email = @email AND folder_id = @fid`,
    params: { email, fid: folderId },
  });
  return uf[0]?.materials_level || 'none';
}

// Also check portal users for portal access
async function getPortalMaterialsAccess(email) {
  const [pu] = await bigquery.query({
    query: `SELECT pu.id FROM \`${PROJECT}.${DATASET}.portal_users\` pu
            WHERE pu.email = @email AND IFNULL(pu.is_active, TRUE) = TRUE`,
    params: { email },
  });
  if (!pu.length) return null;
  const [ps] = await bigquery.query({
    query: `SELECT access_level FROM \`${PROJECT}.${DATASET}.portal_users_sections\`
            WHERE portal_user_id = @id AND section = 'materials'`,
    params: { id: pu[0].id },
  });
  if (!ps.length) return null;
  const [pf] = await bigquery.query({
    query: `SELECT folder_id FROM \`${PROJECT}.${DATASET}.portal_users_folders\`
            WHERE portal_user_id = @id`,
    params: { id: pu[0].id },
  });
  return { access_level: ps[0].access_level, folder_ids: pf.map(f => f.folder_id) };
}

function parseKey(url) {
  const m = (url || '').match(/^https:\/\/storage\.googleapis\.com\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { bucket: m[1], key: decodeURIComponent(m[2]) };
}

function sanitize(name) {
  return (name || 'file').replace(/[^\w.\-]+/g, '_');
}

const matTable  = `\`${PROJECT}.${DATASET}.materials\``;
const mfTable   = `\`${PROJECT}.${DATASET}.material_files\``;
const mcTable   = `\`${PROJECT}.${DATASET}.material_comments\``;

async function addAutoComment(materialId, email, text) {
  await bigquery.query({
    query: `INSERT INTO ${mcTable} (id, material_id, text, author_email, author_name, created_at)
            VALUES (@id, @matId, @text, @email, '⚙ system', CURRENT_TIMESTAMP())`,
    params: { id: uuidv4(), matId: materialId, text, email },
  });
}

const STATUS_LABELS = {
  pending_approval: 'Pending approval',
  approved: 'Approved',
  rejected: 'Rejected',
  archived: 'Archived',
};

exports.materials = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const path = (req.url || '').split('?')[0];

  try {
    // POST /materials/signed-upload-url
    if (req.method === 'POST' && path === '/signed-upload-url') {
      const { folder_id, material_id, file_name, content_type } = req.body || {};
      if (!folder_id || !material_id || !file_name) {
        res.status(400).json({ error: 'folder_id, material_id, file_name required' }); return;
      }
      const key = `${folder_id}/materials/${material_id}/${Date.now()}_${sanitize(file_name)}`;
      const [upload_url] = await storage.bucket(BUCKET).file(key).getSignedUrl({
        version: 'v4', action: 'write',
        expires: Date.now() + SIGN_TTL_MS,
        contentType: content_type || 'application/octet-stream',
      });
      res.json({ upload_url, file_url: `https://storage.googleapis.com/${BUCKET}/${key}` });
      return;
    }

    // GET /materials/files/:id/signed-download-url
    if (req.method === 'GET' && path.includes('/files/') && path.endsWith('/signed-download-url')) {
      const fileId = path.split('/files/')[1].split('/')[0];
      const [rows] = await bigquery.query({
        query: `SELECT file_url, file_name FROM ${mfTable} WHERE id = @id`,
        params: { id: fileId },
      });
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      const parsed = parseKey(rows[0].file_url);
      if (!parsed) { res.status(500).json({ error: 'Bad file URL' }); return; }
      const [url] = await storage.bucket(parsed.bucket).file(parsed.key).getSignedUrl({
        version: 'v4', action: 'read',
        expires: Date.now() + SIGN_TTL_MS,
        responseDisposition: `attachment; filename="${encodeURIComponent(rows[0].file_name || 'file')}"`,
      });
      res.json({ url });
      return;
    }

    // GET /materials/files/:id/signed-view-url (for image preview — inline, not download)
    if (req.method === 'GET' && path.includes('/files/') && path.endsWith('/signed-view-url')) {
      const fileId = path.split('/files/')[1].split('/')[0];
      const [rows] = await bigquery.query({
        query: `SELECT file_url, file_name, content_type, thumb_url FROM ${mfTable} WHERE id = @id`,
        params: { id: fileId },
      });
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }

      // Return both thumb and original signed URLs
      const parsed = parseKey(rows[0].file_url);
      if (!parsed) { res.status(500).json({ error: 'Bad file URL' }); return; }
      const [url] = await storage.bucket(parsed.bucket).file(parsed.key).getSignedUrl({
        version: 'v4', action: 'read',
        expires: Date.now() + SIGN_TTL_MS,
        responseType: rows[0].content_type || 'application/octet-stream',
      });

      let thumb_signed = '';
      if (rows[0].thumb_url) {
        const tp = parseKey(rows[0].thumb_url);
        if (tp) {
          const [tu] = await storage.bucket(tp.bucket).file(tp.key).getSignedUrl({
            version: 'v4', action: 'read',
            expires: Date.now() + SIGN_TTL_MS,
            responseType: 'image/jpeg',
          });
          thumb_signed = tu;
        }
      }

      res.json({ url, thumb_url: thumb_signed || '' });
      return;
    }

    // GET /materials/:id/comments
    if (req.method === 'GET' && path.endsWith('/comments')) {
      const matId = path.split('/').filter(Boolean)[0];
      const [rows] = await bigquery.query({
        query: `SELECT id, material_id, text, author_email, author_name, created_at
                FROM ${mcTable} WHERE material_id = @id ORDER BY created_at DESC`,
        params: { id: matId },
      });
      res.json(rows);
      return;
    }

    // POST /materials/:id/comments
    if (req.method === 'POST' && path.endsWith('/comments')) {
      const matId = path.split('/').filter(Boolean)[0];
      const { text, author_name } = req.body || {};
      if (!text) { res.status(400).json({ error: 'text required' }); return; }
      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${mcTable} (id, material_id, text, author_email, author_name, created_at)
                VALUES (@id, @matId, @text, @email, @author_name, CURRENT_TIMESTAMP())`,
        params: { id, matId, text, email, author_name: author_name || email },
      });
      res.json({ success: true, id });
      return;
    }

    // GET /materials/:id/files
    if (req.method === 'GET' && path.endsWith('/files')) {
      const matId = path.split('/').filter(Boolean)[0];
      const [rows] = await bigquery.query({
        query: `SELECT id, material_id, file_url, file_name, file_size, content_type, thumb_url, uploaded_by, uploaded_at
                FROM ${mfTable} WHERE material_id = @id ORDER BY uploaded_at ASC`,
        params: { id: matId },
      });
      res.json(rows);
      return;
    }

    // POST /materials/:id/files — register file after upload
    if (req.method === 'POST' && path.endsWith('/files')) {
      const matId = path.split('/').filter(Boolean)[0];
      const { file_url, file_name, file_size, content_type } = req.body || {};
      if (!file_url) { res.status(400).json({ error: 'file_url required' }); return; }
      const id = uuidv4();
      // Generate thumbnail if image
      let thumb_url = '';
      const isImg = (content_type || '').startsWith('image/') ||
        /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(file_name || '');
      if (isImg && file_url) {
        try {
          const parsed = parseKey(file_url);
          if (parsed) {
            const [buffer] = await storage.bucket(parsed.bucket).file(parsed.key).download();
            const thumbBuffer = await sharp(buffer).resize(300, 300, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
            const thumbKey = parsed.key.replace(/(\.[^.]+)$/, '_thumb.jpg');
            await storage.bucket(parsed.bucket).file(thumbKey).save(thumbBuffer, { metadata: { contentType: 'image/jpeg' } });
            thumb_url = `https://storage.googleapis.com/${parsed.bucket}/${thumbKey}`;
          }
        } catch(e) { console.error('Thumbnail generation failed:', e.message); }
      }

      await bigquery.query({
        query: `INSERT INTO ${mfTable} (id, material_id, file_url, file_name, file_size, content_type, thumb_url, uploaded_by, uploaded_at)
                VALUES (@id, @matId, @file_url, @file_name, @file_size, @content_type, NULLIF(@thumb_url,''), @email, CURRENT_TIMESTAMP())`,
        params: { id, matId, file_url, file_name: file_name || '', file_size: parseInt(file_size || 0), content_type: content_type || '', thumb_url, email },
      });
      await addAutoComment(matId, email, `File added: ${file_name || 'file'}`);
      res.json({ success: true, id });
      return;
    }

    // DELETE /materials/files/:id
    if (req.method === 'DELETE' && path.includes('/files/')) {
      const fileId = path.split('/files/')[1]?.split('/')[0]?.split('?')[0];
      if (!fileId) { res.status(400).json({ error: 'file id required' }); return; }
      const [rows] = await bigquery.query({
        query: `SELECT file_url, file_name, material_id, thumb_url FROM ${mfTable} WHERE id = @id`, params: { id: fileId },
      });
      if (rows.length) {
        const parsed = parseKey(rows[0].file_url);
        if (parsed) {
          try { await storage.bucket(parsed.bucket).file(parsed.key).delete({ ignoreNotFound: true }); }
          catch(e) { console.error('GCS delete failed', e.message); }
        }
        if (rows[0].thumb_url) {
          const tp = parseKey(rows[0].thumb_url);
          if (tp) {
            try { await storage.bucket(tp.bucket).file(tp.key).delete({ ignoreNotFound: true }); }
            catch(e) { console.error('Thumb delete failed', e.message); }
          }
        }
        await addAutoComment(rows[0].material_id, email, `File deleted: ${rows[0].file_name || 'file'}`);
      }
      await bigquery.query({ query: `DELETE FROM ${mfTable} WHERE id = @id`, params: { id: fileId } });
      res.json({ success: true });
      return;
    }

    // PATCH /materials/:id/status — update status
    if (req.method === 'PATCH' && path.endsWith('/status')) {
      const matId = path.split('/').filter(Boolean)[0];
      const { status } = req.body || {};
      if (!status) { res.status(400).json({ error: 'status required' }); return; }

      // Get old status for auto-comment
      const [old] = await bigquery.query({
        query: `SELECT status FROM ${matTable} WHERE id = @id`, params: { id: matId },
      });
      const oldStatus = old[0]?.status || '—';

      await bigquery.query({
        query: `UPDATE ${matTable} SET status = @status, status_date = CURRENT_TIMESTAMP(), status_by = @email WHERE id = @id`,
        params: { id: matId, status, email },
      });

      await addAutoComment(matId, email, `Status changed: ${STATUS_LABELS[oldStatus] || oldStatus} → ${STATUS_LABELS[status] || status}`);
      res.json({ success: true });
      return;
    }

    // GET /materials?folder_id=X
    if (req.method === 'GET') {
      const folderId = req.query.folder_id;
      if (!folderId) { res.status(400).json({ error: 'folder_id required' }); return; }

      // Check access level (cabinet user or portal user)
      let level = await getMaterialsLevel(email, folderId);
      let isPortal = false;
      if (level === 'none') {
        const portalAccess = await getPortalMaterialsAccess(email);
        if (portalAccess && portalAccess.folder_ids.includes(folderId)) {
          level = portalAccess.access_level === 'editor' ? 'editor' : 'viewer';
          isPortal = true;
        }
      }
      if (level === 'none') { res.status(403).json({ error: 'Forbidden' }); return; }

      const [rows] = await bigquery.query({
        query: `SELECT m.id, m.folder_id, m.name, m.description, m.status,
                       m.status_date, m.status_by, m.sort_order,
                       m.created_by, m.created_at,
                       (SELECT COUNT(*) FROM ${mfTable} WHERE material_id = m.id) AS file_count,
                       (SELECT COUNT(*) FROM ${mcTable} WHERE material_id = m.id) AS comment_count
                FROM ${matTable} m
                WHERE m.folder_id = @fid
                ORDER BY m.sort_order ASC, m.created_at DESC`,
        params: { fid: folderId },
      });
      res.json({ rows, access_level: level, is_portal: isPortal });
      return;
    }

    // POST /materials — create
    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.folder_id || !b.name) { res.status(400).json({ error: 'folder_id and name required' }); return; }

      const level = await getMaterialsLevel(email, b.folder_id);
      if (level !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }

      const id = uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${matTable} (id, folder_id, name, description, status, status_date, status_by, sort_order, created_by, created_at)
                VALUES (@id, @folder_id, @name, NULLIF(@description,''), @status, CURRENT_TIMESTAMP(), @email, @sort_order, @email, CURRENT_TIMESTAMP())`,
        params: {
          id, folder_id: b.folder_id, name: b.name,
          description: b.description || '', status: b.status || 'pending_approval',
          sort_order: parseInt(b.sort_order || 0), email,
        },
      });
      await addAutoComment(id, email, `Material created: ${b.name}`);
      res.json({ success: true, id });
      return;
    }

    // PUT /materials/:id
    if (req.method === 'PUT') {
      const id = path.split('/').filter(Boolean)[0];
      const b = req.body || {};
      if (!id || !b.name) { res.status(400).json({ error: 'id and name required' }); return; }

      const [existing] = await bigquery.query({
        query: `SELECT folder_id FROM ${matTable} WHERE id = @id`, params: { id },
      });
      if (!existing.length) { res.status(404).json({ error: 'Not found' }); return; }

      const level = await getMaterialsLevel(email, existing[0].folder_id);
      if (level !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }

      await bigquery.query({
        query: `UPDATE ${matTable}
                SET name = @name, description = NULLIF(@description,''),
                    status = @status, status_date = CURRENT_TIMESTAMP(), status_by = @email,
                    sort_order = @sort_order
                WHERE id = @id`,
        params: {
          id, name: b.name, description: b.description || '',
          status: b.status || 'pending_approval',
          sort_order: parseInt(b.sort_order || 0),
        },
      });
      res.json({ success: true });
      return;
    }

    // DELETE /materials/:id
    if (req.method === 'DELETE' && !path.includes('/files/')) {
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id required' }); return; }

      const [existing] = await bigquery.query({
        query: `SELECT folder_id FROM ${matTable} WHERE id = @id`, params: { id },
      });
      if (!existing.length) { res.status(404).json({ error: 'Not found' }); return; }

      const level = await getMaterialsLevel(email, existing[0].folder_id);
      if (level !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }

      // Delete files from GCS
      const [files] = await bigquery.query({
        query: `SELECT file_url FROM ${mfTable} WHERE material_id = @id`, params: { id },
      });
      for (const f of files) {
        const parsed = parseKey(f.file_url);
        if (parsed) {
          try { await storage.bucket(parsed.bucket).file(parsed.key).delete({ ignoreNotFound: true }); }
          catch(e) { console.error('GCS delete failed', e.message); }
        }
      }

      await bigquery.query({ query: `DELETE FROM ${mcTable} WHERE material_id = @id`, params: { id } });
      await bigquery.query({ query: `DELETE FROM ${mfTable} WHERE material_id = @id`, params: { id } });
      await bigquery.query({ query: `DELETE FROM ${matTable} WHERE id = @id`, params: { id } });
      res.json({ success: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
};
