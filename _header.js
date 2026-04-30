const GOOGLE_CLIENT_ID = '6445860840-9bfshkstrc2vra49qi847ie9od38614t.apps.googleusercontent.com';

function renderHeader(activePage) {
  const header = document.getElementById('header');
  header.innerHTML = `
    <a class="logo" href="index.html">Sunti</a>

    <nav class="nav">
      <div class="nav-dropdown" id="nav-finance-group" style="display:none">
        <a class="nav-link ${['contracts','ctc','contractors','invoices','finance','ai'].includes(activePage) ? 'active' : ''}" id="t-nav-finance-group"></a>
        <div class="nav-dropdown-menu">
          <a href="contracts.html"    class="${activePage === 'contracts'    ? 'active' : ''}" id="t-nav-contracts" style="display:none"></a>
          <a href="ctc.html"          class="${activePage === 'ctc'          ? 'active' : ''}" id="t-nav-ctc" style="display:none"></a>
          <a href="contractors.html"  class="${activePage === 'contractors'  ? 'active' : ''}" id="t-nav-contractors2" style="display:none"></a>
          <a href="invoices.html"     class="${activePage === 'invoices'     ? 'active' : ''}" id="t-nav-invoices"></a>
          <a href="finance.html"      class="${activePage === 'finance'      ? 'active' : ''}" id="t-nav-finance"></a>
          <a href="ai.html"           class="${activePage === 'ai'           ? 'active' : ''}" id="t-nav-ai" style="display:none"></a>
        </div>
      </div>
      <a href="documentation.html" class="nav-link ${activePage === 'documentation' ? 'active' : ''}" id="t-nav-docs" style="display:none"></a>
      <a href="materials.html" class="nav-link ${activePage === 'materials' ? 'active' : ''}" id="t-nav-materials" style="display:none"></a>
      <a href="whatsapp.html" class="nav-link ${activePage === 'whatsapp' ? 'active' : ''}" id="t-nav-whatsapp" style="display:none"></a>
      <a href="statements.html" class="nav-link ${activePage === 'statements' ? 'active' : ''}" id="t-nav-statements"></a>
      <div class="nav-dropdown" id="nav-settings" style="display:none">
        <a class="nav-link ${['folders','companies','users','categories','portal'].includes(activePage) ? 'active' : ''}" id="t-nav-settings">⚙</a>
        <div class="nav-dropdown-menu">
          <a href="folders.html"      class="${activePage === 'folders'      ? 'active' : ''}" id="t-nav-folders"></a>
          <a href="companies.html"    class="${activePage === 'companies'    ? 'active' : ''}" id="t-nav-companies"></a>
          <a href="users.html"        class="${activePage === 'users'        ? 'active' : ''}" id="t-nav-users"></a>
          <a href="categories.html"   class="${activePage === 'categories'   ? 'active' : ''}" id="t-nav-categories"></a>
          <a href="portal_settings.html" class="${activePage === 'portal' ? 'active' : ''}" id="t-nav-portal"></a>
        </div>
      </div>
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

  // Dropdown toggles
  const sdd = document.getElementById('nav-settings');
  const fdd = document.getElementById('nav-finance-group');
  [sdd, fdd].forEach(dd => {
    if (!dd) return;
    dd.querySelector('.nav-link').addEventListener('click', e => {
      e.preventDefault();
      // Close other dropdowns
      [sdd, fdd].forEach(other => { if (other && other !== dd) other.classList.remove('open'); });
      dd.classList.toggle('open');
    });
  });

  // Закрываем панели при клике вне них
  document.addEventListener('click', e => {
    const panel = document.getElementById('notifications-panel');
    const btn   = document.getElementById('notifications-btn');
    if (panel && !panel.contains(e.target) && btn && !btn.contains(e.target)) {
      panel.style.display = 'none';
    }
    if (sdd && !sdd.contains(e.target)) sdd.classList.remove('open');
    if (fdd && !fdd.contains(e.target)) fdd.classList.remove('open');
  });
}

function updateHeaderTexts() {
  const nf = document.getElementById('t-nav-folders');
  const ni = document.getElementById('t-nav-invoices');
  const nfi = document.getElementById('t-nav-finance');
  const ns  = document.getElementById('t-nav-statements');
  // const nr - reports removed
  const nc = document.getElementById('t-nav-companies');
  const nu = document.getElementById('t-nav-users');
  const ncat = document.getElementById('t-nav-categories');
  const nsett = document.getElementById('t-nav-settings');
  const settWrap = document.getElementById('nav-settings');
  const lb = document.getElementById('logout-btn');
  const nt = document.getElementById('t-notifications-title');
  if (nf) nf.textContent = t('navFolders');
  const nwa = document.getElementById('t-nav-whatsapp');
  if (nwa) {
    nwa.textContent = t('navWhatsapp');
    const meW = typeof currentMe !== 'undefined' ? currentMe : null;
    nwa.style.display = (meW && meW.is_admin === true) ? '' : 'none';
  }
  if (ni) ni.textContent = t('navInvoices');
  if (nfi) nfi.textContent = t('navFinance');
  if (ns)  ns.textContent  = t('navStatements');
  // Finance group dropdown
  const nfg = document.getElementById('t-nav-finance-group');
  const fgWrap = document.getElementById('nav-finance-group');
  if (nfg) nfg.textContent = t('navFinanceGroup');
  if (fgWrap) fgWrap.style.display = 'inline-flex';
  // AI link — same access as contracts
  const nai = document.getElementById('t-nav-ai');
  if (nai) {
    nai.textContent = t('navAi');
    const meAi = typeof currentMe !== 'undefined' ? currentMe : null;
    nai.style.display = (meAi && (meAi.is_admin === true || meAi.has_contracts_access === true)) ? '' : 'none';
  }
  const nct = document.getElementById('t-nav-contracts');
  if (nct) {
    nct.textContent = t('navContracts');
    const me = typeof currentMe !== 'undefined' ? currentMe : null;
    const hasAccess = me && (me.is_admin === true || me.has_contracts_access === true);
    nct.style.display = hasAccess ? '' : 'none';
  }
  const nctc = document.getElementById('t-nav-ctc');
  if (nctc) {
    nctc.textContent = t('navCtc');
    const me0 = typeof currentMe !== 'undefined' ? currentMe : null;
    nctc.style.display = (me0 && (me0.is_admin === true || me0.has_contracts_access === true)) ? '' : 'none';
  }
  const nct2 = document.getElementById('t-nav-contractors2');
  if (nct2) {
    nct2.textContent = t('navContractors');
    const me2 = typeof currentMe !== 'undefined' ? currentMe : null;
    const hasAccess2 = me2 && (me2.is_admin === true || me2.has_contracts_access === true);
    nct2.style.display = hasAccess2 ? '' : 'none';
  }
  const ndocs = document.getElementById('t-nav-docs');
  if (ndocs) {
    ndocs.textContent = t('navDocs');
    const me3 = typeof currentMe !== 'undefined' ? currentMe : null;
    ndocs.style.display = (me3 && (me3.is_admin === true || me3.has_docs_access === true)) ? '' : 'none';
  }
  const nmat = document.getElementById('t-nav-materials');
  if (nmat) {
    nmat.textContent = t('navMaterials');
    const me4 = typeof currentMe !== 'undefined' ? currentMe : null;
    nmat.style.display = (me4 && (me4.is_admin === true || me4.has_materials_access === true)) ? '' : 'none';
  }
  // reports removed
  if (nc) nc.textContent = t('navCompanies');
  if (nu) nu.textContent = t('navUsers');
  if (ncat) ncat.textContent = t('navCategories');
  const nportal = document.getElementById('t-nav-portal');
  if (nportal) nportal.textContent = t('navPortal');
  if (nsett) nsett.textContent = '⚙';
  if (settWrap) settWrap.style.display = (typeof isAdmin !== 'undefined' && isAdmin) ? 'inline-flex' : 'none';
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
    btn.textContent = '✓ TG';
    btn.style.background = '#444';
    btn.style.color = '#fff';
    btn.style.pointerEvents = 'none';
    btn.style.cursor = 'default';
  } else {
    btn.textContent = 'TG';
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
