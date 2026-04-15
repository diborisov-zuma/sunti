const TELEGRAM_TOKEN = '8766299522:AAGfJ9mdsOWv2f_HgNsRH0sjC3XweStQWRQ';
const TELEGRAM_API   = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// Список получателей уведомлений
// Добавляй chat_id сотрудников сюда
const RECIPIENTS = [
  66782755, // Дмитрий
];

function setCors(res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
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

async function sendMessage(chatId, text) {
  await fetch(`${TELEGRAM_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:    chatId,
      text,
      parse_mode: 'HTML',
    }),
  });
}

async function broadcast(text) {
  await Promise.all(RECIPIENTS.map(id => sendMessage(id, text)));
}

exports.telegram = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const email = await verifyToken(req);
  if (!email) { res.status(401).json({ error: 'Unauthorized' }); return; }

  try {
    const { type, data } = req.body;

    let text = '';

    if (type === 'invoice_created') {
      text = `📄 <b>Новая накладная</b>\n` +
             `🏠 Проект: ${data.folder_name}\n` +
             `📝 Название: ${data.name}\n` +
             `📊 Статус: ${statusLabel(data.status)}\n` +
             `💰 Сумма: ${fmt(data.total_amount)} ฿\n` +
             `👤 Создал: ${email}`;
    }

    else if (type === 'invoice_status_changed') {
      text = `🔄 <b>Статус накладной изменён</b>\n` +
             `🏠 Проект: ${data.folder_name}\n` +
             `📝 Накладная: ${data.name}\n` +
             `📊 ${statusLabel(data.old_status)} → ${statusLabel(data.new_status)}\n` +
             `👤 Изменил: ${email}`;
    }

    else if (type === 'invoice_paid') {
      text = `✅ <b>Накладная оплачена</b>\n` +
             `🏠 Проект: ${data.folder_name}\n` +
             `📝 Накладная: ${data.name}\n` +
             `💰 Сумма: ${fmt(data.total_amount)} ฿\n` +
             `👤 Отметил: ${email}`;
    }

    else if (type === 'file_uploaded') {
      text = `📎 <b>Загружен файл</b>\n` +
             `🏠 Проект: ${data.folder_name}\n` +
             `📝 Накладная: ${data.invoice_name}\n` +
             `🗂 Файл: ${data.file_name}\n` +
             `👤 Загрузил: ${email}`;
    }

    else if (type === 'custom') {
      text = data.text;
    }

    else {
      res.status(400).json({ error: 'Unknown notification type' });
      return;
    }

    await broadcast(text);
    res.json({ success: true });

  } catch(e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
};

function statusLabel(s) {
  const map = {
    active:  'Активный',
    to_pay:  'К оплате',
    partial: 'Частично оплачен',
    paid:    'Оплачен',
  };
  return map[s] || s;
}

function fmt(n) {
  return parseFloat(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
