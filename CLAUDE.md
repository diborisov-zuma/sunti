# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

"Sunti" — a small multi-page web app (static HTML + vanilla JS frontend, no build step) backed by Google Cloud Functions (Node.js) that read/write Google BigQuery. Hosted on Firebase Hosting; deployed on push to `main` via `.github/workflows/firebase-hosting-merge.yml`. Firestore is configured but locked down (`firestore.rules` denies all) — it is **not** used as the data store; BigQuery is.

GCP project: `project-9718e7d4-4cd7-4f52-8d6`, region `asia-southeast1`, BigQuery dataset `sunti`.

## Running locally

Static frontend from repo root (see `HELPS/ЗАПУСК.txt`):

```
python -m http.server 8080
# or
npx serve .
```

There is no build, bundler, linter, or test suite. Each `functions/<name>/` subdir is an independently deployed Cloud Function with its own `package.json` / `node_modules`; they are not part of a monorepo workspace. Deploying functions is not wired into CI — only Firebase Hosting is.

## Architecture

### Frontend (repo root)

Page-per-feature static HTML (`index.html`, `folders.html`, `invoices.html`, `reports.html`, `users.html`, `telegram.html`) sharing a handful of global scripts loaded via `<script>` tags. No module system — everything lives on `window`.

Shared scripts:
- `_config.js` — `API_URL` + `apiFetch()` helper that attaches `Bearer ${window._accessToken}`.
- `_auth.js` — Google Identity Services login. Keeps the ID token and an OAuth access token; the access token is what backends verify. On login it POSTs to `/users` (autoregister/update) then GETs `/users/me` to hydrate `currentMe` / `isAdmin`. Exposes `API_BASE`, `PRIVATE_BUCKET`, `PUBLIC_BUCKET`.
- `_header.js` — renders the top nav into `#header`, admin-only `users` link, notification bell driven by `/messages/unread` polled every 30s.
- `_i18n.js` — `t(key)` translator with `ru`/`en`/`th`; pages call `updateHeaderTexts()` and their own text-update functions on lang change.

Be aware that `_config.js` uses `API_URL` while `_auth.js`/`_header.js` use `API_BASE` — same value, different globals, both in use.

### Backend (`functions/`)

Each entity is a separate Cloud Function directory exporting a single HTTP handler (Functions Framework v2). Current functions: `users`, `users_folders`, `folders`, `categories`, `invoices`, `invoice_files`, `transactions`, `transaction_files`, `messages`, `telegram`, `telegram_webhook`.

Shared conventions (see `functions/users/index.js` as the canonical example):
- Every handler sets permissive CORS and handles `OPTIONS` preflight.
- Auth = `verifyToken()` against `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=...`, returning the caller's email. Admin/role checks are then performed by looking that email up in the `users` BigQuery table (`is_admin`, `can_see_salary`, `is_active`).
- Data access is direct BigQuery via `@google-cloud/bigquery` — parameterized queries, `MERGE`/`UPDATE`/`INSERT` against `project-9718e7d4-4cd7-4f52-8d6.sunti.<table>`.
- Routing inside a function is done by inspecting `req.method` and `req.url` substrings (e.g. `/me`, trailing email). There is no Express router.
- Soft deletes: `documents` (renamed from `invoices`) and `transactions` use soft-delete flags rather than row removal — recent commits: `Soft delete for invoices and transactions`, `Rename invoices to documents, add folder_id to transactions`.
- Role-based access control is recent (commit `Role-based access control`) — new endpoints should respect `is_admin` / `can_see_salary` and the `users_folders` join table for per-folder access.

### Data model notes

- `users` table holds roles (`is_admin`, `can_see_salary`, `is_active`) and Telegram linking fields (`telegram_chat_id`, `telegram_username`).
- `users_folders` grants folder-level access to non-admin users.
- "Invoices" in the UI and in some function names correspond to the `documents` table after the rename; `transactions` now carry a `folder_id`.

BigQuery console for inspecting tables: https://console.cloud.google.com/bigquery?project=project-9718e7d4-4cd7-4f52-8d6

### Storage buckets

- `sunti-site` (public) — public assets.
- `sunti-private` — private uploads (invoice / transaction files). `cors.json` / `json/cors-private.json` are the CORS configs applied to them.

## Conventions when changing code

- When adding a new entity, create a new `functions/<name>/` sibling (copy an existing one's `package.json`), not a route inside an existing function. `HELPS/Создание новой сущности.txt` exists but is empty — follow the pattern in `functions/users/index.js`.
- Any new user-visible string must be added to all three locales in `_i18n.js` and referenced via `t('key')`.
- Admin-only UI is hidden by setting `style.display = 'none'` and flipped on in `updateHeaderTexts()` / page init based on `isAdmin`; follow that pattern rather than rendering conditionally.
- Comments and help files in this repo are partly in Russian — keep existing Russian comments intact when editing nearby code.
