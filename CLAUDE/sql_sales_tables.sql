-- ============================================
-- Sales module tables — BigQuery sunti dataset
-- Run in: https://console.cloud.google.com/bigquery?project=project-9718e7d4-4cd7-4f52-8d6
-- ============================================

-- 1. Buyers (покупатели)
CREATE TABLE IF NOT EXISTS `project-9718e7d4-4cd7-4f52-8d6.sunti.buyers` (
  id STRING NOT NULL,
  type STRING,                    -- individual / juristic / foreign_individual / foreign_juristic
  name_en STRING,
  name_th STRING,
  email STRING,
  phone STRING,
  passport_number STRING,         -- for foreigners
  national_id STRING,             -- 13-digit Thai ID
  tax_id STRING,
  nationality STRING,             -- thai / russian / chinese / etc
  address_en STRING,
  address_th STRING,
  notes STRING,
  is_active BOOL DEFAULT TRUE,
  created_by STRING,
  created_at TIMESTAMP
);

-- 2. Sales (сделки: одна сделка = один покупатель + одна вилла)
CREATE TABLE IF NOT EXISTS `project-9718e7d4-4cd7-4f52-8d6.sunti.sales` (
  id STRING NOT NULL,
  folder_id STRING,               -- FK → folders (вилла/проект)
  buyer_id STRING,                -- FK → buyers
  company_id STRING,              -- FK → companies (продающее юр. лицо)
  name STRING,
  status STRING DEFAULT 'reservation',  -- reservation / contracted / in_progress / completed / cancelled
  reservation_date DATE,
  reservation_amount NUMERIC,
  total_amount NUMERIC DEFAULT 0, -- сумма всех контрактов (computed)
  paid_amount NUMERIC DEFAULT 0,  -- сумма всех платежей (computed)
  transfer_date DATE,             -- дата передачи собственности
  notes STRING,
  created_by STRING,
  created_at TIMESTAMP
);

-- 3. Sales contracts (контракты продажи: земля / строительство / дом)
CREATE TABLE IF NOT EXISTS `project-9718e7d4-4cd7-4f52-8d6.sunti.sales_contracts` (
  id STRING NOT NULL,
  sale_id STRING,                 -- FK → sales
  contract_type STRING,           -- land_purchase / construction / house_purchase
  contract_number STRING,         -- внешний номер договора
  name STRING,
  date DATE,                      -- дата подписания
  total_amount NUMERIC DEFAULT 0,
  paid_amount NUMERIC DEFAULT 0,  -- computed: сумма платежей
  status STRING DEFAULT 'draft',  -- draft / signed / active / completed / terminated
  expected_completion DATE,
  actual_completion DATE,
  notes STRING,
  sort_order INT64 DEFAULT 0,
  created_by STRING,
  created_at TIMESTAMP
);

-- 4. Payment schedules (график платежей / milestones)
CREATE TABLE IF NOT EXISTS `project-9718e7d4-4cd7-4f52-8d6.sunti.payment_schedules` (
  id STRING NOT NULL,
  contract_id STRING,             -- FK → sales_contracts
  name STRING,                    -- "Бронирование", "Фундамент", "Передача"
  milestone_type STRING,          -- booking / signing / construction / installment / transfer
  due_date DATE,
  amount NUMERIC DEFAULT 0,
  percentage NUMERIC DEFAULT 0,   -- % от суммы контракта
  paid_amount NUMERIC DEFAULT 0,  -- computed
  status STRING DEFAULT 'upcoming', -- upcoming / due / overdue / paid / partially_paid / waived
  sort_order INT64 DEFAULT 0,
  notes STRING,
  created_by STRING,
  created_at TIMESTAMP
);

-- 5. Sales payments (фактические платежи покупателей)
CREATE TABLE IF NOT EXISTS `project-9718e7d4-4cd7-4f52-8d6.sunti.sales_payments` (
  id STRING NOT NULL,
  contract_id STRING,             -- FK → sales_contracts
  schedule_id STRING,             -- FK → payment_schedules (nullable)
  amount NUMERIC,
  payment_date DATE,
  payment_method STRING,          -- bank_transfer / cash / check
  reference STRING,               -- номер платёжки
  account_id STRING,              -- FK → company_accounts (на какой счёт пришло)
  receipt_number STRING,
  status STRING DEFAULT 'confirmed', -- confirmed / pending / cancelled
  notes STRING,
  created_by STRING,
  created_at TIMESTAMP
);

-- 6. Sales contract files (файлы контрактов продажи)
CREATE TABLE IF NOT EXISTS `project-9718e7d4-4cd7-4f52-8d6.sunti.sales_contract_files` (
  id STRING NOT NULL,
  contract_id STRING,             -- FK → sales_contracts
  file_name STRING,
  file_url STRING,
  file_size INT64,
  uploaded_by STRING,
  uploaded_at TIMESTAMP
);
