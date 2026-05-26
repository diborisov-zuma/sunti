-- ============================================
-- Mission Templates seed — 8 pre-built templates
-- Run AFTER creating tables from missions_tables.sql
-- ============================================

-- 1. task_readiness_check
INSERT INTO `project-9718e7d4-4cd7-4f52-8d6.sunti.mission_templates` (id, code, name, name_en, name_th, trigger_description, trigger_description_en, trigger_description_th, trigger_type, trigger_spec, mission_spec, status, created_by, created_at, updated_at)
VALUES (
  GENERATE_UUID(), 'task_readiness_check',
  'Подтвердить готовность к этапу', 'Confirm readiness for stage', 'ยืนยันความพร้อมสำหรับขั้นตอน',
  'За 3 дня до планового начала этапа Гантта', 'Three days before the planned start of a Gantt task', 'สามวันก่อนวันเริ่มต้นที่วางแผนของขั้นตอน Gantt',
  'scheduled',
  '{"condition_query":"SELECT t.id AS entity_id, t.name, t.name_en, t.name_th, t.planned_start FROM `project-9718e7d4-4cd7-4f52-8d6.sunti.tasks` t JOIN `project-9718e7d4-4cd7-4f52-8d6.sunti.phases` p ON t.phase_id = p.id WHERE DATE(t.planned_start) <= DATE_ADD(CURRENT_DATE(), INTERVAL 3 DAY) AND DATE(t.planned_start) > CURRENT_DATE() AND t.actual_start IS NULL","entity_type":"task"}',
  '{"title_template":{"ru":"Подтвердить готовность к этапу: {name}","en":"Confirm readiness for stage: {name_en}","th":"ยืนยันความพร้อมสำหรับขั้นตอน: {name_th}"},"priority":"normal","due_offset_days":-1,"due_from":"entity.planned_start","assignee_rule":["task.tasks_group.responsible_user_id","role:project_manager","triage"],"watchers_rule":["tasks_group_watchers","role:admin"]}',
  'active', 'system', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
);

-- 2. task_overdue
INSERT INTO `project-9718e7d4-4cd7-4f52-8d6.sunti.mission_templates` (id, code, name, name_en, name_th, trigger_description, trigger_description_en, trigger_description_th, trigger_type, trigger_spec, mission_spec, status, created_by, created_at, updated_at)
VALUES (
  GENERATE_UUID(), 'task_overdue',
  'Разобрать просрочку этапа', 'Investigate task delay', 'ตรวจสอบความล่าช้าของขั้นตอน',
  'Этап Гантта просрочен (дата окончания прошла)', 'Gantt task is overdue (end date passed)', 'ขั้นตอน Gantt เลยกำหนด (วันสิ้นสุดผ่านไปแล้ว)',
  'scheduled',
  '{"condition_query":"SELECT t.id AS entity_id, t.name, t.name_en, t.name_th FROM `project-9718e7d4-4cd7-4f52-8d6.sunti.tasks` t JOIN `project-9718e7d4-4cd7-4f52-8d6.sunti.phases` p ON t.phase_id = p.id WHERE DATE(t.planned_end) < CURRENT_DATE() AND t.actual_end IS NULL","entity_type":"task"}',
  '{"title_template":{"ru":"Разобрать просрочку этапа: {name}","en":"Investigate delay of stage: {name_en}","th":"ตรวจสอบความล่าช้าของขั้นตอน: {name_th}"},"priority":"high","due_offset_days":0,"due_from":"today","assignee_rule":["task.tasks_group.responsible_user_id","role:project_manager","triage"],"watchers_rule":["tasks_group_watchers","role:admin"]}',
  'active', 'system', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
);

-- 3. task_completed
INSERT INTO `project-9718e7d4-4cd7-4f52-8d6.sunti.mission_templates` (id, code, name, name_en, name_th, trigger_description, trigger_description_en, trigger_description_th, trigger_type, trigger_spec, mission_spec, status, created_by, created_at, updated_at)
VALUES (
  GENERATE_UUID(), 'task_completed',
  'Принять работы по этапу', 'Accept completed work for stage', 'รับมอบงานสำหรับขั้นตอน',
  'Этап Гантта переведён в done', 'Gantt task moved to done', 'ขั้นตอน Gantt ถูกย้ายไปเป็น done',
  'event',
  '{"event":"task.status_changed_to_done","entity_type":"task"}',
  '{"title_template":{"ru":"Принять работы по этапу: {name}","en":"Accept completed work for stage: {name_en}","th":"รับมอบงานสำหรับขั้นตอน: {name_th}"},"priority":"normal","due_offset_days":3,"due_from":"today","assignee_rule":["task.tasks_group.responsible_user_id","role:project_manager","triage"],"watchers_rule":["tasks_group_watchers","role:admin"]}',
  'active', 'system', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
);

-- 4. payment_due_today
INSERT INTO `project-9718e7d4-4cd7-4f52-8d6.sunti.mission_templates` (id, code, name, name_en, name_th, trigger_description, trigger_description_en, trigger_description_th, trigger_type, trigger_spec, mission_spec, status, created_by, created_at, updated_at)
VALUES (
  GENERATE_UUID(), 'payment_due_today',
  'Платёж клиента ожидается сегодня', 'Client payment expected today', 'คาดว่าจะได้รับการชำระเงินจากลูกค้าวันนี้',
  'Плановая дата клиентского платежа наступила сегодня', 'Client payment planned date is today', 'วันที่กำหนดการชำระเงินของลูกค้าคือวันนี้',
  'scheduled',
  '{"condition_query":"SELECT ps.id AS entity_id, ps.name, sc.name AS contract_name, ps.amount FROM `project-9718e7d4-4cd7-4f52-8d6.sunti.payment_schedules` ps JOIN `project-9718e7d4-4cd7-4f52-8d6.sunti.sales_contracts` sc ON ps.contract_id = sc.id WHERE DATE(ps.due_date) = CURRENT_DATE() AND ps.status = @status_pending","entity_type":"payment_schedules","params":{"status_pending":"upcoming"}}',
  '{"title_template":{"ru":"Платёж клиента ожидается сегодня: {amount}","en":"Client payment expected today: {amount}","th":"คาดว่าจะได้รับการชำระเงินจากลูกค้าวันนี้: {amount}"},"priority":"normal","due_offset_days":0,"due_from":"today","assignee_rule":["payment_schedules.sales_contract.responsible_user_id","role:sales_manager","triage"],"watchers_rule":["role:admin"]}',
  'active', 'system', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
);

-- 5. payment_overdue
INSERT INTO `project-9718e7d4-4cd7-4f52-8d6.sunti.mission_templates` (id, code, name, name_en, name_th, trigger_description, trigger_description_en, trigger_description_th, trigger_type, trigger_spec, mission_spec, status, created_by, created_at, updated_at)
VALUES (
  GENERATE_UUID(), 'payment_overdue',
  'Платёж просрочен — связаться с клиентом', 'Payment overdue — contact client', 'การชำระเงินเลยกำหนด — ติดต่อลูกค้า',
  'Плановый клиентский платёж просрочен', 'Client planned payment is overdue', 'การชำระเงินตามแผนของลูกค้าเลยกำหนด',
  'scheduled',
  '{"condition_query":"SELECT ps.id AS entity_id, ps.name, sc.name AS contract_name, ps.amount FROM `project-9718e7d4-4cd7-4f52-8d6.sunti.payment_schedules` ps JOIN `project-9718e7d4-4cd7-4f52-8d6.sunti.sales_contracts` sc ON ps.contract_id = sc.id WHERE DATE(ps.due_date) < CURRENT_DATE() AND ps.status = @status_pending","entity_type":"payment_schedules","params":{"status_pending":"upcoming"}}',
  '{"title_template":{"ru":"Платёж просрочен — связаться с клиентом","en":"Payment overdue — contact client","th":"การชำระเงินเลยกำหนด — ติดต่อลูกค้า"},"priority":"urgent","due_offset_days":0,"due_from":"today","assignee_rule":["payment_schedules.sales_contract.responsible_user_id","role:sales_manager","triage"],"watchers_rule":["role:admin"]}',
  'active', 'system', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
);

-- 6. sales_payment_receipt
INSERT INTO `project-9718e7d4-4cd7-4f52-8d6.sunti.mission_templates` (id, code, name, name_en, name_th, trigger_description, trigger_description_en, trigger_description_th, trigger_type, trigger_spec, mission_spec, status, created_by, created_at, updated_at)
VALUES (
  GENERATE_UUID(), 'sales_payment_receipt',
  'Сформировать receipt и отправить клиенту', 'Generate receipt PDF and send to client', 'สร้าง PDF ใบเสร็จและส่งให้ลูกค้า',
  'Поступил факт оплаты от клиента', 'Client payment received', 'ได้รับการชำระเงินจากลูกค้า',
  'event',
  '{"event":"sales_payments.created","entity_type":"sales_payments"}',
  '{"title_template":{"ru":"Сформировать receipt-PDF и отправить клиенту","en":"Generate receipt PDF and send to client","th":"สร้าง PDF ใบเสร็จและส่งให้ลูกค้า"},"priority":"normal","due_offset_days":1,"due_from":"today","assignee_rule":["sales_payments.sales_contract.responsible_user_id","role:sales_manager","triage"],"watchers_rule":["role:admin"]}',
  'active', 'system', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
);

-- 7. delivery_order_overdue
INSERT INTO `project-9718e7d4-4cd7-4f52-8d6.sunti.mission_templates` (id, code, name, name_en, name_th, trigger_description, trigger_description_en, trigger_description_th, trigger_type, trigger_spec, mission_spec, status, created_by, created_at, updated_at)
VALUES (
  GENERATE_UUID(), 'delivery_order_overdue',
  'Заказать материал — дедлайн прошёл', 'Order material — deadline passed', 'สั่งซื้อวัสดุ — เลยกำหนดแล้ว',
  'Дедлайн заказа материала прошёл (не заказано)', 'Material order deadline passed (not ordered)', 'เลยกำหนดสั่งซื้อวัสดุแล้ว (ยังไม่สั่ง)',
  'scheduled',
  '{"condition_query":"SELECT ds.id AS entity_id, mr.task_id, t.name, t.name_en, t.name_th, t.planned_start, ds.production_days, ds.delivery_days FROM `project-9718e7d4-4cd7-4f52-8d6.sunti.delivery_schedule` ds JOIN `project-9718e7d4-4cd7-4f52-8d6.sunti.material_requirements` mr ON (ds.line_item_id = mr.line_item_id OR ds.contract_id = mr.contract_id) JOIN `project-9718e7d4-4cd7-4f52-8d6.sunti.tasks` t ON mr.task_id = t.id WHERE ds.production_start IS NULL AND ds.delivery_start IS NULL AND (IFNULL(ds.production_days,0) > 0 OR IFNULL(ds.delivery_days,0) > 0) AND DATE_SUB(DATE(t.planned_start), INTERVAL (IFNULL(ds.production_days,0) + IFNULL(ds.delivery_days,0)) DAY) < CURRENT_DATE() AND IFNULL(ds.lifecycle,@planned) IN (@planned,@quoted)","entity_type":"delivery_schedule","params":{"planned":"planned","quoted":"quoted"}}',
  '{"title_template":{"ru":"Заказать материал — дедлайн прошёл: {name}","en":"Order material — deadline passed: {name_en}","th":"สั่งซื้อวัสดุ — เลยกำหนดแล้ว: {name_th}"},"priority":"urgent","due_offset_days":0,"due_from":"today","assignee_rule":["task.tasks_group.responsible_user_id","role:project_manager","triage"],"watchers_rule":["tasks_group_watchers","role:admin"]}',
  'active', 'system', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
);

-- 8. delivery_late
INSERT INTO `project-9718e7d4-4cd7-4f52-8d6.sunti.mission_templates` (id, code, name, name_en, name_th, trigger_description, trigger_description_en, trigger_description_th, trigger_type, trigger_spec, mission_spec, status, created_by, created_at, updated_at)
VALUES (
  GENERATE_UUID(), 'delivery_late',
  'Материал опаздывает — связаться с поставщиком', 'Material is late — contact supplier', 'วัสดุล่าช้า — ติดต่อผู้จัดจำหน่าย',
  'Заказанный материал опаздывает (ETA позже начала задачи)', 'Ordered material is late (ETA after task start)', 'วัสดุที่สั่งซื้อล่าช้า (ETA หลังวันเริ่มงาน)',
  'scheduled',
  '{"condition_query":"SELECT ds.id AS entity_id, mr.task_id, t.name, t.name_en, t.name_th, t.planned_start FROM `project-9718e7d4-4cd7-4f52-8d6.sunti.delivery_schedule` ds JOIN `project-9718e7d4-4cd7-4f52-8d6.sunti.material_requirements` mr ON (ds.line_item_id = mr.line_item_id OR ds.contract_id = mr.contract_id) JOIN `project-9718e7d4-4cd7-4f52-8d6.sunti.tasks` t ON mr.task_id = t.id WHERE ds.delivery_end IS NULL AND ds.lifecycle NOT IN (@on_site,@installed) AND (ds.production_start IS NOT NULL OR ds.delivery_start IS NOT NULL) AND (IFNULL(ds.production_days,0) > 0 OR IFNULL(ds.delivery_days,0) > 0) AND DATE_ADD(COALESCE(DATE(ds.delivery_start), DATE(ds.production_end), DATE_ADD(DATE(ds.production_start), INTERVAL IFNULL(ds.production_days,0) DAY)), INTERVAL IFNULL(ds.delivery_days,0) DAY) > DATE(t.planned_start)","entity_type":"delivery_schedule","params":{"on_site":"on_site","installed":"installed"}}',
  '{"title_template":{"ru":"Материал опаздывает — связаться с поставщиком: {name}","en":"Material is late — contact supplier: {name_en}","th":"วัสดุล่าช้า — ติดต่อผู้จัดจำหน่าย: {name_th}"},"priority":"high","due_offset_days":0,"due_from":"today","assignee_rule":["task.tasks_group.responsible_user_id","role:project_manager","triage"],"watchers_rule":["tasks_group_watchers","role:admin"]}',
  'active', 'system', CURRENT_TIMESTAMP(), CURRENT_TIMESTAMP()
);
