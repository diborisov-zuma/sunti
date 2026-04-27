const { BigQuery } = require('@google-cloud/bigquery');
const { Storage }  = require('@google-cloud/storage');
const { v4: uuidv4 } = require('uuid');

const bigquery = new BigQuery();
const storage  = new Storage();
const PROJECT  = 'project-9718e7d4-4cd7-4f52-8d6';
const DATASET  = 'sunti';
const BUCKET   = 'sunti-site';

const contactTable = `\`${PROJECT}.${DATASET}.wa_contacts\``;
const msgTable     = `\`${PROJECT}.${DATASET}.wa_messages\``;
const aiTable      = `\`${PROJECT}.${DATASET}.wa_ai_analysis\``;

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
}

function cleanPhone(raw) {
  // WhatsApp format: 66891234567@c.us → +66891234567
  return (raw || '').replace(/@.*$/, '').replace(/[^\d+]/g, '');
}

/**
 * Download media from URL and store in GCS.
 */
async function downloadMedia(mediaUrl, phone, msgId) {
  if (!mediaUrl) return null;
  try {
    const resp = await fetch(mediaUrl);
    if (!resp.ok) return null;
    const buffer = Buffer.from(await resp.arrayBuffer());
    const ext = (mediaUrl.split('.').pop() || 'bin').split('?')[0].substring(0, 10);
    const key = `whatsapp/${phone}/${msgId}_${Date.now()}.${ext}`;
    await storage.bucket(BUCKET).file(key).save(buffer);
    return `https://storage.googleapis.com/${BUCKET}/${key}`;
  } catch(e) {
    console.error('Media download failed:', e.message);
    return null;
  }
}

/**
 * Simple AI classification using keyword heuristics.
 * TODO: Replace with Claude API call for better accuracy.
 */
function classifyContact(name, text) {
  const combined = ((name || '') + ' ' + (text || '')).toLowerCase();
  // Agent keywords
  const agentKeywords = ['agent', 'broker', 'property', 'listing', 'commission', 'เอเจ', 'นายหน้า', 'ตัวแทน', 'co-agent'];
  for (const kw of agentKeywords) {
    if (combined.includes(kw)) return { type: 'agent', confidence: 0.7, reason: `Keyword match: ${kw}` };
  }
  // Client keywords
  const clientKeywords = ['villa', 'buy', 'interested', 'price', 'visit', 'ซื้อ', 'สนใจ', 'ราคา', 'ดูบ้าน', 'looking for'];
  for (const kw of clientKeywords) {
    if (combined.includes(kw)) return { type: 'client', confidence: 0.6, reason: `Keyword match: ${kw}` };
  }
  return { type: 'unknown', confidence: 0.3, reason: 'No keyword match' };
}

exports.wa_webhook = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const payload = req.body || {};
    console.log('WA webhook:', JSON.stringify(payload).substring(0, 500));

    // WhatsMonster webhook format varies — handle common structures
    const data = payload.data || payload;
    const event = data.event || payload.event || '';

    // Only process message events
    if (!['message', 'messages', 'chat'].includes(event) && !data.message && !data.messages) {
      res.json({ ok: true, skipped: true });
      return;
    }

    // Extract message data
    const msg = data.message || data.messages?.[0] || data;
    const from = msg.from || msg.sender || '';
    const to = msg.to || msg.recipient || '';
    const body = msg.body || msg.text || msg.message || '';
    const waMessageId = msg.id || msg.key?.id || uuidv4();
    const senderName = msg.pushName || msg.senderName || msg.notify || '';
    const isOutgoing = msg.fromMe === true || msg.from_me === true;
    const msgType = msg.type || 'text';
    const mediaUrl = msg.mediaUrl || msg.media_url || msg.image?.url || msg.document?.url || msg.video?.url || msg.audio?.url || '';

    const phone = cleanPhone(isOutgoing ? to : from);
    if (!phone) { res.json({ ok: true, no_phone: true }); return; }

    const direction = isOutgoing ? 'outgoing' : 'incoming';
    const messageType = mediaUrl ? (msgType === 'image' ? 'image' : msgType === 'document' ? 'document' : msgType === 'video' ? 'video' : msgType === 'audio' ? 'audio' : 'media') : 'text';

    // Deduplicate by wa_message_id
    const [existing] = await bigquery.query({
      query: `SELECT id FROM ${msgTable} WHERE wa_message_id = @wid LIMIT 1`,
      params: { wid: waMessageId },
    });
    if (existing.length) { res.json({ ok: true, duplicate: true }); return; }

    // Find or create contact
    const [contacts] = await bigquery.query({
      query: `SELECT id, contact_type, message_count FROM ${contactTable} WHERE phone = @phone`,
      params: { phone },
    });

    let contactId;
    let isNewContact = false;

    if (contacts.length) {
      contactId = contacts[0].id;
      // Update last_message_at and count
      await bigquery.query({
        query: `UPDATE ${contactTable}
                SET last_message_at = CURRENT_TIMESTAMP(),
                    message_count = IFNULL(message_count, 0) + 1,
                    name = IF(@name != '' AND (name IS NULL OR name = ''), @name, name),
                    is_new = IF(@direction = 'incoming' AND is_new = TRUE, TRUE, IF(@direction = 'outgoing', FALSE, is_new))
                WHERE id = @id`,
        params: { id: contactId, name: senderName, direction },
      });
    } else {
      // New contact
      contactId = uuidv4();
      isNewContact = true;

      // AI classification
      const classification = classifyContact(senderName, body);

      await bigquery.query({
        query: `INSERT INTO ${contactTable}
                  (id, phone, name, contact_type, contact_type_by, first_message_at, last_message_at, message_count, is_new, created_at)
                VALUES (@id, @phone, NULLIF(@name,''), @contact_type, 'ai', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), 1, TRUE, CURRENT_TIMESTAMP())`,
        params: { id: contactId, phone, name: senderName, contact_type: classification.type },
      });

      // Save AI analysis
      await bigquery.query({
        query: `INSERT INTO ${aiTable} (id, contact_id, analysis_type, result, model, created_at)
                VALUES (@id, @cid, 'contact_classification', @result, 'keyword_v1', CURRENT_TIMESTAMP())`,
        params: { id: uuidv4(), cid: contactId, result: JSON.stringify(classification) },
      });
    }

    // Download media if present
    let storedMediaUrl = '';
    let mediaFilename = '';
    let mediaSize = 0;
    if (mediaUrl) {
      storedMediaUrl = await downloadMedia(mediaUrl, phone, waMessageId) || '';
      mediaFilename = msg.filename || msg.document?.filename || `${messageType}_${Date.now()}`;
      mediaSize = msg.fileSize || msg.file_size || 0;
    }

    // Save message
    const msgId = uuidv4();
    await bigquery.query({
      query: `INSERT INTO ${msgTable}
                (id, contact_id, phone, direction, message_type, text, media_url, media_filename, media_size, wa_message_id, raw_data, created_at)
              VALUES (@id, @cid, @phone, @direction, @msg_type, @text, NULLIF(@media_url,''), NULLIF(@media_filename,''), @media_size, @wa_msg_id, @raw_data, CURRENT_TIMESTAMP())`,
      params: {
        id: msgId, cid: contactId, phone, direction,
        msg_type: messageType, text: body || '',
        media_url: storedMediaUrl, media_filename: mediaFilename,
        media_size: parseInt(mediaSize || 0),
        wa_msg_id: waMessageId,
        raw_data: JSON.stringify(payload).substring(0, 10000),
      },
    });

    res.json({ ok: true, message_id: msgId, contact_id: contactId, is_new: isNewContact });
  } catch(e) {
    console.error('WA webhook error:', e);
    res.status(500).json({ error: e.message });
  }
};
