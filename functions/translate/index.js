const Anthropic = require('@anthropic-ai/sdk');
const { BigQuery } = require('@google-cloud/bigquery');

const bigquery = new BigQuery();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function verifyToken(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.split(' ')[1];
  const r1 = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${token}`);
  if (r1.ok) { const info = await r1.json(); return info.email || null; }
  const r2 = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${token}`);
  if (r2.ok) { const info = await r2.json(); return info.email || null; }
  return null;
}

const LANG_NAMES = { ru: 'Russian', en: 'English', th: 'Thai' };

exports.translate = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const { text, source_lang, target_langs } = req.body || {};
  if (!text || !source_lang || !target_langs || !target_langs.length) {
    res.status(400).json({ error: 'text, source_lang, target_langs required' });
    return;
  }

  try {
    const client = new Anthropic();
    const targetsStr = target_langs.map(l => LANG_NAMES[l] || l).join(' and ');
    const sourceName = LANG_NAMES[source_lang] || source_lang;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: `Translate the following text from ${sourceName} to ${targetsStr}.
Return ONLY a JSON object with language codes as keys and translations as values. No explanation.

Text: "${text}"

Example response format: {"en": "translated text", "th": "translated text"}`
      }],
    });

    const content = message.content[0]?.text || '{}';
    // Parse JSON from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const translations = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    res.json({ success: true, translations });
  } catch(e) {
    console.error('Translation error:', e);
    res.status(500).json({ error: e.message });
  }
};
