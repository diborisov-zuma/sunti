const GOOGLE_CLIENT_ID = '6445860840-9bfshkstrc2vra49qi847ie9od38614t.apps.googleusercontent.com';

function renderHeader(activePage) {
  const header = document.getElementById('header');
  header.innerHTML = `
    <a class="logo" href="index.html">Sunti</a>

    <nav class="nav">
      <a href="folders.html"  class="nav-link ${activePage === 'folders'  ? 'active' : ''}" id="t-nav-folders"></a>
      <a href="invoices.html" class="nav-link ${activePage === 'invoices' ? 'active' : ''}" id="t-nav-invoices"></a>
      <a href="finance.html"  class="nav-link ${activePage === 'finance'  ? 'active' : ''}" id="t-nav-finance"></a>
      <a href="reports.html"  class="nav-link ${activePage === 'reports'  ? 'active' : ''}" id="t-nav-reports"></a>
      <a href="companies.html" class="nav-link ${activePage === 'companies' ? 'active' : ''}" id="t-nav-companies" style="display:none"></a>
      <a href="users.html"    class="nav-link ${activePage === 'users'    ? 'active' : ''}" id="t-nav-users" style="display:none"></a>
    </nav>

    <div class="header-right">

      <!-- Уведомления -->
      <div id="notifications-btn" style="display:none;position:relative;cursor:pointer" onclick="toggleNotifications()">
        <span style="font-size:1.2rem">🔔</span>
        <span id="unread-badge" style="display:none;position:absolute;top:-4px;right:-4px;background:#c5221f;color:#fff;font-size:0.65rem;font-weight:600;border-radius:10px;padding:1px 5px;min-width:16px;text-align:center"></span>
      </div>

      <!-- Панель уведомлений -->
      <div id="notifications-panel" style="display:none;position:absolute;top:56px;right:16px;width:360px;background:#fff;border:1px solid #e8e8e8;border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,0.12);z-index:200;max-height:400px;overflow-y:auto">
        <div style="padding:12px 16px;border-bottom:1px solid #f0f0f0;font-size:0.85rem;font-weight:600;color:#222" id="t-notifications-title"></div>
        <div id="notifications-list" style="padding:8px 0"></div>
      </div>

      <div class="lang-switcher">
        <button class="lang-btn ${currentLang === 'ru' ? 'active' : ''}" data-lang="ru" onclick="setLang('ru')">RU</button>
        <button class="lang-btn ${currentLang === 'en' ? 'active' : ''}" data-lang="en" onclick="setLang('en')">EN</button>
        <button class="lang-btn ${currentLang === 'th' ? 'active' : ''}" data-lang="th" onclick="setLang('th')">TH</button>
      </div>

      <!-- Telegram статус — показывается после логина -->
      <a id="tg-status-btn" href="telegram.html" style="display:none;text-decoration:none;padding:5px 12px;border-radius:6px;font-size:0.82rem;font-weight:500;white-space:nowrap"></a>

      <div id="signin-btn">
        <div id="g_id_onload"
          data-client_id="${GOOGLE_CLIENT_ID}"
          data-callback="handleCredentialResponse"
          data-auto_prompt="false">
        </div>
        <div class="g_id_signin"
          data-type="standard" data-size="medium" data-theme="outline"
          data-text="signin_with" data-shape="rectangular" data-logo_alignment="left">
        </div>
      </div>

      <div id="user-info" style="display:none">
        <img id="avatar" src="" alt="">
        <div class="user-text">
          <div id="uname" class="uname"></div>
          <div id="uemail" class="uemail"></div>
        </div>
        <button class="btn btn-outline" id="logout-btn" onclick="logout()"></button>
      </div>
    </div>
  `;

  updateHeaderTexts();

  // Закрываем панель при клике вне неё
  document.addEventListener('click', e => {
    const panel = document.getElementById('notifications-panel');
    const btn   = document.getElementById('notifications-btn');
    if (panel && !panel.contains(e.target) && btn && !btn.contains(e.target)) {
      panel.style.display = 'none';
    }
  });
}

function updateHeaderTexts() {
  const nf = document.getElementById('t-nav-folders');
  const ni = document.getElementById('t-nav-invoices');
  const nfi = document.getElementById('t-nav-finance');
  const nr = document.getElementById('t-nav-reports');
  const nc = document.getElementById('t-nav-companies');
  const nu = document.getElementById('t-nav-users');
  const lb = document.getElementById('logout-btn');
  const nt = document.getElementById('t-notifications-title');
  if (nf) nf.textContent = t('navFolders');
  if (ni) ni.textContent = t('navInvoices');
  if (nfi) nfi.textContent = t('navFinance');
  if (nr) nr.textContent = t('navReports');
  if (nc) { nc.textContent = t('navCompanies'); if (typeof isAdmin !== 'undefined' && isAdmin) nc.style.display = 'inline-flex'; else nc.style.display = 'none'; }
  if (nu) { nu.textContent = t('navUsers'); if (typeof isAdmin !== 'undefined' && isAdmin) nu.style.display = 'inline-flex'; else nu.style.display = 'none'; }
  if (lb) lb.textContent = t('logout');
  if (nt) nt.textContent = t('notifications');
}

function toggleNotifications() {
  const panel = document.getElementById('notifications-panel');
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) loadNotifications();
}

async function loadUnreadCount() {
  if (!window._accessToken) return;
  try {
    const r = await fetch(`${API_BASE}/messages/unread`, {
      headers: { 'Authorization': `Bearer ${window._accessToken}` }
    });
    if (!r.ok) return;
    const data = await r.json();
    const total = data.reduce((sum, d) => sum + parseInt(d.unread_count || 0), 0);
    const badge = document.getElementById('unread-badge');
    const btn   = document.getElementById('notifications-btn');
    if (!badge || !btn) return;
    if (total > 0) {
      badge.textContent  = total > 99 ? '99+' : total;
      badge.style.display = 'block';
    } else {
      badge.style.display = 'none';
    }
    btn.style.display = 'block';
    // Сохраняем данные для панели
    window._unreadDocs = data;
  } catch(e) { console.error('Unread count error:', e); }
}

async function loadNotifications() {
  const list = document.getElementById('notifications-list');
  if (!list) return;
  const docs = window._unreadDocs || [];
  if (!docs.length) {
    list.innerHTML = `<div style="padding:16px;text-align:center;color:#bbb;font-size:0.85rem">${t('noNotifications')}</div>`;
    return;
  }
  const pageMap = { invoice: 'invoices.html', transaction: 'invoices.html' };
  list.innerHTML = docs.map(d => {
    const page = pageMap[d.document_type] || 'invoices.html';
    const icon = d.document_type === 'invoice' ? '📄' : '💳';
    return `
      <a href="${page}?document_id=${d.document_id}&type=${d.document_type}"
         style="display:flex;align-items:center;gap:10px;padding:10px 16px;text-decoration:none;color:#333;border-bottom:1px solid #f0f0f0;transition:background 0.1s"
         onmouseover="this.style.background='#f8f8f8'" onmouseout="this.style.background=''">
        <span style="font-size:1.2rem">${icon}</span>
        <div style="flex:1">
          <div style="font-size:0.85rem;font-weight:500">${d.document_type}: ${d.document_id.substring(0,8)}...</div>
          <div style="font-size:0.75rem;color:#c5221f">${d.unread_count} ${t('unreadMessages')}</div>
        </div>
      </a>
    `;
  }).join('');
}

function updateTelegramStatus(hasChatId) {
  const btn = document.getElementById('tg-status-btn');
  if (!btn) return;
  btn.style.display = 'block';
  if (hasChatId) {
    btn.textContent = '✓ Telegram';
    btn.style.background = '#444';
    btn.style.color = '#fff';
    btn.style.pointerEvents = 'none';
    btn.style.cursor = 'default';
  } else {
    btn.textContent = 'Link Telegram';
    btn.style.background = '#c5221f';
    btn.style.color = '#fff';
    btn.style.pointerEvents = 'auto';
    btn.style.cursor = 'pointer';
  }
}

// Запускаем подсчёт непрочитанных каждые 30 секунд
let _unreadInterval = null;
function startUnreadPolling() {
  loadUnreadCount();
  _unreadInterval = setInterval(loadUnreadCount, 30000);
}
function stopUnreadPolling() {
  if (_unreadInterval) clearInterval(_unreadInterval);
}
