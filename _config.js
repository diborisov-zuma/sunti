const API_URL = 'https://asia-southeast1-project-9718e7d4-4cd7-4f52-8d6.cloudfunctions.net';

// Хелпер для запросов к API с авторизацией
async function apiFetch(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${window._accessToken}`,
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }

  return res.json();
}
