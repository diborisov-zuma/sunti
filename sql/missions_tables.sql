-- ============================================
-- Mission System tables — BigQuery sunti dataset
-- Run in: https://console.cloud.google.com/bigquery?project=project-9718e7d4-4cd7-4f52-8d6
-- ============================================

-- 1. Missions
CREATE TABLE IF NOT EXISTS `project-9718e7d4-4cd7-4f52-8d6.sunti.missions` (
  id STRING NOT NULL,
  title STRING,
  title_en STRING,
  title_th STRING,
  description STRING,
  description_en STRING,
  description_th STRING,
  status STRING,
  priority STRING,
  entity_type STRING,
  entity_id STRING,
  assignee_id STRING,
  author_id STRING,
  parent_mission_id STRING,
  due_at TIMESTAMP,
  remind_at TIMESTAMP,
  closed_at TIMESTAMP,
  closed_by STRING,
  completion_note STRING,
  completion_note_en STRING,
  completion_note_th STRING,
  auto_generated BOOL,
  template_id STRING,
  needs_triage BOOL,
  recurring_rule STRING,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- 2. Mission watchers
CREATE TABLE IF NOT EXISTS `project-9718e7d4-4cd7-4f52-8d6.sunti.mission_watchers` (
  id STRING NOT NULL,
  mission_id STRING NOT NULL,
  user_id STRING NOT NULL,
  added_at TIMESTAMP,
  added_by STRING,
  auto_added BOOL
);

-- 3. Mission events (audit)
CREATE TABLE IF NOT EXISTS `project-9718e7d4-4cd7-4f52-8d6.sunti.mission_events` (
  id STRING NOT NULL,
  mission_id STRING NOT NULL,
  event_type STRING,
  payload STRING,
  actor_id STRING,
  created_at TIMESTAMP
);

-- 4. Mission comments
CREATE TABLE IF NOT EXISTS `project-9718e7d4-4cd7-4f52-8d6.sunti.mission_comments` (
  id STRING NOT NULL,
  mission_id STRING NOT NULL,
  author_id STRING NOT NULL,
  body STRING,
  attachments STRING,
  created_at TIMESTAMP,
  edited_at TIMESTAMP
);

-- 5. Mission templates
CREATE TABLE IF NOT EXISTS `project-9718e7d4-4cd7-4f52-8d6.sunti.mission_templates` (
  id STRING NOT NULL,
  code STRING,
  name STRING,
  name_en STRING,
  name_th STRING,
  trigger_description STRING,
  trigger_description_en STRING,
  trigger_description_th STRING,
  trigger_type STRING,
  trigger_spec STRING,
  mission_spec STRING,
  status STRING,
  created_by STRING,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- 6. Tasks groups watchers
CREATE TABLE IF NOT EXISTS `project-9718e7d4-4cd7-4f52-8d6.sunti.tasks_groups_watchers` (
  id STRING NOT NULL,
  tasks_group_id STRING NOT NULL,
  user_id STRING NOT NULL,
  added_at TIMESTAMP,
  added_by STRING
);

-- 7. User roles
CREATE TABLE IF NOT EXISTS `project-9718e7d4-4cd7-4f52-8d6.sunti.user_roles` (
  id STRING NOT NULL,
  user_id STRING NOT NULL,
  role STRING,
  is_primary BOOL
);

-- 8. Alter existing tables
ALTER TABLE `project-9718e7d4-4cd7-4f52-8d6.sunti.tasks_groups`
ADD COLUMN IF NOT EXISTS responsible_user_id STRING;

ALTER TABLE `project-9718e7d4-4cd7-4f52-8d6.sunti.sales_contracts`
ADD COLUMN IF NOT EXISTS responsible_user_id STRING;
