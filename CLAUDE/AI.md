---
name: AI Document Analysis
description: Architecture and implementation of the AI document analysis feature in the cabinet
---

## Overview

AI Document Analysis — страница `ai.html` в кабинете, позволяющая загрузить PDF/изображение документа, получить анализ через Claude API и создать записи (контрагент, invoice, контракт) на основе извлечённых данных.

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
  Frontend renders structured result:
    - Document info (type, number, date)
    - Contractor block (matched or new)
    - Line items table
    - Amounts summary (subtotal, VAT, WHT, total, payable)
    - Action buttons
```

## Pages

- `ai.html` — cabinet page, accessible via Finance dropdown in header
- Visibility: same as contracts (admin or has_contracts_access)
- Not shown in portal

## Cloud Function

- **Path:** `functions/ai_documents/`
- **Endpoint:** POST `/ai_documents`
- **Auth:** Bearer token (Google OAuth access token)
- **Dependencies:** `@anthropic-ai/sdk`, `@google-cloud/bigquery`
- **Env var required:** `ANTHROPIC_API_KEY` (set in GCP Cloud Function environment variables)

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

### Response

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
      {"description": "string", "quantity": number, "unit_price": number, "amount": number}
    ],
    "direction": "expense|income",
    "payment_terms": "string or null",
    "notes": "string or null",
    "confidence": 0.0-1.0,
    "warnings": ["array of uncertain fields"]
  }
}
```

## Frontend Flow

1. **User selects** document type (Invoice/Contract) and project (folder) — both required
2. **User uploads** PDF or image (drag & drop or file picker)
3. **Click "Analyze"** → file sent as base64 to Cloud Function
4. **Result rendered** as structured card:
   - Confidence indicator (green ≥80%, yellow ≥50%, red <50%)
   - Warnings block
   - Document info grid
   - Contractor block:
     - 🟢 Green background if matched existing contractor in DB
     - 🟡 Yellow background if new contractor (not found)
   - Line items table
   - Amounts summary with subtotal, VAT, WHT, total, payable
5. **Action buttons:**
   - If contractor is new → "🆕 Create contractor" button
   - If contractor matched → "✅ Contractor confirmed" (auto-confirmed)
   - "📄 Create invoice/contract" — disabled until contractor is confirmed/created
6. **Create contractor** → POST /contractors with extracted data → unlocks document creation
7. **Create document** → POST /invoices or /contracts with all extracted fields

## Contractor Matching Logic

In the Claude prompt, AI is instructed to:
1. Match by `tax_id` first (exact 13-digit match)
2. Then by name similarity
3. Set `matched_id` only if confident
4. Set `is_new: true` if no match

The list of existing contractors (up to 200) is sent in the system prompt with name, tax_id, and id.

## Category Matching

Categories list is sent in the system prompt. AI suggests a match based on document content (type of service/goods). Less critical than contractor matching — user can change category later.

## Model

Currently using `claude-haiku-4-5-20251001` — fastest and cheapest. Good for document reading. Can be upgraded to Sonnet for better accuracy on complex documents.

Cost per document: ~$0.01-0.05 depending on page count.

## Header Navigation

AI page is grouped under the **Finance** dropdown in the cabinet header alongside:
- Contracts
- CTC Report
- Contractors
- Documents (Invoices)
- Finances
- **AI**

The Finance dropdown is defined in `_header.js` as `nav-finance-group`.

## Future Enhancements

- Multi-page PDF support (currently sends full document)
- Batch processing (multiple documents)
- Auto-linking created invoice to contract if contract_id detected
- Transaction creation from payment documents
- Learning from corrections (store successful extractions as examples)
- Support for more document types: receipts, bank statements, quotations
