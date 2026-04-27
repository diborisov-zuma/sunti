const { BigQuery } = require('@google-cloud/bigquery');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';

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
  return (await r.json()).email || null;
}

const snapTable = `\`${PROJECT}.${DATASET}.project_snapshots\``;
const cTable    = `\`${PROJECT}.${DATASET}.contracts\``;
const invTable  = `\`${PROJECT}.${DATASET}.invoices\``;
const fldTable  = `\`${PROJECT}.${DATASET}.folders\``;
const ctrTable  = `\`${PROJECT}.${DATASET}.contractors\``;

exports.project_snapshots = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const path = (req.url || '').split('?')[0];

  try {
    // GET /project_snapshots/compare?folder_id=X&date1=YYYY-MM-DD&date2=YYYY-MM-DD
    if (req.method === 'GET' && path === '/compare') {
      const { folder_id, date1, date2 } = req.query;
      if (!folder_id || !date1 || !date2) {
        res.status(400).json({ error: 'folder_id, date1, date2 required' }); return;
      }
      const [rows1] = await bigquery.query({
        query: `SELECT * FROM ${snapTable} WHERE folder_id = @fid AND snapshot_date = DATE(@d)`,
        params: { fid: folder_id, d: date1 },
      });
      const [rows2] = await bigquery.query({
        query: `SELECT * FROM ${snapTable} WHERE folder_id = @fid AND snapshot_date = DATE(@d)`,
        params: { fid: folder_id, d: date2 },
      });
      res.json({ snapshot1: rows1, snapshot2: rows2 });
      return;
    }

    // GET /project_snapshots?folder_id=X — list of snapshots (grouped by date)
    if (req.method === 'GET') {
      const folderId = req.query.folder_id;
      if (!folderId) { res.status(400).json({ error: 'folder_id required' }); return; }

      const [rows] = await bigquery.query({
        query: `SELECT snapshot_date, snapshot_name, created_by, created_at,
                       COUNT(DISTINCT contract_id) AS contracts_count,
                       CAST(SUM(total_amount) AS NUMERIC) AS sum_total,
                       CAST(SUM(invoiced_total) AS NUMERIC) AS sum_invoiced,
                       CAST(SUM(paid_amount) AS NUMERIC) AS sum_paid
                FROM ${snapTable}
                WHERE folder_id = @fid
                GROUP BY snapshot_date, snapshot_name, created_by, created_at
                ORDER BY snapshot_date DESC`,
        params: { fid: folderId },
      });
      res.json(rows);
      return;
    }

    // POST /project_snapshots — create snapshot (captures all contracts for folder)
    if (req.method === 'POST') {
      const { folder_id, snapshot_name } = req.body || {};
      if (!folder_id) { res.status(400).json({ error: 'folder_id required' }); return; }

      const today = new Date().toISOString().split('T')[0];
      const name = snapshot_name || today;

      // Get all contracts for this folder with aggregated invoice data
      const [contracts] = await bigquery.query({
        query: `SELECT c.id, c.name, c.contractor_id, c.total_amount, c.subtotal, c.vat_amount,
                       c.paid_amount, c.progress_pct, c.status,
                       ct.name_en AS contractor_name,
                       IFNULL(inv_agg.invoiced_total, CAST(0 AS NUMERIC)) AS invoiced_total
                FROM ${cTable} c
                LEFT JOIN ${ctrTable} ct ON c.contractor_id = ct.id
                LEFT JOIN (
                  SELECT contract_id, CAST(SUM(total_amount) AS NUMERIC) AS invoiced_total
                  FROM ${invTable}
                  WHERE IFNULL(status,'active') != 'deleted' AND contract_id IS NOT NULL
                  GROUP BY contract_id
                ) inv_agg ON inv_agg.contract_id = c.id
                WHERE c.folder_id = @fid AND IFNULL(c.status,'active') != 'deleted'`,
        params: { fid: folder_id },
      });

      if (!contracts.length) {
        res.status(400).json({ error: 'No contracts in this project' }); return;
      }

      // Delete existing snapshot for same date+folder (overwrite)
      await bigquery.query({
        query: `DELETE FROM ${snapTable} WHERE folder_id = @fid AND snapshot_date = DATE(@d)`,
        params: { fid: folder_id, d: today },
      });

      // Build INSERT values
      const rows = contracts.map(c => {
        const total = parseFloat(c.total_amount?.value ?? c.total_amount ?? 0);
        const invoiced = parseFloat(c.invoiced_total?.value ?? c.invoiced_total ?? 0);
        const paid = parseFloat(c.paid_amount?.value ?? c.paid_amount ?? 0);
        return `('${uuidv4()}', '${folder_id}', DATE('${today}'), '${name.replace(/'/g,"''")}',
          '${c.id}', '${(c.name||'').replace(/'/g,"''")}',
          ${c.contractor_id ? "'"+c.contractor_id+"'" : 'NULL'},
          '${(c.contractor_name||'').replace(/'/g,"''")}',
          CAST(${total} AS NUMERIC), CAST(${parseFloat(c.subtotal?.value ?? c.subtotal ?? 0)} AS NUMERIC),
          CAST(${parseFloat(c.vat_amount?.value ?? c.vat_amount ?? 0)} AS NUMERIC),
          CAST(${invoiced} AS NUMERIC), CAST(${paid} AS NUMERIC),
          CAST(${parseFloat(c.progress_pct?.value ?? c.progress_pct ?? 0)} AS NUMERIC),
          CAST(${total - invoiced} AS NUMERIC), CAST(${invoiced - paid} AS NUMERIC),
          '${c.status || 'active'}', '${email}', CURRENT_TIMESTAMP())`;
      });

      await bigquery.query({
        query: `INSERT INTO ${snapTable}
          (id, folder_id, snapshot_date, snapshot_name, contract_id, contract_name,
           contractor_id, contractor_name, total_amount, subtotal, vat_amount,
           invoiced_total, paid_amount, progress_pct, outstanding, unpaid,
           status, created_by, created_at)
        VALUES ${rows.join(',\n')}`,
      });

      res.json({ success: true, contracts_count: contracts.length, snapshot_date: today });
      return;
    }

    // DELETE /project_snapshots?folder_id=X&date=YYYY-MM-DD
    if (req.method === 'DELETE') {
      const { folder_id, date } = req.query;
      if (!folder_id || !date) { res.status(400).json({ error: 'folder_id and date required' }); return; }
      await bigquery.query({
        query: `DELETE FROM ${snapTable} WHERE folder_id = @fid AND snapshot_date = DATE(@d)`,
        params: { fid: folder_id, d: date },
      });
      res.json({ success: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
};
