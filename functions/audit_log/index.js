const { BigQuery } = require('@google-cloud/bigquery');
const crypto = require('crypto');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const auditTable = `\`${PROJECT}.${DATASET}.audit_log\``;

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function verifyToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.split(' ')[1];
  // Try as access token first
  const r1 = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
  if (r1.ok) { const info = await r1.json(); return info.email || null; }
  // Try as ID token (JWT)
  const r2 = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
  if (r2.ok) { const info = await r2.json(); return info.email || null; }
  return null;
}

exports.audit_log = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const path = (req.url || '').split('?')[0];

  try {
    // GET /audit_log?contract_id=X
    // GET /audit_log?entity_type=X&entity_id=Y
    if (req.method === 'GET') {
      const { contract_id, entity_type, entity_id } = req.query;

      if (contract_id) {
        const [rows] = await bigquery.query({
          query: `SELECT id, entity_type, entity_id, contract_id, action, field,
                         old_value, new_value, changed_by, changed_at
                  FROM ${auditTable}
                  WHERE contract_id = @contract_id
                  ORDER BY changed_at DESC`,
          params: { contract_id },
        });
        res.json(rows);
        return;
      }

      if (entity_type && entity_id) {
        const [rows] = await bigquery.query({
          query: `SELECT id, entity_type, entity_id, contract_id, action, field,
                         old_value, new_value, changed_by, changed_at
                  FROM ${auditTable}
                  WHERE entity_type = @entity_type AND entity_id = @entity_id
                  ORDER BY changed_at DESC`,
          params: { entity_type, entity_id },
        });
        res.json(rows);
        return;
      }

      res.status(400).json({ error: 'contract_id or entity_type+entity_id required' });
      return;
    }

    // POST /audit_log/batch — batch create
    if (req.method === 'POST' && path.endsWith('/batch')) {
      const entries = req.body?.entries;
      if (!entries || !entries.length) { res.status(400).json({ error: 'entries required' }); return; }

      const values = entries.map((e, i) => {
        return `(@id${i}, @type${i}, @eid${i}, @cid${i}, @action${i}, @field${i}, @old${i}, @new${i}, @by${i}, CURRENT_TIMESTAMP())`;
      }).join(',');
      const params = {};
      entries.forEach((e, i) => {
        params['id' + i] = crypto.randomUUID();
        params['type' + i] = e.entity_type || '';
        params['eid' + i] = e.entity_id || '';
        params['cid' + i] = e.contract_id || '';
        params['action' + i] = e.action || '';
        params['field' + i] = e.field || '';
        params['old' + i] = e.old_value != null ? String(e.old_value) : '';
        params['new' + i] = e.new_value != null ? String(e.new_value) : '';
        params['by' + i] = e.changed_by || email;
      });
      await bigquery.query({
        query: `INSERT INTO ${auditTable} (id, entity_type, entity_id, contract_id, action, field, old_value, new_value, changed_by, changed_at) VALUES ${values}`,
        params,
      });
      res.json({ success: true });
      return;
    }

    // POST /audit_log — single create
    if (req.method === 'POST') {
      const b = req.body || {};
      const id = crypto.randomUUID();
      await bigquery.query({
        query: `INSERT INTO ${auditTable} (id, entity_type, entity_id, contract_id, action, field, old_value, new_value, changed_by, changed_at)
                VALUES (@id, @entity_type, @entity_id, @contract_id, @action, @field, @old_value, @new_value, @changed_by, CURRENT_TIMESTAMP())`,
        params: {
          id,
          entity_type: b.entity_type || '',
          entity_id: b.entity_id || '',
          contract_id: b.contract_id || '',
          action: b.action || '',
          field: b.field || '',
          old_value: b.old_value != null ? String(b.old_value) : '',
          new_value: b.new_value != null ? String(b.new_value) : '',
          changed_by: b.changed_by || email,
        },
      });
      res.json({ success: true, id });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};
