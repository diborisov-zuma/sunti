const PRIVATE_BUCKET = 'https://storage.googleapis.com/sunti-private';
const PUBLIC_BUCKET  = 'https://storage.googleapis.com/sunti-site';
const API_BASE       = 'https://asia-southeast1-project-9718e7d4-4cd7-4f52-8d6.cloudfunctions.net';

let currentUser  = null;
let currentMe    = null; // данные из таблицы users
let isAdmin      = false;
let _accessToken = null;
let _tokenClient = null;
let _authRetried = false;

// Тихо запрашивает свежий access token через token client.
// Возвращает токен или null, если обновить без интерактива нельзя.
function refreshAccessToken() {
  return new Promise((resolve) => {
    if (!_tokenClient || typeof google === 'undefined' || !google.accounts?.oauth2) {
      resolve(null);
      return;
    }
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    // Подменяем callback на одноразовый, затем восстанавливаем штатное поведение.
    _tokenClient.callback = (resp) => {
      if (resp && resp.access_token && !resp.error) {
        _accessToken = resp.access_token;
        window._accessToken = _accessToken;
        localStorage.setItem('google_access_token', _accessToken);
        finish(_accessToken);
      } else {
        finish(null);
      }
    };
    try {
      const hint = currentUser?.email;
      _tokenClient.requestAccessToken(hint ? { prompt: '', login_hint: hint } : { prompt: '' });
    } catch (e) {
      console.warn('refreshAccessToken failed:', e);
      finish(null);
    }
    // Защита от зависания: если callback не сработал за 8 сек.
    setTimeout(() => finish(null), 8000);
  });
}

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

async function applyLogin(idToken, accessToken) {
  const user   = parseJwt(idToken);
  currentUser  = user;
  _accessToken = accessToken;
  window._googleToken = idToken;
  window._accessToken = accessToken;

  // Получаем права текущего пользователя (без авторегистрации)
  try {
    const meRes = await fetch(`${API_BASE}/users/me`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!meRes.ok) {
      // Если токен протух (401/403) — пробуем тихо обновить access token и повторить,
      // прежде чем показывать пугающее «не зарегистрирован».
      if ((meRes.status === 401 || meRes.status === 403) && !_authRetried) {
        _authRetried = true;
        const refreshed = await refreshAccessToken();
        if (refreshed) return applyLogin(idToken, refreshed);
        // Тихое обновление не удалось — нужен повторный вход через Google.
        const guestView = document.getElementById('guest-view');
        if (guestView) {
          guestView.innerHTML = `<div style="text-align:center;padding:100px 24px">
              <h2 style="color:#c5221f;margin-bottom:12px">Сессия истекла</h2>
              <p style="color:#666;margin-bottom:24px">Войдите снова, чтобы продолжить работу.</p>
              <button class="btn btn-outline" onclick="logout()">Войти заново</button>
            </div>`;
          guestView.style.display = 'block';
        }
        document.getElementById('signin-btn').style.display = 'none';
        return;
      }
      // Различаем «нет такого пользователя» (404) и «ошибка сервера» (5xx),
      // чтобы временный сбой не выглядел как «вы не зарегистрированы».
      const isServerErr = meRes.status >= 500;
      console.warn('users/me failed:', meRes.status, isServerErr ? '(server error)' : '(not registered)');
      const guestView = document.getElementById('guest-view');
      if (guestView) {
        guestView.innerHTML = isServerErr
          ? `<div style="text-align:center;padding:100px 24px">
              <h2 style="color:#c5221f;margin-bottom:12px">Сервис временно недоступен</h2>
              <p style="color:#666;margin-bottom:24px">Не удалось загрузить ваш профиль (ошибка ${meRes.status}).<br>Повторите попытку позже или обратитесь к администратору.</p>
              <button class="btn btn-outline" onclick="location.reload()">Повторить</button>
              <button class="btn btn-outline" onclick="logout()">Выйти</button>
            </div>`
          : `<div style="text-align:center;padding:100px 24px">
              <h2 style="color:#c5221f;margin-bottom:12px">Доступ запрещён</h2>
              <p style="color:#666;margin-bottom:24px">Ваш аккаунт не зарегистрирован в системе.<br>Обратитесь к администратору.</p>
              <button class="btn btn-outline" onclick="logout()">Выйти</button>
            </div>`;
        guestView.style.display = 'block';
      }
      document.getElementById('signin-btn').style.display = 'none';
      return;
    }
    _authRetried = false;
    currentMe = await meRes.json();
    isAdmin   = currentMe && currentMe.is_admin === true;
    window._currentMe = currentMe;

    // Проверяем что пользователь активен
    if (!currentMe.is_active) {
      const guestView = document.getElementById('guest-view');
      if (guestView) {
        guestView.innerHTML = `<div style="text-align:center;padding:100px 24px">
          <h2 style="color:#c5221f;margin-bottom:12px">Аккаунт деактивирован</h2>
          <p style="color:#666;margin-bottom:24px">Обратитесь к администратору.</p>
          <button class="btn btn-outline" onclick="logout()">Выйти</button>
        </div>`;
        guestView.style.display = 'block';
      }
      document.getElementById('signin-btn').style.display = 'none';
      return;
    }

    // Обновляем кнопку Telegram
    if (typeof updateTelegramStatus === 'function') {
      updateTelegramStatus(currentMe && currentMe.telegram_chat_id && currentMe.telegram_chat_id !== '');
    }
  } catch(e) { console.error('Auth error:', e); return; }

  document.getElementById('avatar').src         = user.picture;
  document.getElementById('uname').textContent  = user.name;
  document.getElementById('uemail').textContent = user.email;
  document.getElementById('signin-btn').style.display = 'none';
  document.getElementById('user-info').style.display  = 'flex';
  document.getElementById('guest-view').style.display = 'none';
  document.getElementById('app-view').style.display   = 'block';

  // Обновляем шапку после логина (видимость пунктов зависит от currentMe)
  if (typeof updateHeaderTexts === 'function') updateHeaderTexts();

  if (typeof onLogin === 'function') onLogin(user, isAdmin);

  // Запускаем счётчик непрочитанных
  if (typeof startUnreadPolling === 'function') startUnreadPolling();

  // Автообновление токена каждые 45 минут
  startTokenRefresh();
}

let _tokenRefreshInterval = null;

function startTokenRefresh() {
  if (_tokenRefreshInterval) clearInterval(_tokenRefreshInterval);
  _tokenRefreshInterval = setInterval(() => {
    if (!_tokenClient || !currentUser?.email) return;
    try {
      _tokenClient.requestAccessToken({ prompt: '', login_hint: currentUser.email });
    } catch(e) { console.warn('Silent token refresh failed:', e); }
  }, 50 * 60 * 1000); // 50 минут (обновляем за 10 мин до истечения)
}

function stopTokenRefresh() {
  if (_tokenRefreshInterval) { clearInterval(_tokenRefreshInterval); _tokenRefreshInterval = null; }
}

// Шаг 1 — Google возвращает ID Token после логина
function handleCredentialResponse(response) {
  const idToken = response.credential;
  localStorage.setItem('google_id_token', idToken);

  _tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/devstorage.read_write',
    callback: async (tokenResponse) => {
      if (tokenResponse.error) return;
      _accessToken = tokenResponse.access_token;
      window._accessToken = _accessToken;
      localStorage.setItem('google_access_token', _accessToken);
      // Если уже залогинены — просто обновляем токен, не перезагружаем UI
      if (currentMe) return;
      await applyLogin(idToken, _accessToken);
    },
  });

  _tokenClient.requestAccessToken({ prompt: '' });
}

// Автовход при загрузке страницы
async function tryAutoLogin() {
  const idToken     = localStorage.getItem('google_id_token');
  const accessToken = localStorage.getItem('google_access_token');

  if (!idToken) return;
  if (!accessToken) return;

  // Инициализируем tokenClient для автообновления
  if (!_tokenClient && typeof google !== 'undefined' && google.accounts?.oauth2) {
    _tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: 'https://www.googleapis.com/auth/devstorage.read_write',
      callback: (tokenResponse) => {
        if (tokenResponse.error) return;
        _accessToken = tokenResponse.access_token;
        window._accessToken = _accessToken;
        localStorage.setItem('google_access_token', _accessToken);
      },
    });
  }

  await applyLogin(idToken, accessToken);
}

function logout() {
  google.accounts.id.disableAutoSelect();
  if (_accessToken) google.accounts.oauth2.revoke(_accessToken);
  localStorage.removeItem('google_id_token');
  localStorage.removeItem('google_access_token');
  currentUser  = null;
  currentMe    = null;
  isAdmin      = false;
  _accessToken = null;
  window._googleToken  = null;
  window._accessToken  = null;
  window._currentMe    = null;

  document.getElementById('signin-btn').style.display = 'block';
  document.getElementById('user-info').style.display  = 'none';
  document.getElementById('guest-view').style.display = 'block';
  document.getElementById('app-view').style.display   = 'none';

  if (typeof onLogout === 'function') onLogout();

  // Останавливаем счётчик непрочитанных и обновление токена
  if (typeof stopUnreadPolling === 'function') stopUnreadPolling();
  stopTokenRefresh();
}

document.addEventListener('DOMContentLoaded', () => {
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
