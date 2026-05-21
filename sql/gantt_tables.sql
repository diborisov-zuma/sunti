-- Gantt construction module — BigQuery tables
-- Dataset: project-9718e7d4-4cd7-4f52-8d6.sunti
-- Created: 2026-05-21

-- 1. Add is_template to folders
ALTER TABLE `project-9718e7d4-4cd7-4f52-8d6.sunti.folders`
ADD COLUMN IF NOT EXISTS is_template BOOL;

-- 2. Phases
CREATE TABLE IF NOT EXISTS `project-9718e7d4-4cd7-4f52-8d6.sunti.phases` (
  id STRING NOT NULL,
  folder_id STRING NOT NULL,
  name STRING,
  name_en STRING,
  name_th STRING,
  sort_order INT64
);

-- 3. Tasks
CREATE TABLE IF NOT EXISTS `project-9718e7d4-4cd7-4f52-8d6.sunti.tasks` (
  id STRING NOT NULL,
  phase_id STRING NOT NULL,
  name STRING,
  name_en STRING,
  name_th STRING,
  planned_start DATE,
  planned_end DATE,
  actual_start DATE,
  actual_end DATE,
  duration_days INT64,
  is_critical BOOL,
  sort_order INT64
);

-- 4. Task dependencies
CREATE TABLE IF NOT EXISTS `project-9718e7d4-4cd7-4f52-8d6.sunti.task_dependencies` (
  id STRING NOT NULL,
  predecessor_id STRING NOT NULL,
  successor_id STRING NOT NULL,
  type STRING,
  lag_days INT64
);

-- 5. Delivery schedule
CREATE TABLE IF NOT EXISTS `project-9718e7d4-4cd7-4f52-8d6.sunti.delivery_schedule` (
  id STRING NOT NULL,
  line_item_id STRING NOT NULL,
  batch_number INT64,
  qty NUMERIC,
  unit STRING,
  production_days INT64,
  production_start DATE,
  production_end DATE,
  delivery_days INT64,
  delivery_start DATE,
  delivery_end DATE,
  lifecycle STRING,
  notes STRING
);

-- 6. Material requirements
CREATE TABLE IF NOT EXISTS `project-9718e7d4-4cd7-4f52-8d6.sunti.material_requirements` (
  id STRING NOT NULL,
  task_id STRING NOT NULL,
  line_item_id STRING,
  category STRING,
  required_by_date DATE,
  qty NUMERIC,
  unit STRING,
  notes STRING
);
