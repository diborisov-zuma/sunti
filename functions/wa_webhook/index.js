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
 * Deep classification: only classify when confident.
 * Returns 'unknown' unless strong signal found.
 * Analyzes cumulative messages, not just one.
 */
function classifyContact(name, allTexts) {
  const combined = ((name || '') + ' ' + (allTexts || '')).toLowerCase();

  // ── AGENT: high confidence patterns ──
  const agentStrong = [
    'sales kit', 'saleskit', 'sale kit',
    'commission', 'co-agent', 'coagent',
    'i am agent', 'i\'m an agent', 'i am a real estate', 'i\'m a broker',
    'my client', 'i have a client', 'i have client', 'my buyer',
    'agency', 'co-broke', 'cobroke',
    'ผมเป็นเอเจนต์', 'เป็นเอเจ', 'เป็นนายหน้า', 'ตัวแทน',
    'ค่าคอม', 'คอมมิชชั่น', 'sales kit',
    'сотрудничество', 'агент', 'я агент', 'являюсь агентом',
    'комиссия', 'комиссионн', 'клиент ищет', 'для клиента',
  ];
  for (const kw of agentStrong) {
    if (combined.includes(kw)) return { type: 'agent', confidence: 0.95, reason: `Strong match: "${kw}"` };
  }

  // ── CLIENT: high confidence patterns ──
  const clientStrong = [
    'i am looking for myself', 'for myself', 'for my family',
    'i want to buy', 'i\'d like to buy', 'interested in buying',
    'looking for a villa', 'looking for a house', 'looking for property',
    'i am a buyer', 'i\'m a buyer', 'direct buyer',
    'want to visit', 'can i visit', 'can i see', 'schedule a visit',
    'ซื้อเอง', 'สนใจซื้อ', 'อยากดู', 'ดูบ้าน', 'สนใจบ้าน',
    'хочу купить', 'для себя', 'хочу посмотреть', 'прямой покупатель',
    'ищу для себя', 'присматриваю', 'хочу приехать посмотреть',
  ];
  for (const kw of clientStrong) {
    if (combined.includes(kw)) return { type: 'client', confidence: 0.9, reason: `Strong match: "${kw}"` };
  }

  // ── Not enough signal — stay unknown ──
  return { type: 'unknown', confidence: 0, reason: 'Not enough signal to classify' };
}

exports.wa_webhook = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const payload = req.body || {};
    const payloadStr = JSON.stringify(payload).substring(0, 10000);
    console.log('WA webhook:', payloadStr);

    // Debug logging removed — format known

    // WhatsMonster format: { instance_id, data: { event, data: { messages: [...], type } } }
    const outerData = payload.data || payload;
    const event = outerData.event || '';
    const innerData = outerData.data || outerData;

    // Only process message events
    const messages = innerData.messages || outerData.messages || [];
    if (!messages.length && !innerData.message) {
      // Try flat format
      if (outerData.message || payload.message) {
        messages.push(outerData.message || payload);
      } else {
        res.json({ ok: true, skipped: true, event });
        return;
      }
    }

    const msg = messages[0] || innerData.message || {};
    const key = msg.key || {};
    const msgContent = msg.message || {};

    // Extract fields
    const remoteJid = key.remoteJid || msg.from || '';
    const remoteJidAlt = key.remoteJidAlt || '';
    const body = msgContent.conversation || msgContent.extendedTextMessage?.text || msg.body || msg.text || '';
    const waMessageId = key.id || msg.id || uuidv4();
    const senderName = msg.pushName || msg.senderName || msg.notify || '';
    const isOutgoing = key.fromMe === true || msg.fromMe === true;
    const msgType = msgContent.imageMessage ? 'image' : msgContent.documentMessage ? 'document' : msgContent.videoMessage ? 'video' : msgContent.audioMessage ? 'audio' : 'text';
    const mediaUrl = msgContent.imageMessage?.url || msgContent.documentMessage?.url || msgContent.videoMessage?.url || msgContent.audioMessage?.url || msg.mediaUrl || '';

    // Get counterpart phone: for outgoing use remoteJidAlt (actual phone),
    // for incoming use remoteJid. Skip @lid addresses without alt.
    let rawJid = remoteJid;
    if (isOutgoing && remoteJidAlt && remoteJidAlt.includes('@s.whatsapp.net')) {
      rawJid = remoteJidAlt;
    } else if (!isOutgoing && remoteJidAlt && remoteJid.includes('@lid')) {
      rawJid = remoteJidAlt;
    }
    // Skip group messages and status broadcasts
    if (rawJid.includes('@g.us') || rawJid === 'status@broadcast') {
      res.json({ ok: true, skipped: 'group_or_status' }); return;
    }
    const phone = cleanPhone(rawJid);
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
      query: `SELECT id, contact_type, contact_type_by, message_count FROM ${contactTable} WHERE phone = @phone`,
      params: { phone },
    });

    let contactId;
    let isNewContact = false;

    if (contacts.length) {
      contactId = contacts[0].id;
      const currentType = contacts[0].contact_type;
      const currentTypeBy = contacts[0].contact_type_by;

      // Update last_message_at and count
      await bigquery.query({
        query: `UPDATE ${contactTable}
                SET last_message_at = CURRENT_TIMESTAMP(),
                    message_count = IFNULL(message_count, 0) + 1,
                    name = IF(@direction = 'incoming' AND @name != '' AND (name IS NULL OR name = ''), @name, name),
                    is_new = IF(@direction = 'outgoing', FALSE, is_new)
                WHERE id = @id`,
        params: { id: contactId, name: senderName, direction },
      });

      // Re-classify if still unknown and not manually set
      if ((currentType === 'unknown' || !currentType) && currentTypeBy !== 'manual') {
        // Get all messages for context
        const [allMsgs] = await bigquery.query({
          query: `SELECT text FROM ${msgTable} WHERE contact_id = @cid AND direction = 'incoming' ORDER BY created_at ASC LIMIT 10`,
          params: { cid: contactId },
        });
        const allTexts = allMsgs.map(m => m.text || '').join(' ') + ' ' + (body || '');
        const reclass = classifyContact(senderName, allTexts);
        if (reclass.type !== 'unknown' && reclass.confidence >= 0.9) {
          await bigquery.query({
            query: `UPDATE ${contactTable} SET contact_type = @type, contact_type_by = 'ai' WHERE id = @id`,
            params: { id: contactId, type: reclass.type },
          });
          await bigquery.query({
            query: `INSERT INTO ${aiTable} (id, contact_id, analysis_type, result, model, created_at)
                    VALUES (@id, @cid, 'reclassification', @result, 'deep_keywords_v2', CURRENT_TIMESTAMP())`,
            params: { id: uuidv4(), cid: contactId, result: JSON.stringify(reclass) },
          });
        }
      }
    } else {
      // New contact — start as unknown, classify only if strong signal
      contactId = uuidv4();
      isNewContact = true;

      const classification = classifyContact(senderName, body);

      await bigquery.query({
        query: `INSERT INTO ${contactTable}
                  (id, phone, name, contact_type, contact_type_by, first_message_at, last_message_at, message_count, is_new, created_at)
                VALUES (@id, @phone, NULLIF(@name,''), @contact_type, @type_by, CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP(), 1, TRUE, CURRENT_TIMESTAMP())`,
        params: { id: contactId, phone, name: senderName, contact_type: classification.type, type_by: classification.confidence >= 0.9 ? 'ai' : 'ai' },
      });

      // Save AI analysis
      await bigquery.query({
        query: `INSERT INTO ${aiTable} (id, contact_id, analysis_type, result, model, created_at)
                VALUES (@id, @cid, 'contact_classification', @result, 'deep_keywords_v2', CURRENT_TIMESTAMP())`,
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
                (id, contact_id, phone, direction, message_type, text, media_url, media_filename, media_size, wa_message_id, raw_data, is_read, created_at)
              VALUES (@id, @cid, @phone, @direction, @msg_type, @text, NULLIF(@media_url,''), NULLIF(@media_filename,''), @media_size, @wa_msg_id, @raw_data, @is_read, @msg_time)`,
      params: {
        id: msgId, cid: contactId, phone, direction,
        msg_type: messageType, text: body || '',
        media_url: storedMediaUrl, media_filename: mediaFilename,
        media_size: parseInt(mediaSize || 0),
        wa_msg_id: waMessageId,
        raw_data: JSON.stringify(payload).substring(0, 10000),
        is_read: isOutgoing, // outgoing messages are always "read"
        msg_time: msg.messageTimestamp ? new Date(parseInt(msg.messageTimestamp) * 1000).toISOString() : new Date().toISOString(),
      },
    });

    res.json({ ok: true, message_id: msgId, contact_id: contactId, is_new: isNewContact });
  } catch(e) {
    console.error('WA webhook error:', e);
    res.status(500).json({ error: e.message });
  }
};
