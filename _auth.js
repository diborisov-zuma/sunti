const PRIVATE_BUCKET = 'https://storage.googleapis.com/sunti-private';
const PUBLIC_BUCKET  = 'https://storage.googleapis.com/sunti-site';

let currentUser  = null;
let isAdmin      = false;
let _accessToken = null;
let _tokenClient = null;

function parseJwt(token) {
  const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(
    atob(base64).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join('')
  ));
}

function isTokenExpired(token) {
  try {
    return parseJwt(token).exp * 1000 < Date.now();
  } catch { return true; }
}

async function checkAdmin(email) {
  try {
    const r = await fetch(`${PRIVATE_BUCKET}/admins.json`, {
      headers: { 'Authorization': `Bearer ${_accessToken}` }
    });
    if (!r.ok) return false;
    const data = await r.json();
    return data.admins.map(e => e.toLowerCase()).includes(email.toLowerCase());
  } catch { return false; }
}

async function applyLogin(idToken, accessToken) {
  const user   = parseJwt(idToken);
  currentUser  = user;
  _accessToken = accessToken;
  window._googleToken  = idToken;
  window._accessToken  = accessToken;

  isAdmin = await checkAdmin(user.email);

  // Авторегистрация пользователя в БД
  try {
    const API_BASE = 'https://asia-southeast1-project-9718e7d4-4cd7-4f52-8d6.cloudfunctions.net';
    await fetch(`${API_BASE}/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify({ name: user.name }),
    });

    // Проверяем есть ли chat_id у текущего пользователя
    const usersRes = await fetch(`${API_BASE}/users`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (usersRes.ok) {
      const users = await usersRes.json();
      const me = users.find(u => u.email === user.email);
      if (typeof updateTelegramStatus === 'function') {
        updateTelegramStatus(me && me.telegram_chat_id && me.telegram_chat_id !== '');
      }
    }
  } catch(e) { console.error('User register error:', e); }

  document.getElementById('avatar').src         = user.picture;
  document.getElementById('uname').textContent  = user.name;
  document.getElementById('uemail').textContent = user.email;
  document.getElementById('signin-btn').style.display = 'none';
  document.getElementById('user-info').style.display  = 'flex';
  document.getElementById('guest-view').style.display = 'none';
  document.getElementById('app-view').style.display   = 'block';

  if (typeof onLogin === 'function') onLogin(user, isAdmin);

  // Запускаем счётчик непрочитанных
  if (typeof startUnreadPolling === 'function') startUnreadPolling();
}

// Шаг 1 — Google возвращает ID Token после логина
function handleCredentialResponse(response) {
  const idToken = response.credential;
  localStorage.setItem('google_id_token', idToken);

  // Шаг 2 — запрашиваем Access Token для Storage
  _tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/devstorage.read_write',
    callback: async (tokenResponse) => {
      if (tokenResponse.error) return;
      _accessToken = tokenResponse.access_token;
      localStorage.setItem('google_access_token', _accessToken);
      await applyLogin(idToken, _accessToken);
    },
  });

  _tokenClient.requestAccessToken({ prompt: '' });
}

// Автовход при загрузке страницы
async function tryAutoLogin() {
  const idToken     = localStorage.getItem('google_id_token');
  const accessToken = localStorage.getItem('google_access_token');

  if (!idToken || isTokenExpired(idToken)) {
    localStorage.removeItem('google_id_token');
    localStorage.removeItem('google_access_token');
    return;
  }

  // Access token мог истечь (живёт 1 час) — запрашиваем новый тихо
  if (!accessToken) {
    localStorage.removeItem('google_id_token');
    return;
  }

  await applyLogin(idToken, accessToken);
}

function logout() {
  google.accounts.id.disableAutoSelect();
  if (_accessToken) google.accounts.oauth2.revoke(_accessToken);
  localStorage.removeItem('google_id_token');
  localStorage.removeItem('google_access_token');
  currentUser  = null;
  isAdmin      = false;
  _accessToken = null;
  window._googleToken = null;
  window._accessToken = null;

  document.getElementById('signin-btn').style.display = 'block';
  document.getElementById('user-info').style.display  = 'none';
  document.getElementById('guest-view').style.display = 'block';
  document.getElementById('app-view').style.display   = 'none';

  if (typeof onLogout === 'function') onLogout();

  // Останавливаем счётчик непрочитанных
  if (typeof stopUnreadPolling === 'function') stopUnreadPolling();
}

document.addEventListener('DOMContentLoaded', () => {
  // Скрываем guest-view пока проверяем токен
  const guestView = document.getElementById('guest-view');
  if (guestView && localStorage.getItem('google_id_token')) {
    guestView.style.visibility = 'hidden';
  }
  setTimeout(() => {
    tryAutoLogin().finally(() => {
      if (guestView) guestView.style.visibility = '';
    });
  }, 0);
});
