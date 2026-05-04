const { BigQuery } = require('@google-cloud/bigquery');
const { Storage }  = require('@google-cloud/storage');

const bigquery = new BigQuery();
const storage  = new Storage();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const SIGN_TTL_MS = 10 * 60 * 1000;

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function verifyToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.split(' ')[1];
  // Try as access token first
  const r1 = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
  if (r1.ok) { const info = await r1.json(); return info.email || null; }
  // Try as ID token (JWT) — works for in-app browsers where popup is blocked
  const r2 = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
  if (r2.ok) { const info = await r2.json(); return info.email || null; }
  return null;
}

/**
 * Get portal user by email. Returns { id, email, name, is_active } or null.
 */
async function getPortalUser(email) {
  const [rows] = await bigquery.query({
    query: `SELECT id, email, name, is_active FROM \`${PROJECT}.${DATASET}.portal_users\` WHERE email = @email`,
    params: { email },
  });
  return rows[0] || null;
}

/**
 * Get folder IDs this portal user can access.
 */
async function getPortalFolders(portalUserId) {
  const [rows] = await bigquery.query({
    query: `SELECT folder_id FROM \`${PROJECT}.${DATASET}.portal_users_folders\` WHERE portal_user_id = @id`,
    params: { id: portalUserId },
  });
  return rows.map(r => r.folder_id);
}

/**
 * Get section access for portal user. Returns { contracts: 'full'|'no_amounts', ... }
 */
async function getPortalSections(portalUserId) {
  const [rows] = await bigquery.query({
    query: `SELECT section, access_level FROM \`${PROJECT}.${DATASET}.portal_users_sections\` WHERE portal_user_id = @id`,
    params: { id: portalUserId },
  });
  const map = {};
  rows.forEach(r => { map[r.section] = r.access_level; });
  return map;
}

function parseKey(url) {
  const m = (url || '').match(/^https:\/\/storage\.googleapis\.com\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { bucket: m[1], key: decodeURIComponent(m[2]) };
}

exports.portal_contracts = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const path = (req.url || '').split('?')[0];

  // POST /portal_contracts/log-error — no auth required
  if (req.method === 'POST' && path === '/log-error') {
    try {
      const b = req.body || {};
      const logTable = `\`${PROJECT}.${DATASET}.portal_auth_logs\``;
      await bigquery.query({
        query: `INSERT INTO ${logTable} (id, email, error, step, user_agent, created_at)
                VALUES (@id, @email, @error, @step, @user_agent, CURRENT_TIMESTAMP())`,
        params: {
          id: `${Date.now()}-${Math.random().toString(36).slice(2,10)}`,
          email: b.email || 'unknown',
          error: (b.error || '').substring(0, 1000),
          step: (b.step || '').substring(0, 100),
          user_agent: (req.headers['user-agent'] || '').substring(0, 500),
        },
      });
    } catch(e) { console.error('Log error failed:', e.message); }
    res.json({ ok: true });
    return;
  }

  if (req.method !== 'GET') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const portalUser = await getPortalUser(email);
  if (!portalUser || !portalUser.is_active) { res.status(403).json({ error: 'No portal access' }); return; }

  const sections = await getPortalSections(portalUser.id);
  if (!sections.contracts) { res.status(403).json({ error: 'No access to contracts section' }); return; }

  const accessLevel = sections.contracts; // 'full' or 'no_amounts'
  const folderIds = await getPortalFolders(portalUser.id);
  if (!folderIds.length) { res.json([]); return; }

  const cTable   = `\`${PROJECT}.${DATASET}.contracts\``;
  const invTable = `\`${PROJECT}.${DATASET}.invoices\``;
  const trxTable = `\`${PROJECT}.${DATASET}.transactions\``;
  const fldTable = `\`${PROJECT}.${DATASET}.folders\``;
  const ctrTable = `\`${PROJECT}.${DATASET}.contractors\``;
  const catTable = `\`${PROJECT}.${DATASET}.categories\``;
  const cfTable  = `\`${PROJECT}.${DATASET}.contract_files\``;
  const ifTable  = `\`${PROJECT}.${DATASET}.invoice_files\``;
  const tfTable  = `\`${PROJECT}.${DATASET}.transaction_files\``;

  try {
    // GET /portal_contracts/me — portal user info + folders + sections
    if (path === '/me') {
      const [folders] = await bigquery.query({
        query: `SELECT f.id, f.name, f.company_id FROM ${fldTable} f WHERE f.id IN UNNEST(@ids) ORDER BY f.name`,
        params: { ids: folderIds },
      });
      res.json({ user: { id: portalUser.id, email: portalUser.email, name: portalUser.name }, sections, folders });
      return;
    }

    // GET /portal_contracts/files/:id/download — signed download URL
    if (path.includes('/files/') && path.endsWith('/download')) {
      const parts = path.split('/').filter(Boolean);
      const fileId = parts[parts.length - 2];
      const fileType = parts[parts.indexOf('files') - 1]; // 'contract' or 'invoice'

      // Try contract_files, invoice_files, then transaction_files
      let fileRow = null;
      const [cf] = await bigquery.query({ query: `SELECT file_url, file_name FROM ${cfTable} WHERE id = @id`, params: { id: fileId } });
      if (cf.length) fileRow = cf[0];
      if (!fileRow) {
        const [inf] = await bigquery.query({ query: `SELECT file_url, file_name FROM ${ifTable} WHERE id = @id`, params: { id: fileId } });
        if (inf.length) fileRow = inf[0];
      }
      if (!fileRow) {
        const [tf] = await bigquery.query({ query: `SELECT file_url, file_name FROM ${tfTable} WHERE id = @id`, params: { id: fileId } });
        if (tf.length) fileRow = tf[0];
      }
      if (!fileRow) { res.status(404).json({ error: 'File not found' }); return; }

      const parsed = parseKey(fileRow.file_url);
      if (!parsed) { res.status(500).json({ error: 'Bad file URL' }); return; }
      const isView = req.query.view === 'true';
      const disposition = isView
        ? `inline; filename="${encodeURIComponent(fileRow.file_name || 'file')}"`
        : `attachment; filename="${encodeURIComponent(fileRow.file_name || 'file')}"`;
      const [url] = await storage.bucket(parsed.bucket).file(parsed.key).getSignedUrl({
        version: 'v4', action: 'read',
        expires: Date.now() + SIGN_TTL_MS,
        responseDisposition: disposition,
      });
      res.json({ url });
      return;
    }

    // GET /portal_contracts/:id/invoices — invoices for a contract
    if (path.endsWith('/invoices')) {
      const contractId = path.split('/').filter(Boolean)[0];

      // Verify contract belongs to allowed folder
      const [cRows] = await bigquery.query({
        query: `SELECT folder_id FROM ${cTable} WHERE id = @id AND folder_id IN UNNEST(@fids) AND IFNULL(status,'active') != 'deleted'`,
        params: { id: contractId, fids: folderIds },
      });
      if (!cRows.length) { res.status(403).json({ error: 'Forbidden' }); return; }

      const amountFields = accessLevel === 'full'
        ? 'i.total_amount, i.paid_amount, i.subtotal, i.vat_amount, i.wht_amount, i.vat_rate, i.wht_rate'
        : 'CAST(0 AS NUMERIC) AS total_amount, CAST(0 AS NUMERIC) AS paid_amount, CAST(0 AS NUMERIC) AS subtotal, CAST(0 AS NUMERIC) AS vat_amount, CAST(0 AS NUMERIC) AS wht_amount, CAST(0 AS NUMERIC) AS vat_rate, CAST(0 AS NUMERIC) AS wht_rate';

      const [rows] = await bigquery.query({
        query: `SELECT i.id, i.name, i.date, i.status, i.direction, i.category_id, i.contract_id,
                       ${amountFields},
                       c.name AS category_name,
                       SAFE_DIVIDE(i.paid_amount, NULLIF(i.total_amount, 0)) AS paid_pct
                FROM ${invTable} i
                LEFT JOIN ${catTable} c ON i.category_id = c.id
                WHERE i.contract_id = @cid AND IFNULL(i.status,'active') != 'deleted'
                ORDER BY i.date DESC`,
        params: { cid: contractId },
      });

      // Load invoice files (only for full access)
      let invFilesMap = {};
      if (accessLevel === 'full' && rows.length) {
        const invIds = rows.map(r => r.id);
        const [iFiles] = await bigquery.query({
          query: `SELECT id, invoice_id, file_name, file_size FROM ${ifTable} WHERE invoice_id IN UNNEST(@ids) ORDER BY uploaded_at DESC`,
          params: { ids: invIds },
        });
        iFiles.forEach(f => {
          if (!invFilesMap[f.invoice_id]) invFilesMap[f.invoice_id] = [];
          invFilesMap[f.invoice_id].push(f);
        });
      }

      res.json({ rows, files: invFilesMap, access_level: accessLevel });
      return;
    }

    // GET /portal_contracts/:id/transactions?invoice_id=X or ?contract_id=X — transactions
    if (path.endsWith('/transactions')) {
      const invoiceId = req.query.invoice_id;
      const contractId = req.query.contract_id;
      if (!invoiceId && !contractId) { res.status(400).json({ error: 'invoice_id or contract_id required' }); return; }

      if (invoiceId) {
        // Verify invoice → contract → folder is allowed
        const [invCheck] = await bigquery.query({
          query: `SELECT i.contract_id, c.folder_id
                  FROM ${invTable} i
                  JOIN ${cTable} c ON i.contract_id = c.id
                  WHERE i.id = @iid AND c.folder_id IN UNNEST(@fids)`,
          params: { iid: invoiceId, fids: folderIds },
        });
        if (!invCheck.length) { res.status(403).json({ error: 'Forbidden' }); return; }
      } else {
        // Verify contract → folder is allowed
        const [cCheck] = await bigquery.query({
          query: `SELECT folder_id FROM ${cTable} WHERE id = @id AND folder_id IN UNNEST(@fids) AND IFNULL(status,'active') != 'deleted'`,
          params: { id: contractId, fids: folderIds },
        });
        if (!cCheck.length) { res.status(403).json({ error: 'Forbidden' }); return; }
      }

      const amountFields = accessLevel === 'full'
        ? 't.amount'
        : 'CAST(0 AS NUMERIC) AS amount';

      const whereClause = invoiceId
        ? 't.invoice_id = @iid'
        : 't.contract_id = @cid AND t.invoice_id IS NULL';
      const trxParams = invoiceId ? { iid: invoiceId } : { cid: contractId };

      const acctTable = `\`${PROJECT}.${DATASET}.company_accounts\``;
      const [rows] = await bigquery.query({
        query: `SELECT t.id, t.date, t.direction, t.description, t.category_id, t.folder_id,
                       t.account_id,
                       ${amountFields},
                       cat.name AS category_name,
                       a.name AS account_name
                FROM ${trxTable} t
                LEFT JOIN ${catTable} cat ON t.category_id = cat.id
                LEFT JOIN ${acctTable} a ON t.account_id = a.id
                WHERE ${whereClause} AND IFNULL(t.status,'active') != 'deleted'
                ORDER BY t.date DESC`,
        params: trxParams,
      });

      // Load transaction files (only for full access)
      let trxFilesMap = {};
      if (accessLevel === 'full' && rows.length) {
        const trxIds = rows.map(r => r.id);
        const [tFiles] = await bigquery.query({
          query: `SELECT id, transaction_id, file_name, file_size FROM ${tfTable} WHERE transaction_id IN UNNEST(@ids) ORDER BY uploaded_at DESC`,
          params: { ids: trxIds },
        });
        tFiles.forEach(f => {
          if (!trxFilesMap[f.transaction_id]) trxFilesMap[f.transaction_id] = [];
          trxFilesMap[f.transaction_id].push(f);
        });
      }

      res.json({ rows, files: trxFilesMap, access_level: accessLevel });
      return;
    }

    // GET /portal_contracts?folder_id=X — contracts list
    const folderId = req.query.folder_id;
    if (!folderId || !folderIds.includes(folderId)) {
      res.status(400).json({ error: 'folder_id is required and must be accessible' });
      return;
    }

    const amountFields = accessLevel === 'full'
      ? `c.total_amount, c.subtotal, c.vat_amount, c.paid_amount,
         IFNULL(inv_agg.invoiced_total, CAST(0 AS NUMERIC)) AS invoiced_total`
      : `CAST(0 AS NUMERIC) AS total_amount, CAST(0 AS NUMERIC) AS subtotal, CAST(0 AS NUMERIC) AS vat_amount, CAST(0 AS NUMERIC) AS paid_amount,
         CAST(0 AS NUMERIC) AS invoiced_total`;

    let extraWhere = '';
    const params = { fid: folderId };
    if (req.query.search) { extraWhere += ' AND LOWER(c.name) LIKE LOWER(@search)'; params.search = `%${req.query.search.trim()}%`; }
    if (req.query.contractor_id) { extraWhere += ' AND c.contractor_id = @contractor_id'; params.contractor_id = req.query.contractor_id; }
    if (req.query.status === 'active') { extraWhere += " AND c.status IN ('estimate','confirmed','active','in_stock','delivered','completed')"; }
    else if (req.query.status) { extraWhere += ' AND c.status = @status'; params.status = req.query.status; }

    const [rows] = await bigquery.query({
      query: `SELECT c.id, c.name, c.external_ref, c.date, c.direction, c.status,
                     c.payment_terms, c.notes, c.contractor_id, c.needs_review, c.progress_pct,
                     ${amountFields},
                     IFNULL(inv_agg.invoice_count, 0) AS invoice_count,
                     SAFE_DIVIDE(c.paid_amount, NULLIF(c.total_amount, 0)) AS paid_pct,
                     f.name AS folder_name,
                     ct.name_en AS contractor_name_en, ct.name_th AS contractor_name_th
              FROM ${cTable} c
              JOIN ${fldTable} f ON c.folder_id = f.id
              LEFT JOIN ${ctrTable} ct ON c.contractor_id = ct.id
              LEFT JOIN (
                SELECT contract_id,
                       SUM(total_amount) AS invoiced_total,
                       COUNT(*) AS invoice_count
                FROM ${invTable}
                WHERE IFNULL(status,'active') != 'deleted' AND contract_id IS NOT NULL
                GROUP BY contract_id
              ) inv_agg ON inv_agg.contract_id = c.id
              WHERE c.folder_id = @fid AND IFNULL(c.status,'active') != 'deleted'
              ${extraWhere}
              ORDER BY c.date DESC NULLS LAST`,
      params,
    });

    // Load contract files
    const contractIds = rows.map(r => r.id);
    let filesMap = {};
    if (contractIds.length) {
      const [files] = await bigquery.query({
        query: `SELECT id, contract_id, file_name, file_size FROM ${cfTable} WHERE contract_id IN UNNEST(@ids) ORDER BY uploaded_at DESC`,
        params: { ids: contractIds },
      });
      files.forEach(f => {
        if (!filesMap[f.contract_id]) filesMap[f.contract_id] = [];
        filesMap[f.contract_id].push(f);
      });
    }

    // Load contractors for filter dropdown
    const [contractors] = await bigquery.query({
      query: `SELECT DISTINCT ct.id, ct.name_en, ct.name_th
              FROM ${cTable} c JOIN ${ctrTable} ct ON c.contractor_id = ct.id
              WHERE c.folder_id = @fid AND IFNULL(c.status,'active') != 'deleted'
              ORDER BY ct.name_en`,
      params: { fid: folderId },
    });

    res.json({ rows, files: filesMap, contractors, access_level: accessLevel });
    return;

  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
