const { BigQuery } = require('@google-cloud/bigquery');
const { Storage }  = require('@google-cloud/storage');
const { v4: uuidv4 } = require('uuid');
const { getParser, availableFormats } = require('./parsers');

const bigquery = new BigQuery();
const storage  = new Storage();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const TABLE    = 'bank_statements';
const LINES_TABLE = 'bank_statement_lines';
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

/**
 * Download file from GCS into a Buffer.
 */
async function downloadFileBuffer(fileUrl) {
  const parsed = parseKey(fileUrl);
  if (!parsed) throw new Error('Invalid file URL');
  const [buffer] = await storage.bucket(parsed.bucket).file(parsed.key).download();
  return buffer;
}

/**
 * Batch-insert parsed lines into bank_statement_lines.
 * Uses INSERT ... SELECT FROM UNNEST — one DML operation.
 */
async function insertLines(statementId, accountId, companyId, lines, email) {
  if (!lines.length) return;

  const linesTable = `\`${PROJECT}.${DATASET}.${LINES_TABLE}\``;

  // BigQuery UNNEST approach: build arrays of each column
  const ids = [], lineNumbers = [], dates = [], valueDates = [];
  const amounts = [], directions = [], descriptions = [], counterparties = [];
  const references = [], runningBalances = [], currencies = [], rawDatas = [];

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    ids.push(uuidv4());
    lineNumbers.push(i + 1);
    dates.push(l.date);
    valueDates.push(l.value_date || null);
    amounts.push(String(l.amount));
    directions.push(l.direction);
    descriptions.push(l.description || '');
    counterparties.push(l.counterparty || '');
    references.push(l.reference || '');
    runningBalances.push(l.running_balance != null ? String(l.running_balance) : '');
    currencies.push(l.currency || 'THB');
    rawDatas.push(JSON.stringify(l.raw_data || {}));
  }

  await bigquery.query({
    query: `INSERT INTO ${linesTable}
              (id, statement_id, account_id, company_id, line_number, date, value_date,
               amount, direction, description, counterparty, reference, running_balance,
               currency, raw_data, transaction_id, match_status, matched_by, matched_at,
               imported_at, status)
            SELECT
              id, @statement_id, @account_id, @company_id, line_number,
              DATE(date), IF(value_date = '', NULL, DATE(value_date)),
              CAST(amount AS NUMERIC), direction, description,
              NULLIF(counterparty, ''), NULLIF(reference, ''), IF(running_balance = '', NULL, CAST(running_balance AS NUMERIC)),
              currency, SAFE.PARSE_JSON(raw_data),
              NULL, 'unmatched', NULL, NULL,
              CURRENT_TIMESTAMP(), 'active'
            FROM UNNEST(@ids) AS id WITH OFFSET o
            JOIN UNNEST(@line_numbers) AS line_number WITH OFFSET o2 ON o = o2
            JOIN UNNEST(@dates) AS date WITH OFFSET o3 ON o = o3
            JOIN UNNEST(@value_dates) AS value_date WITH OFFSET o4 ON o = o4
            JOIN UNNEST(@amounts) AS amount WITH OFFSET o5 ON o = o5
            JOIN UNNEST(@directions) AS direction WITH OFFSET o6 ON o = o6
            JOIN UNNEST(@descriptions) AS description WITH OFFSET o7 ON o = o7
            JOIN UNNEST(@counterparties) AS counterparty WITH OFFSET o8 ON o = o8
            JOIN UNNEST(@refs) AS reference WITH OFFSET o9 ON o = o9
            JOIN UNNEST(@running_balances) AS running_balance WITH OFFSET o10 ON o = o10
            JOIN UNNEST(@currencies) AS currency WITH OFFSET o11 ON o = o11
            JOIN UNNEST(@raw_datas) AS raw_data WITH OFFSET o12 ON o = o12`,
    params: {
      statement_id: statementId,
      account_id: accountId,
      company_id: companyId,
      ids, line_numbers: lineNumbers, dates, value_dates: valueDates.map(v => v || ''),
      amounts, directions, descriptions, counterparties,
      refs: references, running_balances: runningBalances,
      currencies, raw_datas: rawDatas,
    },
  });
}

exports.bank_statements = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const table = `\`${PROJECT}.${DATASET}.${TABLE}\``;
  const linesTable = `\`${PROJECT}.${DATASET}.${LINES_TABLE}\``;
  const path  = (req.url || '').split('?')[0];
  const user  = await getUser(email);
  if (!user) { res.status(403).json({ error: 'Forbidden' }); return; }

  try {
    // GET /bank_statements/formats — список доступных парсеров
    if (req.method === 'GET' && path === '/formats') {
      res.json(availableFormats);
      return;
    }

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
        query: `SELECT company_id, file_url, file_name FROM ${table} WHERE id = @id AND IFNULL(status, 'active') != 'deleted'`,
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

    // POST /bank_statements/<id>/parse — парсить загруженный xlsx
    if (req.method === 'POST' && path.endsWith('/parse')) {
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      // Читаем statement
      const [rows] = await bigquery.query({
        query: `SELECT id, company_id, account_id, file_url, bank_format, import_status
                FROM ${table} WHERE id = @id AND IFNULL(status, 'active') != 'deleted'`,
        params: { id },
      });
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      const st = rows[0];

      if (!user.is_admin) {
        const acc = await getCompanyAccess(email, st.company_id);
        if (acc !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }
      }

      if (!st.file_url) { res.status(400).json({ error: 'No file to parse' }); return; }
      if (!st.bank_format) { res.status(400).json({ error: 'bank_format is not set' }); return; }

      // Удаляем старые строки, если был повторный парсинг
      await bigquery.query({
        query: `DELETE FROM ${linesTable} WHERE statement_id = @id`,
        params: { id },
      });

      try {
        const parser = getParser(st.bank_format);
        const buffer = await downloadFileBuffer(st.file_url);
        const result = parser.parse(buffer);

        // Проверяем пересечение периодов
        if (result.period_from && result.period_to && st.account_id) {
          const [overlap] = await bigquery.query({
            query: `SELECT id, name, period_from, period_to
                    FROM ${table}
                    WHERE company_id = @company_id
                      AND account_id = @account_id
                      AND id != @id
                      AND IFNULL(status, 'active') != 'deleted'
                      AND period_from IS NOT NULL AND period_to IS NOT NULL
                      AND period_from <= DATE(@new_to)
                      AND period_to >= DATE(@new_from)
                    LIMIT 1`,
            params: {
              company_id: st.company_id,
              account_id: st.account_id,
              id,
              new_from: result.period_from,
              new_to: result.period_to,
            },
          });
          if (overlap.length) {
            const c = overlap[0];
            const cfrom = c.period_from?.value || c.period_from || '';
            const cto = c.period_to?.value || c.period_to || '';
            await bigquery.query({
              query: `UPDATE ${table} SET import_status = 'failed', import_error = @error WHERE id = @id`,
              params: { id, error: `Period overlap with "${c.name}" (${cfrom} — ${cto})` },
            });
            res.status(409).json({
              error: `Period ${result.period_from} — ${result.period_to} overlaps with "${c.name}" (${cfrom} — ${cto})`,
              conflict: { id: c.id, name: c.name, period_from: cfrom, period_to: cto },
            });
            return;
          }
        }

        // Вставляем строки
        await insertLines(id, st.account_id, st.company_id, result.lines, email);

        // Обновляем statement
        await bigquery.query({
          query: `UPDATE ${table}
                  SET import_status = 'parsed',
                      import_error = NULL,
                      lines_count = @lines_count,
                      period_from = IF(@period_from = '', NULL, DATE(@period_from)),
                      period_to   = IF(@period_to = '', NULL, DATE(@period_to)),
                      opening_balance = CAST(@opening_balance AS NUMERIC),
                      closing_balance = CAST(@closing_balance AS NUMERIC)
                  WHERE id = @id`,
          params: {
            id,
            lines_count: result.lines.length,
            period_from: result.period_from || '',
            period_to: result.period_to || '',
            opening_balance: result.opening_balance != null ? String(result.opening_balance) : '0',
            closing_balance: result.closing_balance != null ? String(result.closing_balance) : '0',
          },
        });

        res.json({
          success: true,
          lines_count: result.lines.length,
          period_from: result.period_from,
          period_to: result.period_to,
          opening_balance: result.opening_balance,
          closing_balance: result.closing_balance,
        });
      } catch (parseErr) {
        // Ошибка парсинга — записываем в statement
        await bigquery.query({
          query: `UPDATE ${table} SET import_status = 'failed', import_error = @error WHERE id = @id`,
          params: { id, error: parseErr.message },
        });
        res.status(422).json({ error: parseErr.message });
      }
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
      let where = 'WHERE s.company_id = @company_id AND IFNULL(s.status, \'active\') != \'deleted\'';
      const params = { company_id };
      if (search)    { where += ' AND LOWER(s.name) LIKE LOWER(@search)'; params.search = `%${search.trim()}%`; }
      if (date_from) { where += ' AND s.date >= @date_from'; params.date_from = date_from; }
      if (date_to)   { where += ' AND s.date <= @date_to';   params.date_to   = date_to; }
      if (req.query.account_id) { where += ' AND s.account_id = @account_id'; params.account_id = req.query.account_id; }

      const [rows] = await bigquery.query({
        query: `SELECT s.id, s.company_id, s.account_id, s.name, s.date,
                       s.file_name, s.file_url, s.file_size,
                       s.period_from, s.period_to, s.opening_balance, s.closing_balance,
                       s.bank_format, s.lines_count, s.import_status, s.import_error,
                       s.uploaded_at, s.uploaded_by,
                       IFNULL(lc.matched_count, 0) AS matched_count,
                       IFNULL(lc.unmatched_count, 0) AS unmatched_count
                FROM ${table} s
                LEFT JOIN (
                  SELECT statement_id,
                         COUNTIF(match_status IN ('matched','manual_created')) AS matched_count,
                         COUNTIF(match_status = 'unmatched') AS unmatched_count
                  FROM ${linesTable}
                  WHERE status = 'active'
                  GROUP BY statement_id
                ) lc ON lc.statement_id = s.id
                ${where}
                ORDER BY s.date DESC NULLS LAST, s.uploaded_at DESC`,
        params,
      });
      res.json(rows);
      return;
    }

    // POST — создать запись (с новыми полями)
    if (req.method === 'POST') {
      const { company_id, account_id, name, date, file_name, file_url, file_size, bank_format } = req.body || {};
      if (!company_id || !name) { res.status(400).json({ error: 'company_id and name are required' }); return; }
      if (!user.is_admin) {
        const acc = await getCompanyAccess(email, company_id);
        if (acc !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }
      }
      const id = req.body.id || uuidv4();
      await bigquery.query({
        query: `INSERT INTO ${table}
                  (id, company_id, account_id, name, date,
                   file_name, file_url, file_size,
                   bank_format, import_status, status,
                   uploaded_by, uploaded_at)
                VALUES
                  (@id, @company_id, NULLIF(@account_id,''), @name, IF(@date = '', NULL, DATE(@date)),
                   NULLIF(@file_name,''), NULLIF(@file_url,''), @file_size,
                   NULLIF(@bank_format,''), @import_status, 'active',
                   @uploaded_by, CURRENT_TIMESTAMP())`,
        params: {
          id, company_id,
          account_id:    account_id    || '',
          name,
          date:          date          || '',
          file_name:     file_name     || '',
          file_url:      file_url      || '',
          file_size:     parseInt(file_size || 0),
          bank_format:   bank_format   || '',
          import_status: file_url ? 'pending' : 'parsed',
          uploaded_by:   email,
        },
      });
      res.json({ success: true, id });
      return;
    }

    // PUT — редактировать
    if (req.method === 'PUT') {
      const id = path.split('/').filter(Boolean)[0];
      const { account_id, name, date, file_name, file_url, file_size, replace_file, bank_format } = req.body || {};
      if (!id || !name) { res.status(400).json({ error: 'id and name are required' }); return; }

      const [rows] = await bigquery.query({
        query: `SELECT company_id, file_url AS old_file_url FROM ${table} WHERE id = @id AND IFNULL(status, 'active') != 'deleted'`,
        params: { id },
      });
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      const cur = rows[0];

      if (!user.is_admin) {
        const acc = await getCompanyAccess(email, cur.company_id);
        if (acc !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }
      }

      // Если заменяется файл — удалить старый из GCS
      if (replace_file && cur.old_file_url) {
        const p = parseKey(cur.old_file_url);
        if (p) {
          try { await storage.bucket(p.bucket).file(p.key).delete({ ignoreNotFound: true }); }
          catch (e) { console.error('GCS delete failed', e.message); }
        }
      }

      await bigquery.query({
        query: `UPDATE ${table}
                SET account_id  = NULLIF(@account_id,''),
                    name        = @name,
                    date        = IF(@date = '', NULL, DATE(@date)),
                    file_name   = IF(@replace_file, NULLIF(@file_name,''), file_name),
                    file_url    = IF(@replace_file, NULLIF(@file_url,''),  file_url),
                    file_size   = IF(@replace_file, @file_size,            file_size),
                    bank_format = IF(@replace_file AND @bank_format != '', @bank_format, bank_format),
                    import_status = IF(@replace_file, 'pending', import_status),
                    import_error  = IF(@replace_file, NULL, import_error),
                    lines_count   = IF(@replace_file, 0, lines_count)
                WHERE id = @id`,
        params: {
          id,
          account_id:   account_id   || '',
          name,
          date:         date         || '',
          file_name:    file_name    || '',
          file_url:     file_url     || '',
          file_size:    parseInt(file_size || 0),
          replace_file: !!replace_file,
          bank_format:  bank_format  || '',
        },
      });

      // Если заменили файл — удаляем старые строки
      if (replace_file) {
        await bigquery.query({
          query: `DELETE FROM ${linesTable} WHERE statement_id = @id`,
          params: { id },
        });
      }

      res.json({ success: true });
      return;
    }

    // DELETE — soft delete + каскад на строки
    if (req.method === 'DELETE') {
      const id = path.split('/').filter(Boolean)[0];
      if (!id) { res.status(400).json({ error: 'id is required' }); return; }

      const [rows] = await bigquery.query({
        query: `SELECT company_id, file_url FROM ${table} WHERE id = @id AND IFNULL(status, 'active') != 'deleted'`,
        params: { id },
      });
      if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
      if (!user.is_admin) {
        const acc = await getCompanyAccess(email, rows[0].company_id);
        if (acc !== 'editor') { res.status(403).json({ error: 'Forbidden' }); return; }
      }

      // Soft delete statement
      await bigquery.query({
        query: `UPDATE ${table} SET status = 'deleted' WHERE id = @id`,
        params: { id },
      });

      // Очищаем statement_line_id в связанных транзакциях
      const trxTable = `\`${PROJECT}.${DATASET}.transactions\``;
      await bigquery.query({
        query: `UPDATE ${trxTable} SET statement_line_id = NULL
                WHERE statement_line_id IN (
                  SELECT id FROM ${linesTable} WHERE statement_id = @id
                )`,
        params: { id },
      });

      // Soft delete all lines
      await bigquery.query({
        query: `UPDATE ${linesTable} SET status = 'deleted' WHERE statement_id = @id`,
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
