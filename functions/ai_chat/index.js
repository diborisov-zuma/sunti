const Anthropic = require('@anthropic-ai/sdk');
const { BigQuery } = require('@google-cloud/bigquery');

const bigquery = new BigQuery();
const PROJECT = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET = 'sunti';

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Max-Age', '3600');
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

// Full DB schema for the system prompt
const DB_SCHEMA = `
BigQuery dataset: ${PROJECT}.${DATASET}

Tables and columns:

1. users (email STRING, name STRING, is_admin BOOL, can_see_salary BOOL, is_active BOOL, telegram_chat_id STRING, telegram_username STRING, first_login TIMESTAMP, last_login TIMESTAMP)

2. users_folders (id STRING, user_email STRING, folder_id STRING, docs_access STRING, docs_level STRING, materials_level STRING)

3. users_statements (id STRING, user_email STRING, company_id STRING, statement_access STRING)

4. companies (id STRING, name STRING, registration_number STRING)

5. company_accounts (id STRING, company_id STRING, name STRING, bank_name STRING, bank_account STRING, is_active BOOL)

6. folders (id STRING, name STRING, order INT64, status STRING 'active|archive', company_id STRING, created_by STRING, created_at TIMESTAMP)
   -- folders = projects/villas

7. category_types (id STRING, name STRING, name_en STRING, name_th STRING, sort_order INT64)

8. categories (id STRING, name STRING, name_en STRING, name_th STRING, type STRING, sort_order INT64)
   -- type is FK to category_types.id (expense/income/transfer)

9. contractors (id STRING, tax_id STRING, national_id STRING, type STRING 'individual|juristic|foreign_individual|foreign_juristic', name_th STRING, name_en STRING, address_th STRING, address_en STRING, branch STRING, is_vat_registered BOOL, default_wht_category STRING, default_wht_rate FLOAT64, is_active BOOL, notes STRING, created_at TIMESTAMP, created_by STRING)

10. contracts (id STRING, folder_id STRING, contractor_id STRING, name STRING, external_ref STRING, date DATE, direction STRING 'expense|income', total_amount NUMERIC, subtotal NUMERIC, vat_amount NUMERIC, paid_amount NUMERIC, payment_terms STRING, status STRING 'active|completed|cancelled|deleted', notes STRING, progress_pct INT64, progress_notes STRING, created_by STRING, created_at TIMESTAMP)
    -- paid_amount is computed from child invoices

11. contract_files (id STRING, contract_id STRING, file_url STRING, file_name STRING, file_size INT64, uploaded_by STRING, uploaded_at TIMESTAMP)

12. contract_items (id STRING, contract_id STRING, item_type STRING 'goods|service', description STRING, quantity NUMERIC, unit_price NUMERIC, amount NUMERIC, vat_rate NUMERIC, vat_amount NUMERIC, amount_with_vat NUMERIC, vat_included BOOL, sort_order INT64, created_by STRING, created_at TIMESTAMP)

13. invoices (id STRING, folder_id STRING, name STRING, status STRING, direction STRING 'expense|income', total_amount NUMERIC, paid_amount NUMERIC, subtotal NUMERIC, vat_rate NUMERIC, vat_amount NUMERIC, wht_rate NUMERIC, wht_amount NUMERIC, category_id STRING, contractor_id STRING, contract_id STRING, date DATE, uploaded_by STRING, uploaded_at TIMESTAMP)
    -- paid_amount is computed from linked transactions
    -- documents/invoices table

14. invoice_files (id STRING, invoice_id STRING, file_url STRING, file_name STRING, file_size INT64, uploaded_by STRING, uploaded_at TIMESTAMP)

15. transactions (id STRING, date DATE, amount NUMERIC, direction STRING 'expense|income', account_id STRING, category_id STRING, invoice_id STRING, folder_id STRING, contractor_id STRING, contract_id STRING, statement_line_id STRING, description STRING, status STRING 'active|deleted', created_at TIMESTAMP)

16. transaction_files (id STRING, transaction_id STRING, file_url STRING, file_name STRING, file_size INT64, uploaded_by STRING, uploaded_at TIMESTAMP)

17. bank_statements (id STRING, company_id STRING, account_id STRING, name STRING, date DATE, file_url STRING, file_name STRING, file_size INT64, uploaded_by STRING, uploaded_at TIMESTAMP, period_from DATE, period_to DATE, opening_balance NUMERIC, closing_balance NUMERIC, bank_format STRING, lines_count INT64, import_status STRING 'pending|parsed|failed', import_error STRING, status STRING 'active|deleted')

18. bank_statement_lines (id STRING, statement_id STRING, account_id STRING, company_id STRING, line_number INT64, date DATE, value_date DATE, amount NUMERIC, direction STRING, description STRING, counterparty STRING, reference STRING, running_balance NUMERIC, currency STRING, raw_data JSON, transaction_id STRING, match_status STRING 'unmatched|matched|ignored|manual_created', matched_by STRING, matched_at TIMESTAMP, imported_at TIMESTAMP, status STRING)

19. project_doc_categories (id STRING, name STRING, name_en STRING, name_th STRING, sort_order INT64, created_by STRING)

20. project_docs (id STRING, folder_id STRING, category_id STRING, name STRING, description STRING, current_version INT64, sort_order INT64, status STRING, created_by STRING, created_at TIMESTAMP)

21. project_doc_versions (id STRING, document_id STRING, version_number INT64, file_url STRING, file_name STRING, file_size INT64, notes STRING, uploaded_by STRING, uploaded_at TIMESTAMP)

22. materials (id STRING, folder_id STRING, name STRING, description STRING, status STRING 'pending_approval|approved|rejected|archived', status_date TIMESTAMP, status_by STRING, sort_order INT64, created_by STRING, created_at TIMESTAMP)

23. material_files (id STRING, material_id STRING, file_url STRING, file_name STRING, file_size INT64, content_type STRING, thumb_url STRING, uploaded_by STRING, uploaded_at TIMESTAMP)

24. material_comments (id STRING, material_id STRING, text STRING, author_email STRING, author_name STRING, created_at TIMESTAMP)

25. messages (id STRING, document_id STRING, document_type STRING 'invoice|transaction', text STRING, from_user STRING, to_users STRING, is_read BOOL, created_at TIMESTAMP)

26. portal_users (id STRING, email STRING, name STRING, is_active BOOL, created_at TIMESTAMP, created_by STRING)

27. portal_users_folders (id STRING, portal_user_id STRING, folder_id STRING)

28. portal_users_sections (id STRING, portal_user_id STRING, section STRING, access_level STRING)

Key relationships:
- folders.company_id → companies.id
- company_accounts.company_id → companies.id
- invoices.folder_id → folders.id, invoices.contractor_id → contractors.id, invoices.contract_id → contracts.id, invoices.category_id → categories.id
- transactions.folder_id → folders.id, transactions.account_id → company_accounts.id, transactions.invoice_id → invoices.id, transactions.contractor_id → contractors.id, transactions.category_id → categories.id
- contracts.folder_id → folders.id, contracts.contractor_id → contractors.id
- bank_statements.company_id → companies.id, bank_statements.account_id → company_accounts.id
- bank_statement_lines.statement_id → bank_statements.id

Important notes:
- amount/total_amount/paid_amount are always positive NUMERIC. Direction (expense/income) is in the 'direction' field.
- Soft-deleted records have status='deleted' — exclude them with WHERE status != 'deleted' or WHERE status = 'active'.
- invoices table contains both invoices and documents (it was renamed from 'documents').
- folders are projects/villas.
- NUMERIC values from BigQuery come as objects {value: "123"} — but in SQL they work normally.
- transactions.contractor_id is OPTIONAL and often NULL. To find payments by contractor, JOIN through invoices: transactions.invoice_id → invoices.id → invoices.contractor_id. Use COALESCE(t.contractor_id, i.contractor_id) when you need the contractor for a transaction.
- contracts.paid_amount is computed from child invoices. To get accurate contract payment data, use invoices.paid_amount or sum transactions through invoices.
- When calculating totals by contractor, always join through invoices as the primary path, not directly through transactions.contractor_id.
`;

const SYSTEM_PROMPT = `You are an AI data analyst for Sunti — a construction/property management company in Thailand.
You help admins query the BigQuery database by converting natural language questions to SQL.

${DB_SCHEMA}

RULES:
1. Generate ONLY SELECT queries. Never INSERT, UPDATE, DELETE, DROP, CREATE, ALTER, MERGE, TRUNCATE.
2. Always add LIMIT 100 unless the user explicitly asks for more (max 500).
3. Exclude soft-deleted records: add WHERE status != 'deleted' or WHERE status = 'active' for tables that have a status column (invoices, transactions, bank_statements, bank_statement_lines, contracts).
4. Use fully qualified table names: \`${PROJECT}.${DATASET}.table_name\`
5. For monetary amounts, remember they are always positive — use direction field for sign.
6. When joining tables, use meaningful aliases.
7. Format dates as YYYY-MM-DD.
8. Respond in the SAME LANGUAGE as the user's question (Russian, English, or Thai).
9. IMPORTANT: When the user mentions a folder, contractor, company, category, or account by name — find the matching record in the REFERENCE DATA section and use its exact ID in the SQL WHERE clause. NEVER search by name with = or LIKE. The user may use a different language, abbreviation, or spelling — use your judgment to match. Example: user says "Вилла 2" → match to "Villa 2" in reference data → use WHERE folder_id = 'exact-uuid'.
10. For NUMERIC fields that may be NULL, always use COALESCE(field, 0) in calculations.

When you receive a question, respond with EXACTLY this JSON (no markdown fences):
{"sql": "YOUR SELECT QUERY HERE", "explanation": "Brief explanation of what the query does"}

If the question cannot be answered with a SQL query (e.g. it's a general question, greeting, or unclear), respond with:
{"sql": null, "explanation": "Your helpful response to the user"}`;

const ANSWER_PROMPT = `You are an AI data analyst for Sunti, a construction/property management company.
You received data from BigQuery in response to a user's question.
Format a clear, helpful answer based on the data.

RULES:
1. Respond in the SAME LANGUAGE as the user's question.
2. ALL numbers must be formatted with comma thousands separator and dot decimal: 1,234,567.89. This applies to ALL numeric values — monetary amounts, quantities, percentages, counts.
3. For monetary amounts, also add ฿ for THB.
4. If data is tabular, present it clearly.
5. Keep the answer concise but complete.
6. If no rows returned, say so clearly.
7. Never expose internal IDs — use human-readable names.
8. Do NOT wrap your response in markdown code fences.`;

// Validate that SQL is SELECT-only
function validateSQL(sql) {
  const normalized = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().toUpperCase();
  const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'MERGE', 'TRUNCATE', 'GRANT', 'REVOKE'];
  for (const word of forbidden) {
    // Check for forbidden words at statement boundaries (not inside strings/identifiers)
    const regex = new RegExp(`(^|;|\\s)${word}\\s`, 'i');
    if (regex.test(normalized)) {
      return false;
    }
  }
  if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
    return false;
  }
  return true;
}

// Ensure LIMIT exists
function ensureLimit(sql) {
  const normalized = sql.replace(/--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().toUpperCase();
  if (!normalized.includes('LIMIT')) {
    return sql.replace(/;?\s*$/, ' LIMIT 100');
  }
  return sql;
}

exports.ai_chat = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const user = await getUser(email);
  if (!user || !user.is_admin) { res.status(403).json({ error: 'Admin access required' }); return; }

  const { message, history } = req.body || {};
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  try {
    const client = new Anthropic();

    // Load reference data for AI context
    const [folders] = await bigquery.query({
      query: `SELECT id, name, status, company_id FROM \`${PROJECT}.${DATASET}.folders\` WHERE status = 'active' ORDER BY name`,
    });
    const [companies] = await bigquery.query({
      query: `SELECT id, name FROM \`${PROJECT}.${DATASET}.companies\` ORDER BY name`,
    });
    const [contractors] = await bigquery.query({
      query: `SELECT id, name_en, name_th, tax_id FROM \`${PROJECT}.${DATASET}.contractors\` WHERE is_active = true ORDER BY name_en LIMIT 300`,
    });
    const [categories] = await bigquery.query({
      query: `SELECT id, name, name_en, name_th, type FROM \`${PROJECT}.${DATASET}.categories\` ORDER BY sort_order`,
    });
    const [accounts] = await bigquery.query({
      query: `SELECT id, name, company_id, bank_name FROM \`${PROJECT}.${DATASET}.company_accounts\` WHERE is_active = true ORDER BY name`,
    });

    const refData = `
REFERENCE DATA (use these IDs in SQL, do NOT search by name in WHERE clauses):

FOLDERS (projects/villas):
${folders.map(f => `- "${f.name}" (id: ${f.id}, company_id: ${f.company_id})`).join('\n') || '(none)'}

COMPANIES:
${companies.map(c => `- "${c.name}" (id: ${c.id})`).join('\n') || '(none)'}

CONTRACTORS:
${contractors.map(c => `- "${c.name_en || c.name_th}" ${c.name_th && c.name_en ? '/ "' + c.name_th + '"' : ''} (id: ${c.id}, tax_id: ${c.tax_id || 'N/A'})`).join('\n') || '(none)'}

CATEGORIES:
${categories.map(c => `- "${c.name_en || c.name}" ${c.name_th ? '/ "' + c.name_th + '"' : ''} (type: ${c.type}, id: ${c.id})`).join('\n') || '(none)'}

ACCOUNTS:
${accounts.map(a => `- "${a.name}" / ${a.bank_name || ''} (id: ${a.id}, company_id: ${a.company_id})`).join('\n') || '(none)'}
`;

    // Build conversation history for context
    const messages = [];
    if (Array.isArray(history)) {
      for (const h of history.slice(-10)) { // last 10 messages for context
        messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content });
      }
    }
    messages.push({ role: 'user', content: message });

    // Step 1: Generate SQL
    const sqlResponse = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: SYSTEM_PROMPT + '\n' + refData,
      messages,
    });

    const sqlRaw = sqlResponse.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    let parsed;
    try {
      // Strip markdown fences (multiline) and extract JSON
      let cleaned = sqlRaw;
      const jsonMatch = cleaned.match(/```json?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        cleaned = jsonMatch[1].trim();
      } else {
        // Try to find raw JSON object
        const braceMatch = cleaned.match(/\{[\s\S]*\}/);
        if (braceMatch) cleaned = braceMatch[0].trim();
      }
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // If Claude didn't return JSON, treat as a conversational answer
      return res.json({
        success: true,
        answer: sqlRaw.replace(/```json?\s*/gi, '').replace(/```/g, '').trim(),
        sql: null,
        data: null,
      });
    }

    // No SQL needed — conversational answer
    if (!parsed.sql) {
      return res.json({
        success: true,
        answer: parsed.explanation || 'No answer available.',
        sql: null,
        data: null,
      });
    }

    // Validate SQL
    if (!validateSQL(parsed.sql)) {
      return res.json({
        success: true,
        answer: 'I can only run SELECT queries for reading data. Modification queries are not allowed.',
        sql: parsed.sql,
        data: null,
        error: 'forbidden_query',
      });
    }

    const safeSql = ensureLimit(parsed.sql);

    // Step 2: Execute SQL in BigQuery
    let rows;
    try {
      const [result] = await bigquery.query({
        query: safeSql,
        location: 'asia-southeast1',
        maximumBytesBilled: '100000000', // 100MB limit
      });
      rows = result;
    } catch (bqError) {
      // SQL error — ask Claude to explain
      return res.json({
        success: true,
        answer: `Query execution error: ${bqError.message}`,
        sql: safeSql,
        data: null,
        error: 'query_error',
      });
    }

    // Normalize BigQuery NUMERIC objects to plain values
    const normalizedRows = rows.map(row => {
      const out = {};
      for (const [key, val] of Object.entries(row)) {
        if (val && typeof val === 'object' && 'value' in val) {
          out[key] = val.value;
        } else if (val instanceof Date) {
          out[key] = val.toISOString().split('T')[0];
        } else if (val && typeof val === 'object' && val.value === undefined) {
          // BigQuery date objects
          try { out[key] = JSON.stringify(val); } catch { out[key] = String(val); }
        } else {
          out[key] = val;
        }
      }
      return out;
    });

    // Step 3: Format answer with Claude
    const dataPreview = JSON.stringify(normalizedRows.slice(0, 50), null, 2);
    const answerResponse = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: ANSWER_PROMPT,
      messages: [
        {
          role: 'user',
          content: `User question: ${message}\n\nSQL executed: ${safeSql}\n\nQuery returned ${normalizedRows.length} rows. Data (first 50 rows):\n${dataPreview}`,
        },
      ],
    });

    const answer = answerResponse.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    res.json({
      success: true,
      answer,
      sql: safeSql,
      data: normalizedRows,
      rowCount: normalizedRows.length,
      explanation: parsed.explanation,
    });

  } catch (e) {
    console.error('AI Chat error:', e);
    res.status(500).json({ error: e.message });
  }
};
