const Anthropic = require('@anthropic-ai/sdk');
const { BigQuery } = require('@google-cloud/bigquery');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';

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
    query: `SELECT email, is_admin, can_see_salary FROM \`${PROJECT}.${DATASET}.users\` WHERE email = @email`,
    params: { email },
  });
  return rows[0] || null;
}

exports.ai_documents = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  const user = await getUser(email);
  if (!user) { res.status(403).json({ error: 'Forbidden' }); return; }

  const { file_base64, file_name, content_type, doc_type, folder_id } = req.body || {};
  if (!file_base64 || !folder_id) {
    res.status(400).json({ error: 'file_base64 and folder_id are required' });
    return;
  }

  try {
    // Load context from DB
    const [contractors] = await bigquery.query({
      query: `SELECT id, name_en, name_th, tax_id FROM \`${PROJECT}.${DATASET}.contractors\` WHERE is_active = true ORDER BY name_en LIMIT 200`,
    });

    const [categories] = await bigquery.query({
      query: `SELECT id, name, name_en, type FROM \`${PROJECT}.${DATASET}.categories\` ORDER BY sort_order`,
    });

    const contractorsList = contractors.map(c => `${c.name_en || c.name_th} (tax_id: ${c.tax_id || 'N/A'}, id: ${c.id})`).join('\n');
    const categoriesList = categories.map(c => `${c.name_en || c.name} (type: ${c.type}, id: ${c.id})`).join('\n');

    // Determine media type for Claude
    const isPdf = content_type === 'application/pdf' || (file_name || '').toLowerCase().endsWith('.pdf');
    const mediaType = isPdf ? 'application/pdf' : (content_type || 'image/jpeg');

    const client = new Anthropic();

    const systemPrompt = `You are a document analysis assistant for a construction/property management company (Sunti).
You analyze invoices, contracts, and other financial documents.
You MUST respond with a single valid JSON object and nothing else — no markdown, no explanation, no code fences.

EXISTING CONTRACTORS in the system:
${contractorsList || '(none)'}

EXISTING CATEGORIES:
${categoriesList || '(none)'}

Return EXACTLY this JSON structure:
{
  "document_type": "invoice|contract|quotation|receipt",
  "document_number": "string or null",
  "date": "YYYY-MM-DD or null",
  "due_date": "YYYY-MM-DD or null",
  "contractor": {
    "matched_id": "existing contractor UUID if matched, otherwise null",
    "name": "company name in English",
    "name_th": "company name in Thai if present, otherwise null",
    "tax_id": "13-digit tax ID or null",
    "address": "address string or null",
    "branch": "HQ or branch number or null",
    "type": "individual|juristic|foreign_individual|foreign_juristic",
    "is_new": true if no match found in existing contractors
  },
  "category": {
    "matched_id": "existing category UUID if matched, otherwise null",
    "suggested_name": "category name suggestion"
  },
  "amounts": {
    "subtotal": number or 0,
    "vat_rate": number or 0,
    "vat_amount": number or 0,
    "wht_rate": number or 0,
    "wht_amount": number or 0,
    "total": number or 0,
    "payable": number or 0,
    "currency": "THB|USD|etc"
  },
  "line_items": [
    {"description": "string", "quantity": number, "unit_price": number, "amount": number}
  ],
  "direction": "expense|income",
  "payment_terms": "string or null",
  "notes": "any additional info or null",
  "confidence": 0.0 to 1.0,
  "warnings": ["array of strings about uncertain fields"]
}

Rules:
- Match contractor by tax_id first, then by name similarity. Set matched_id ONLY if confident.
- Match category by document content. Set matched_id ONLY if confident.
- All amounts as positive numbers. Direction field indicates expense/income.
- If a field cannot be determined, use null (not empty string).
- Be precise with numbers — do not round.`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: isPdf ? 'document' : 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: file_base64,
              },
              ...(isPdf ? { cache_control: { type: 'ephemeral' } } : {}),
            },
            {
              type: 'text',
              text: `Analyze this ${doc_type || 'document'} and return the JSON.`,
            },
          ],
        },
      ],
    });

    const rawText = message.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();

    // Parse JSON — handle possible markdown code fences
    let analysis;
    try {
      const jsonStr = rawText.replace(/^```json?\s*/i, '').replace(/\s*```$/i, '').trim();
      analysis = JSON.parse(jsonStr);
    } catch(parseErr) {
      analysis = { raw: rawText, parse_error: 'AI returned non-JSON response' };
    }

    res.json({ success: true, analysis });
  } catch(e) {
    console.error('AI analysis error:', e);
    res.status(500).json({ error: e.message });
  }
};
