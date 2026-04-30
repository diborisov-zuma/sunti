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

EXISTING CONTRACTORS in the system:
${contractorsList || '(none)'}

EXISTING CATEGORIES:
${categoriesList || '(none)'}

The user is uploading a ${doc_type || 'document'}.
Analyze the document and provide a detailed summary in the following structure:
1. Document type (invoice, quotation, contract, receipt, etc.)
2. Supplier/Contractor name, address, Tax ID
3. Document date, document number
4. Line items with descriptions and amounts
5. Subtotal, VAT amount, WHT (withholding tax) if any, Total
6. Payment terms or due date if mentioned
7. Any other relevant information

If the supplier matches an existing contractor in the system, mention the match and provide the contractor ID.
If a category seems to match, suggest the category ID.

Respond in English. Be precise with numbers.`;

    const message = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
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
              text: `Please analyze this ${doc_type || 'document'} and extract all relevant information.`,
            },
          ],
        },
      ],
    });

    const analysis = message.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    res.json({ success: true, analysis });
  } catch(e) {
    console.error('AI analysis error:', e);
    res.status(500).json({ error: e.message });
  }
};
