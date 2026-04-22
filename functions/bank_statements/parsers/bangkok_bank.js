/**
 * Bangkok Bank xlsx/xls parser.
 *
 * Actual file layout (TransactionsReport from iBanking):
 *   Row 0:  ["", "", "", "", "", "", "Transaction Report", "", ""]
 *   Row 1:  ["", "", "", "", "", "(Period from DD/MM/YYYY to DD/MM/YYYY)", "", "", ""]
 *   Rows 6-14: Account metadata (Customer, Account Name/Number, Currency, Balances...)
 *   Row 6 col H-I:  "Cash Balance", <number>
 *   Row 16: Header row:
 *     "Transaction Date And Time" | "Value Date" | "Description" | "Cheque No." |
 *     "Debit" | "Credit" | "Ledger Balance" | "Channel" | "Branch"
 *   Row 17+: Data rows.  Debit is negative, Credit is positive or 0.
 *   Bottom: empty rows + footer (Page info, address).
 */

const XLSX = require('xlsx');

// Known header keywords (lowercased) → canonical field name.
const COL_MAP = {
  'transaction date and time': 'datetime',
  'transaction date':          'datetime',
  'value date':                'value_date',
  'description':               'description',
  'cheque no.':                'reference',
  'cheque no':                 'reference',
  'debit':                     'debit',
  'credit':                    'credit',
  'ledger balance':            'balance',
  'balance':                   'balance',
  'channel':                   'channel',
  'branch':                    'branch',
};

const REQUIRED = ['datetime', 'debit', 'credit'];

/**
 * Parse date from "DD/MM/YYYY HH:MM:SS" or "DD/MM/YYYY" or Excel serial.
 * Returns ISO date string YYYY-MM-DD.
 */
function parseDate(val) {
  if (val == null || val === '') return null;

  // Excel serial number
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val);
    if (d) return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    return null;
  }

  const s = String(val).trim();
  if (!s) return null;

  // DD/MM/YYYY HH:MM:SS  or  DD/MM/YYYY
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;

  // ISO
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) return `${m2[1]}-${m2[2]}-${m2[3]}`;

  return null;
}

function parseAmount(val) {
  if (val == null || val === '') return 0;
  if (typeof val === 'number') return val;
  const cleaned = String(val).replace(/[,\s]/g, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
}

/**
 * Extract period from row like: ["", "", "", "", "", "(Period from 01/01/2026 to 31/01/2026)", ...]
 */
function extractPeriod(rows) {
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      const s = String(cell || '');
      const m = s.match(/Period\s+from\s+(\d{1,2}\/\d{1,2}\/\d{4})\s+to\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
      if (m) return { period_from: parseDate(m[1]), period_to: parseDate(m[2]) };
    }
  }
  return { period_from: null, period_to: null };
}

/**
 * Extract opening balance from metadata rows.
 * Row 6 typically has ["Customer","...", ..., "Cash Balance", <number>]
 * Row 10 has ["Account Number", "...", ..., "Ledger Balance", <number>]
 * We look for "Cash Balance" or "Ledger Balance" in early rows.
 */
function extractOpeningBalance(rows) {
  for (let i = 0; i < Math.min(rows.length, 16); i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    for (let j = 0; j < row.length - 1; j++) {
      const label = String(row[j] || '').trim().toLowerCase();
      if (label === 'cash balance' || label === 'ledger balance') {
        const val = parseAmount(row[j + 1]);
        if (val !== 0 || row[j + 1] === 0) return val;
      }
    }
  }
  return null;
}

/**
 * @param {Buffer} fileBuffer
 * @returns {{ lines: Array, period_from, period_to, opening_balance, closing_balance }}
 */
function parse(fileBuffer) {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: false });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  // 1. Extract period from header area
  const { period_from, period_to } = extractPeriod(rows);

  // 2. Extract opening balance from metadata area
  const metaBalance = extractOpeningBalance(rows);

  // 3. Find the header row
  let headerRowIdx = -1;
  let colMapping = {};

  for (let i = 0; i < Math.min(rows.length, 30); i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const mapping = {};
    for (let j = 0; j < row.length; j++) {
      const cell = String(row[j] || '').trim().toLowerCase();
      if (COL_MAP[cell]) {
        mapping[COL_MAP[cell]] = j;
      }
    }
    if (REQUIRED.every(f => f in mapping)) {
      headerRowIdx = i;
      colMapping = mapping;
      break;
    }
  }

  if (headerRowIdx === -1) {
    throw new Error('Could not find header row. Expected columns: Transaction Date, Debit, Credit. Check the file format.');
  }

  // 4. Parse data rows
  const lines = [];

  for (let i = headerRowIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;

    const dateVal = parseDate(row[colMapping.datetime]);
    if (!dateVal) continue; // skip empty / footer rows

    const valueDateVal = colMapping.value_date != null ? parseDate(row[colMapping.value_date]) : null;
    const debit  = parseAmount(row[colMapping.debit]);   // negative in source
    const credit = parseAmount(row[colMapping.credit]);  // positive in source
    const balance = colMapping.balance != null ? parseAmount(row[colMapping.balance]) : null;
    const description = colMapping.description != null ? String(row[colMapping.description] || '').trim() : '';
    const reference   = colMapping.reference != null ? String(row[colMapping.reference] || '').trim() : '';
    const channel     = colMapping.channel != null ? String(row[colMapping.channel] || '').trim() : '';
    const branch      = colMapping.branch != null ? String(row[colMapping.branch] || '').trim() : '';

    // Direction + amount (always positive in our DB).
    // Bangkok Bank: Debit column is negative for expenses, Credit column is positive for income.
    let amount = 0;
    let direction = 'expense';
    if (credit > 0) {
      amount = credit;
      direction = 'income';
    } else if (debit < 0) {
      amount = Math.abs(debit);
      direction = 'expense';
    } else if (debit > 0) {
      // Sometimes debit is positive — treat as expense
      amount = debit;
      direction = 'expense';
    } else {
      continue; // both zero — skip
    }

    lines.push({
      date: dateVal,
      value_date: valueDateVal,
      amount,
      direction,
      description,
      reference: reference || null,
      counterparty: null,
      running_balance: balance,
      currency: 'THB',
      raw_data: {
        datetime: row[colMapping.datetime] || '',
        value_date: colMapping.value_date != null ? row[colMapping.value_date] : '',
        description,
        debit,
        credit,
        balance,
        channel,
        branch,
        reference,
      },
    });
  }

  if (!lines.length) {
    throw new Error('No data rows found after the header. The file may be empty or in an unexpected format.');
  }

  // 5. Sort chronologically. Bangkok Bank files are newest-first.
  if (lines.length > 1 && lines[0].date > lines[lines.length - 1].date) {
    lines.reverse();
  }

  // 6. Compute balances from chronologically ordered data.
  // Closing = last row's running_balance.
  const closingBalance = lines[lines.length - 1].running_balance;

  // Opening = first row's balance reversed by first transaction.
  // opening = first_running_balance + amount (if expense) or - amount (if income).
  // The metadata "Cash Balance" is the balance at download time, NOT at period start.
  let openingBalance = null;
  if (lines[0].running_balance != null) {
    const first = lines[0];
    if (first.direction === 'income') {
      openingBalance = first.running_balance - first.amount;
    } else {
      openingBalance = first.running_balance + first.amount;
    }
  }

  return {
    lines,
    period_from: period_from || lines[0].date,
    period_to: period_to || lines[lines.length - 1].date,
    opening_balance: openingBalance,
    closing_balance: closingBalance,
  };
}

module.exports = { parse };
