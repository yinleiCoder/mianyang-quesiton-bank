-- 0021: 修复 admin_delete_user 的引用外键（0015 依赖"作者置空/个人数据级联"语义，
-- 但实际指向 auth.users 的外键在 0001-0004 建表时均为默认 NO ACTION + NOT NULL，
-- 导致删除"出过题 / 参与过审批 / 传过素材"的真实用户被
--   update or delete on table "users" violates FK constraint "questions_creator_id_fkey" …
-- 直接拒绝（此前探针账号能删只是因为它们没有任何引用行）。
-- 本迁移把 0015 注释中的意图真正落到约束层：
--   · 共享内容与历史 —— questions.creator_id、question_versions.created_by、
--     media_objects.uploaded_by、subject_nodes.created_by、approver_assignments.created_by、
--     user_roles.created_by、tags.created_by、approvals.assigned_user_id|decided_by、
--     audit_log.user_id → ON DELETE SET NULL，并放开相应 NOT NULL：
--     已入库共享题目不随作者删除（作者显示"已注销"）、在途任务自动转"待指派"、
--     审计与内容时间线保留；
--   · 个人数据 —— profiles.user_id / user_roles.user_id / approver_assignments.user_id
--     维持 CASCADE（身份与任命随账号一并清除）。
-- 应用层写路径（RPC）仍始终提供创建者，放开 NOT NULL 仅服务删除后置空。

alter table public.questions
  drop constraint questions_creator_id_fkey,
  alter column creator_id drop not null,
  add constraint questions_creator_id_fkey foreign key (creator_id) references auth.users (id) on delete set null;

alter table public.question_versions
  drop constraint question_versions_created_by_fkey,
  alter column created_by drop not null,
  add constraint question_versions_created_by_fkey foreign key (created_by) references auth.users (id) on delete set null;

alter table public.approvals
  drop constraint approvals_assigned_user_id_fkey,
  add constraint approvals_assigned_user_id_fkey foreign key (assigned_user_id) references auth.users (id) on delete set null;

alter table public.approvals
  drop constraint approvals_decided_by_fkey,
  add constraint approvals_decided_by_fkey foreign key (decided_by) references auth.users (id) on delete set null;

alter table public.audit_log
  drop constraint audit_log_user_id_fkey,
  add constraint audit_log_user_id_fkey foreign key (user_id) references auth.users (id) on delete set null;

alter table public.media_objects
  drop constraint media_objects_uploaded_by_fkey,
  alter column uploaded_by drop not null,
  add constraint media_objects_uploaded_by_fkey foreign key (uploaded_by) references auth.users (id) on delete set null;

alter table public.subject_nodes
  drop constraint subject_nodes_created_by_fkey,
  alter column created_by drop not null,
  add constraint subject_nodes_created_by_fkey foreign key (created_by) references auth.users (id) on delete set null;

alter table public.tags
  drop constraint tags_created_by_fkey,
  add constraint tags_created_by_fkey foreign key (created_by) references auth.users (id) on delete set null;

alter table public.approver_assignments
  drop constraint approver_assignments_created_by_fkey,
  alter column created_by drop not null,
  add constraint approver_assignments_created_by_fkey foreign key (created_by) references auth.users (id) on delete set null;

alter table public.user_roles
  drop constraint user_roles_created_by_fkey,
  alter column created_by drop not null,
  add constraint user_roles_created_by_fkey foreign key (created_by) references auth.users (id) on delete set null;
