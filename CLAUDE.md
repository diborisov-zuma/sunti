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

Page-per-feature static HTML sharing a handful of global scripts loaded via `<script>` tags. No module system — everything lives on `window`. Current pages: `index.html`, `invoices.html` (documents), `finance.html` (transactions ledger), `statements.html` (bank statements), `reports.html`, plus admin pages accessed through the header "⚙ Settings" dropdown: `folders.html`, `companies.html`, `users.html`, `categories.html`. `telegram.html` handles the bot linking flow.

Shared scripts:
- `_config.js` — `API_URL` + `apiFetch()` helper that attaches `Bearer ${window._accessToken}`.
- `_auth.js` — Google Identity Services login. Keeps the ID token and an OAuth access token; the access token is what backends verify. On login it POSTs to `/users` (autoregister/update) then GETs `/users/me` to hydrate `currentMe` / `isAdmin`. Exposes `API_BASE`, `PRIVATE_BUCKET`, `PUBLIC_BUCKET`.
- `_header.js` — renders the top nav into `#header`, admin-only `users` link, notification bell driven by `/messages/unread` polled every 30s.
- `_i18n.js` — `t(key)` translator with `ru`/`en`/`th`; pages call `updateHeaderTexts()` and their own text-update functions on lang change.

Be aware that `_config.js` uses `API_URL` while `_auth.js`/`_header.js` use `API_BASE` — same value, different globals, both in use.

### Backend (`functions/`)

Each entity is a separate Cloud Function directory exporting a single HTTP handler (Functions Framework v2). Current functions: `users`, `users_folders`, `users_statements`, `folders`, `companies`, `company_accounts`, `categories`, `category_types`, `invoices`, `invoice_files`, `transactions`, `transaction_files`, `bank_statements`, `messages`, `telegram`, `telegram_webhook`.

Cloud Functions are auto-deployed on push to `main` by `.github/workflows/functions-deploy.yml` — changed subdirs under `functions/` trigger redeploys (any change to the workflow file itself redeploys all). The job runs as compute SA `6445860840-compute@developer.gserviceaccount.com`, which needs the following roles to work: Cloud Functions Admin, Cloud Run Admin, Cloud Build Editor, Storage Admin (on bucket), Service Account User, Artifact Registry Writer, Service Account Token Creator (on itself — required for V4 signed URL signing).

Shared conventions (see `functions/users/index.js` as the canonical example):
- Every handler sets permissive CORS and handles `OPTIONS` preflight.
- Auth = `verifyToken()` against `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=...`, returning the caller's email. Admin/role checks are then performed by looking that email up in the `users` BigQuery table (`is_admin`, `can_see_salary`, `is_active`).
- Data access is direct BigQuery via `@google-cloud/bigquery` — parameterized queries, `MERGE`/`UPDATE`/`INSERT` against `project-9718e7d4-4cd7-4f52-8d6.sunti.<table>`.
- Routing inside a function is done by inspecting `req.method` and `req.url` substrings (e.g. `/me`, trailing email). There is no Express router.
- Soft deletes: `documents` (renamed from `invoices`) and `transactions` use soft-delete flags rather than row removal — recent commits: `Soft delete for invoices and transactions`, `Rename invoices to documents, add folder_id to transactions`.
- Role-based access control is recent (commit `Role-based access control`) — new endpoints should respect `is_admin` / `can_see_salary` and the `users_folders` join table for per-folder access.

### Data model — BigQuery `sunti` dataset

**Access / RBAC**
- `users` — `{email, name, is_admin, can_see_salary, is_active, telegram_chat_id, telegram_username, first_login, last_login}`. `email` is the lookup key.
- `users_folders` — grants folder access: `{id, user_email, folder_id, docs_access}`. `docs_access` ∈ `viewer/editor` (absence of row = no access). Non-admin sees only folders joined via this table; admins see all.
- `users_statements` — same pattern for bank statements per company: `{id, user_email, company_id, statement_access}`.

**Org structure**
- `companies` — `{id, name, registration_number}`.
- `company_accounts` — `{id, company_id, name, bank_name, bank_account, is_active}`. Used as `transactions.account_id`.
- `folders` — projects: `{id, name, order, status (active|archive), company_id, created_by, created_at}`. Everything (invoices, transactions) lives inside a folder.

**Directories**
- `category_types` — `{id, name, name_en, name_th, sort_order}`. Seeded with `expense/income/transfer`, user-editable from `categories.html`.
- `categories` — `{id, name, name_en, name_th, type, sort_order}`. `type` is a string FK to `category_types.id`.

**Documents + payments (core domain)**
- `invoices` — `{id, folder_id, name, status, direction, total_amount, paid_amount, category_id, date, uploaded_by, uploaded_at}`. `paid_amount` is **computed server-side** (`recalcInvoicePaid` in `functions/transactions/index.js`) after any transaction mutation that touches `invoice_id`. Formula is **relative to the document's own direction**: transactions with the same direction as the doc add to `paid_amount`, transactions with the opposite direction subtract. Result can be negative and is stored as-is. On render, if `doc.direction = 'expense'`, multiply both `total_amount` and `paid_amount` by -1 before displaying (so expense docs look negative in the table). Treat as read-only from UI.
- `transactions` — `{id, date, amount (NUMERIC), direction, account_id, category_id, invoice_id?, folder_id, description, status (active|deleted), created_at}`. `invoice_id` is optional; if set, folder must match the invoice's folder.

**Files (stored in GCS `sunti-site`, accessed via V4 signed URLs)**
- `invoice_files` — `{id, invoice_id, file_url, file_name, file_size, uploaded_by, uploaded_at}`.
- `transaction_files` — same shape, keyed by `transaction_id`.
- `bank_statements` holds file columns inline (one file per statement).

**Bank statements (separate domain — not bound to folders/invoices)**
- `bank_statements` — `{id, company_id, account_id, name, date, file_url, file_name, file_size, uploaded_by, uploaded_at}`. Visibility controlled by `users_statements`.

**Communication**
- `messages` — chat attached to any doc: `{id, document_id, document_type (invoice|transaction), text, from_user, to_users, is_read, created_at}`. Drives the notification bell.

**Invoice ↔ transaction linking (two-way)**
- Invoice can spawn transactions (from the document's expanded view, button "Add transaction" or "Find transaction").
- From finance.html a transaction can only **link** to or **unlink** from an existing invoice — **no creation of invoices outside invoices.html**. Rule: documents are created and edited only on the documents page (`invoices.html`).
- A transaction that is already linked to a document **cannot be re-linked** to a different document directly. The user must explicitly unlink first (in the edit modal: click the × next to the document chip, or in the expanded row: "Unlink document"). Only once the link is cleared does the "Link to document" action open the picker.
- **Invariant: both must share the same `folder_id`.** When linking, the picker for invoices is filtered by the transaction's `folder_id` (and vice versa). `paid_amount` on the invoice is recomputed after every link/unlink/create/delete/edit.

**Transaction modal contract (create and edit)**

Applies to both `finance.html` and `invoices.html` modal-trx. The modal always has these fields: Name (description), Date (required), Type (direction), Amount, Category (required), Account (required), Folder, Document link.

Required-field validation runs on save: missing Date / Category / Account / Folder → block save + highlight the inputs. Server receives `account_id` / `category_id` / `folder_id` / `date` and rejects with 400 otherwise.

The Folder and Document fields behave by context:

| Context | Folder | Document |
|---|---|---|
| Create on finance.html (no invoice) | Editable picker (required) | Optional "Link to document" button (chip shown when picked) |
| Create on finance.html, already linked | Locked, inherited from invoice | Chip with current invoice, "Unlink" button |
| Create on invoices.html (from a document) | Locked, inherited from the document | Chip with this document, no unlink |
| Edit on finance.html, tx has no invoice | Editable (required) | "Link to document" button |
| Edit on finance.html, tx has invoice | Locked | Chip + "Unlink" |
| Edit on invoices.html | Locked (from invoice) | Chip, no unlink |

On save, if there's a `invoice_id`, enforce `transaction.folder_id == invoice.folder_id` (server-side check as well — reject mismatch).

**Filter defaults on invoices.html and finance.html**
- `date_from` and `date_to` default to today.
- **Company** is a required filter — mark its label with the red asterisk and treat it as invalid until chosen. Until a company is picked, no data is loaded and the rest of the filters stay disabled.
- Once a company is picked:
  - The **Account** filter's options are limited to that company's `company_accounts`.
  - The **Project (folder)** filter's options are limited to folders with `folder.company_id = selected`.
- **Modal dropdowns on these pages inherit the selected company.** Any transaction or document modal opened from invoices.html / finance.html must also filter its dropdowns the same way: account options — only `company_accounts` of the selected company; folder options — only folders with that `company_id`. Never show company-agnostic lists while a company context is active.

**Amount sign convention**
- In DB and in UI input, `amount` / `total_amount` / `paid_amount` are always **positive**. Direction is carried separately via `direction` (`income` / `expense`).
- All numeric inputs must reject negative values: `min="0"` on the input and a server-side rejection for negative amounts on POST/PUT.
- All *displayed* monetary values in listings show a leading sign based on direction: `-amount` for expense (red), `+amount` or plain number for income (green). Applies to both transactions (finance.html) and invoices (invoices.html).

**Invariants / cascades**
- Hard-delete of an invoice cascades: invoice_files → transactions → transaction_files → GCS blobs.
- Soft-delete (`status='deleted'`) is the default for invoices and transactions; the table always holds the row.
- Transaction amount is stored unsigned NUMERIC; sign of the cashflow comes from `direction`. Inserts must `CAST(@amount AS NUMERIC)` — BigQuery won't coerce FLOAT64.
- BigQuery DML quirks: batch UPDATEs use `UPDATE ... SET x = CASE id WHEN ... END WHERE id IN UNNEST(@ids)` (one round-trip instead of a loop — avoids "concurrent update" on the same table).
- `categories.type` groups items in combo dropdowns but has **no business logic** otherwise; direction/totals are computed from `transactions.direction`.

BigQuery console: https://console.cloud.google.com/bigquery?project=project-9718e7d4-4cd7-4f52-8d6

### Storage buckets

- `sunti-site` (public) — public assets.
- `sunti-private` — private uploads (invoice / transaction files). `cors.json` / `json/cors-private.json` are the CORS configs applied to them.

## Conventions when changing code

- When adding a new entity, create a new `functions/<name>/` sibling (copy an existing one's `package.json`), not a route inside an existing function. `HELPS/Создание новой сущности.txt` exists but is empty — follow the pattern in `functions/users/index.js`.
- Any new user-visible string must be added to all three locales in `_i18n.js` and referenced via `t('key')`.
- Admin-only UI is hidden by setting `style.display = 'none'` and flipped on in `updateHeaderTexts()` / page init based on `isAdmin`; follow that pattern rather than rendering conditionally.
- Comments and help files in this repo are partly in Russian — keep existing Russian comments intact when editing nearby code.
