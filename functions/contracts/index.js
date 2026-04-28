const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'contracts';

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

async function getFolderAccess(email, folderId) {
  const [rows] = await bigquery.query({
    query: `SELECT docs_access FROM \`${PROJECT}.${DATASET}.users_folders\`
            WHERE user_email = @email AND folder_id = @folder_id`,
    params: { email, folder_id: folderId },
  });
  return rows[0]?.docs_access || 'none';
}

async function recalcContractPaid(contractId) {
  if (!contractId) return;
  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const invTable = `\`${PROJECT}.${DATASET}.invoices\``;
  const trxTable = `\`${PROJECT}.${DATASET}.transactions\``;
  await bigquery.query({
    query: `UPDATE ${table}
            SET paid_amount = CAST((
              COALESCE((SELECT SUM(paid_amount) FROM ${invTable}
                WHERE contract_id = @id AND IFNULL(status, 'active') != 'deleted'), 0)
              + COALESCE((SELECT SUM(amount) FROM ${trxTable}
                WHERE contract_id = @id AND invoice_id IS NULL AND IFNULL(status, 'active') != 'deleted'), 0)
            ) AS NUMERIC)
            WHERE id = @id`,
    params: { id: contractId },
  });
}

exports.contracts = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table    = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const invTable = `\`${PROJECT}.${DATASET}.invoices\``;
  const fldTable = `\`${PROJECT}.${DATASET}.folders\``;
  const ctrTable = `\`${PROJECT}.${DATASET}.contractors\``;
  const path     = (req.url || '').split('?')[0];
  const user     = await getUser(email);
  if (!user) { res.status(403).json({ error: 'Forbidden' }); return; }

  try {
    // GET /contracts/:id/invoices — список привязанных инвойсов
    if (req.method === 'GET' && path.endsWith('/invoices')) {
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }
      const catTable = `\`${PROJECT}.${DATASET}.categories\``;
      const [rows] = await bigquery.query({
        query: `SELECT i.id, i.folder_id, i.name, i.status, i.direction,
                       i.total_amount, i.paid_amount, i.subtotal, i.vat_amount, i.wht_amount,
                       i.category_id, i.contractor_id, i.contract_id, i.date,
                       i.uploaded_by, i.uploaded_at,
                       c.name as category_name,
                       ct.name_en as contractor_name_en, ct.name_th as contractor_name_th
                FROM ${invTable} i
                LEFT JOIN ${catTable} c ON i.category_id = c.id
                LEFT JOIN ${ctrTable} ct ON i.contractor_id = ct.id
                WHERE i.contract_id = @id AND IFNULL(i.status, 'active') != 'deleted'
                ORDER BY i.date DESC, i.uploaded_at DESC`,
        params: { id },
      });
      res.json(rows);
      return;
    }

    // GET /contracts — список с фильтрами
    if (req.method === 'GET') {
      const { company_id, folder_id, contractor_id, status, date_from, date_to } = req.query;

      // company_id обязателен
      if (!company_id) { res.json([]); return; }

      let where = 'WHERE f.company_id = @company_id AND IFNULL(c.status, \'active\') != \'deleted\'';
      const params = { company_id };

      // RBAC: не-админ видит только свои папки
      if (!user.is_admin) {
        where += ` AND c.folder_id IN (
          SELECT folder_id FROM \`${PROJECT}.${DATASET}.users_folders\`
          WHERE user_email = @email
        )`;
        params.email = email;
      }

      if (req.query.search) { where += ' AND LOWER(c.name) LIKE LOWER(@search)'; params.search = `%${req.query.search.trim()}%`; }
      if (req.query.responsible) { where += ' AND c.responsible_email = @responsible'; params.responsible = req.query.responsible; }
      if (folder_id)     { where += ' AND c.folder_id = @folder_id'; params.folder_id = folder_id; }
      if (contractor_id) { where += ' AND c.contractor_id = @contractor_id'; params.contractor_id = contractor_id; }
      if (status === 'active') { where += " AND c.status IN ('estimate','confirmed','active')"; }
      else if (status && status !== 'all') { where += ' AND c.status = @status'; params.status = status; }
      if (date_from) { where += ' AND c.date >= @date_from'; params.date_from = date_from; }
      if (date_to)   { where += ' AND c.date <= @date_to';   params.date_to   = date_to; }

      const [rows] = await bigquery.query({
        query: `SELECT c.id, c.folder_id, c.contractor_id, c.name, c.external_ref,
                       c.date, c.direction, c.total_amount, c.subtotal, c.vat_amount,
                       c.paid_amount, c.payment_terms, c.status, c.notes,
                       c.progress_pct, c.progress_notes, c.responsible_email, c.needs_review,
                       c.created_by, c.created_at,
                       f.name AS folder_name,
                       ct.name_en AS contractor_name_en, ct.name_th AS contractor_name_th,
                       IFNULL(inv_agg.invoiced_total, CAST(0 AS NUMERIC)) AS invoiced_total,
                       IFNULL(inv_agg.invoice_count, 0) AS invoice_count,
                       IFNULL(cf_agg.file_count, 0) AS file_count
                FROM ${table} c
                JOIN ${fldTable} f ON c.folder_id = f.id
                LEFT JOIN ${ctrTable} ct ON c.contractor_id = ct.id
                LEFT JOIN (
                  SELECT contract_id,
                         SUM(total_amount) AS invoiced_total,
                         COUNT(*) AS invoice_count
                  FROM ${invTable}
                  WHERE IFNULL(status, 'active') != 'deleted' AND contract_id IS NOT NULL
                  GROUP BY contract_id
                ) inv_agg ON inv_agg.contract_id = c.id
                LEFT JOIN (
                  SELECT contract_id, COUNT(*) AS file_count
                  FROM \`${PROJECT}.${DATASET}.contract_files\`
                  GROUP BY contract_id
                ) cf_agg ON cf_agg.contract_id = c.id
                ${where}
                ORDER BY c.date DESC NULLS LAST, c.created_at DESC`,
        params,
      });
      res.json(rows);
      return;
    }

    // POST — создать контракт
    if (req.method === 'POST') {
      const b = req.body || {};
      if (!b.folder_id || !b.contractor_id || !b.name) {
        res.status(400).json({ error: 'folder_id, contractor_id and name are required' });
        return;
      }
      // RBAC
      if (!user.is_admin) {
        const acc = await getFolderAccess(email, b.folder_id);
        if (acc !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }
      }

      const id = b.id || uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table}
                  (id, folder_id, contractor_id, name, external_ref, date, direction,
                   total_amount, subtotal, vat_amount, paid_amount,
                   payment_terms, status, notes, progress_pct, progress_notes, responsible_email, needs_review,
                   created_by, created_at)
                VALUES
                  (@id, @folder_id, @contractor_id, @name, NULLIF(@external_ref,''),
                   IF(@date = '', NULL, DATE(@date)), @direction,
                   CAST(@total_amount AS NUMERIC), CAST(@subtotal AS NUMERIC),
                   CAST(@vat_amount AS NUMERIC), CAST('0' AS NUMERIC),
                   NULLIF(@payment_terms,''), 'active', NULLIF(@notes,''),
                   CAST(@progress_pct AS NUMERIC), NULLIF(@progress_notes,''), NULLIF(@responsible_email,''), @needs_review,
                   @created_by, CURRENT_TIMESTAMP())`,
        params: {
          id,
          folder_id:      b.folder_id,
          contractor_id:  b.contractor_id,
          name:           b.name,
          external_ref:   b.external_ref || '',
          date:           b.date || '',
          direction:      b.direction || 'expense',
          total_amount:   b.total_amount != null ? String(b.total_amount) : '0',
          subtotal:       b.subtotal != null ? String(b.subtotal) : '0',
          vat_amount:     b.vat_amount != null ? String(b.vat_amount) : '0',
          payment_terms:  b.payment_terms || '',
          progress_pct:   b.progress_pct != null ? String(b.progress_pct) : '0',
          progress_notes: b.progress_notes || '',
          responsible_email: b.responsible_email || '',
          needs_review:  !!b.needs_review,
          notes:         b.notes || '',
          created_by:    email,
        },
      });
      res.json({ success: true, id });
      return;
    }

    // PUT — обновить контракт
    if (req.method === 'PUT') {
      const id = path.split('/').filter(Boolean)[0];
      const b = req.body || {};
      if (!id || !b.name) { res.status(400).json({ error: 'id and name are required' }); return; }

      // Check exists + get folder for RBAC
      const [existing] = await bigquery.query({
        query: `SELECT folder_id FROM ${table} WHERE id = @id AND IFNULL(status, 'active') != 'deleted'`,
        params: { id },
      });
      if (!existing.length) { res.status(404).json({ error: 'Not found' }); return; }

      if (!user.is_admin) {
        const acc = await getFolderAccess(email, existing[0].folder_id);
        if (acc !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }
      }

      await bigquery.query({
        query: `UPDATE ${table}
                SET name          = @name,
                    external_ref  = NULLIF(@external_ref,''),
                    date          = IF(@date = '', NULL, DATE(@date)),
                    direction     = @direction,
                    total_amount  = CAST(@total_amount AS NUMERIC),
                    subtotal      = CAST(@subtotal AS NUMERIC),
                    vat_amount    = CAST(@vat_amount AS NUMERIC),
                    payment_terms  = NULLIF(@payment_terms,''),
                    status         = @status,
                    notes          = NULLIF(@notes,''),
                    progress_pct   = CAST(@progress_pct AS NUMERIC),
                    progress_notes = NULLIF(@progress_notes,''),
                    responsible_email = NULLIF(@responsible_email,''),
                    needs_review = @needs_review
                WHERE id = @id`,
        params: {
          id,
          name:           b.name,
          external_ref:   b.external_ref || '',
          date:           b.date || '',
          direction:      b.direction || 'expense',
          total_amount:   b.total_amount != null ? String(b.total_amount) : '0',
          subtotal:       b.subtotal != null ? String(b.subtotal) : '0',
          vat_amount:     b.vat_amount != null ? String(b.vat_amount) : '0',
          payment_terms:  b.payment_terms || '',
          status:         b.status || 'active',
          notes:          b.notes || '',
          progress_pct:   b.progress_pct != null ? String(b.progress_pct) : '0',
          progress_notes: b.progress_notes || '',
          responsible_email: b.responsible_email || '',
          needs_review: b.needs_review !== undefined ? !!b.needs_review : false,
        },
      });
      res.json({ success: true });
      return;
    }

    // DELETE — soft delete (запрет если есть активные инвойсы)
    if (req.method === 'DELETE') {
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      const [existing] = await bigquery.query({
        query: `SELECT folder_id FROM ${table} WHERE id = @id AND IFNULL(status, 'active') != 'deleted'`,
        params: { id },
      });
      if (!existing.length) { res.status(404).json({ error: 'Not found' }); return; }

      if (!user.is_admin) {
        const acc = await getFolderAccess(email, existing[0].folder_id);
        if (acc !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }
      }

      // Check for linked active invoices
      const [linked] = await bigquery.query({
        query: `SELECT COUNT(*) AS cnt FROM ${invTable}
                WHERE contract_id = @id AND IFNULL(status, 'active') != 'deleted'`,
        params: { id },
      });
      if (parseInt(linked[0].cnt) > 0) {
        res.status(400).json({ error: 'Cannot delete: unlink all invoices first' });
        return;
      }

      await bigquery.query({
        query: `UPDATE ${table} SET status = 'deleted' WHERE id = @id`,
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

// Экспортируем для использования из других функций (дублирование, как принято в проекте)
exports.recalcContractPaid = recalcContractPaid;
