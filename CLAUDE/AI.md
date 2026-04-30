---
name: AI Document Analysis
description: Architecture and implementation of AI document analysis + contract items tracking in the cabinet
---

## Overview

AI Document Analysis — страница `ai.html` в кабинете, позволяющая загрузить PDF/изображение документа, получить анализ через Claude API и создать записи (контрагент, invoice, контракт + позиции) на основе извлечённых данных.

## Architecture

```
User uploads PDF → ai.html (frontend)
       ↓
  base64 encode → POST /ai_documents
       ↓
  Cloud Function (functions/ai_documents/index.js):
    1. Auth check (verifyToken → users table)
    2. Load context from BigQuery:
       - contractors (name, tax_id, id) — up to 200
       - categories (name, type, id)
    3. Send to Claude API:
       - PDF/image as base64
       - System prompt with JSON schema + DB context
       - Model: claude-haiku-4-5-20251001
    4. Parse JSON response
    5. Return { success, analysis }
       ↓
  Frontend renders structured result with 4-step confirmation:
    Step 1: Contractor (dropdown + create new modal)
    Step 2: Document name (editable text field)
    Step 3: Amounts (editable subtotal/VAT/total)
    Step 4: Category (dropdown)
    → Create document button (disabled until all steps confirmed)
```

## Pages

- `ai.html` — cabinet page, accessible via Finance dropdown in header
- Visibility: same as contracts (admin or has_contracts_access)
- Not shown in portal

## Cloud Function: ai_documents

- **Path:** `functions/ai_documents/`
- **Endpoint:** POST `/ai_documents`
- **Auth:** Bearer token (Google OAuth access token)
- **Dependencies:** `@anthropic-ai/sdk`, `@google-cloud/bigquery`
- **Env var required:** `ANTHROPIC_API_KEY` (set in GCP Cloud Function environment variables)
- **Model:** `claude-haiku-4-5-20251001`

### Request body

```json
{
  "file_base64": "base64-encoded PDF or image",
  "file_name": "invoice.pdf",
  "content_type": "application/pdf",
  "doc_type": "invoice|contract",
  "folder_id": "uuid"
}
```

### Response — AI returns strict JSON

```json
{
  "success": true,
  "analysis": {
    "document_type": "invoice|contract|quotation|receipt",
    "document_number": "string|null",
    "date": "YYYY-MM-DD|null",
    "due_date": "YYYY-MM-DD|null",
    "contractor": {
      "matched_id": "uuid if matched existing contractor, null if new",
      "name": "English name",
      "name_th": "Thai name or null",
      "tax_id": "13-digit or null",
      "address": "string or null",
      "branch": "HQ or branch number",
      "type": "individual|juristic|foreign_individual|foreign_juristic",
      "is_new": true/false
    },
    "category": {
      "matched_id": "uuid if matched, null otherwise",
      "suggested_name": "category name"
    },
    "amounts": {
      "subtotal": number,
      "vat_rate": number,
      "vat_amount": number,
      "wht_rate": number,
      "wht_amount": number,
      "total": number,
      "payable": number,
      "currency": "THB|USD|etc"
    },
    "line_items": [
      {
        "description": "string",
        "quantity": number,
        "unit_price": number,
        "amount": number (qty × unit_price, excl VAT),
        "vat_included": true/false,
        "vat_rate": number,
        "vat_amount": number,
        "amount_with_vat": number,
        "item_type": "goods|service"
      }
    ],
    "direction": "expense|income",
    "payment_terms": "string or null",
    "notes": "string or null",
    "confidence": 0.0-1.0,
    "warnings": ["array of uncertain fields"]
  }
}
```

## Frontend Flow — 4-Step Confirmation

1. **User selects** document type (Invoice/Contract) and project (folder) — both required
2. **User uploads** PDF or image (drag & drop or file picker)
3. **Click "Analyze"** → file sent as base64 to Cloud Function
4. **Result rendered** as structured card with confidence, warnings, document info, contractor block, line items table (with VAT columns), amounts summary
5. **4 confirmation steps (all required before document creation):**
   - **Step 1: Contractor** — dropdown of all contractors from DB, pre-selected by AI. User can change or click "+ New" → opens modal with AI-prefilled fields → "Save & Confirm" creates contractor, adds to dropdown, auto-confirms
   - **Step 2: Document name** — editable text field with AI-suggested name → Confirm
   - **Step 3: Amounts** — editable fields (Subtotal, VAT, Total) → Confirm
   - **Step 4: Category** — dropdown of all categories, pre-selected by AI → Confirm
6. **Create button** — gray and disabled until all 4 steps confirmed. Becomes blue when ready.
7. **On create:**
   - Invoice → POST /invoices
   - Contract → POST /contracts (with `has_items: true` if line_items present) + POST /contract_items/batch

## Contract Items (Артикульный учёт)

### Concept

Contracts can have `has_items = true` flag enabling item-level tracking. Items can be goods (📦) or services (🔧).

### Table: `contract_items`

| Field | Type | Description |
|-------|------|-------------|
| id | STRING | UUID |
| contract_id | STRING | FK → contracts |
| item_type | STRING | `goods` / `service` |
| description | STRING | "GRANTS Fix Window 1960 3810" |
| quantity | NUMERIC | 40 |
| unit_price | NUMERIC | price per unit (excl VAT) |
| amount | NUMERIC | qty × unit_price (excl VAT) |
| vat_rate | NUMERIC | VAT % (e.g. 7) |
| vat_amount | NUMERIC | VAT for this line |
| amount_with_vat | NUMERIC | amount + vat_amount |
| vat_included | BOOL | were prices in source document VAT-inclusive? |
| sort_order | INT64 | display order |
| created_by | STRING | email |
| created_at | TIMESTAMP | |

### Cloud Function: contract_items

- **Path:** `functions/contract_items/`
- **Endpoints:**
  - GET `/contract_items?contract_id=X` — list items
  - POST `/contract_items` — create single item
  - POST `/contract_items/batch` — create multiple items `{ contract_id, items[] }`
  - PUT `/contract_items/:id` — update item
  - DELETE `/contract_items/:id` — delete item

### UI in contracts.html

- Contract modal: checkbox "Артикульный учёт" (`has_items`)
- Expanded contract: purple block showing items table (if `has_items = true`)
- Table columns: #, Description, Type (📦/🔧), Qty, Price, Amount, [VAT, With VAT if any], Delete
- "Add item" button (currently via prompt dialogs)
- Items loaded in `loadContractDetail` only if `has_items = true`

### AI Integration

When creating a contract from AI page:
- If `line_items` present → `has_items` set to `true` automatically
- After contract created → POST `/contract_items/batch` with all items including VAT fields
- Each item gets `item_type` from AI (goods vs service detection)

## Future: Item Tracking (Phase 2)

Planned `item_units` table for per-unit tracking:
- Each unit of goods gets own record with status lifecycle: `ordered → paid → in_transit → warehouse → installed`
- Location tracking per unit
- Services: tracked by completion % rather than units
- Mass operations ("12 units arrived at warehouse")

## Contractor Matching Logic

In the Claude prompt, AI is instructed to:
1. Match by `tax_id` first (exact 13-digit match)
2. Then by name similarity
3. Set `matched_id` only if confident
4. Set `is_new: true` if no match

The list of existing contractors (up to 200) is sent in the system prompt with name, tax_id, and id.

## Header Navigation

AI page is grouped under the **Finance** dropdown in the cabinet header (`_header.js` → `nav-finance-group`):
- Contracts, CTC Report, Contractors, Invoices, Finances, **AI**

Documentation, Materials, WhatsApp, Statements remain as separate nav links.

## Auth Error Logging

Portal auth errors are logged to `portal_auth_logs` table via POST `/portal_contracts/log-error` (no auth required). Frontend sends errors at oauth_token and initApp stages. Visible on login screen as red box.

## Cost

Model: claude-haiku-4-5-20251001 — ~$0.01-0.05 per document page.
API key billing: console.anthropic.com, separate from Claude Pro subscription.
