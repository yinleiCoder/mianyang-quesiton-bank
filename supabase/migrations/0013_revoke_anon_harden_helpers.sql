-- 0013: 安全加固（advisors 复核项）
-- 1) anon 不可执行 SECURITY DEFINER 函数：create_edit_draft 内部有 require_uid() 兜底，
--    is_question_creator / is_school_admin_of_question 用于 RLS 策略（authenticated 路径）。
--    这三个函数此前只有默认的 PUBLIC EXECUTE（anon 经由 PUBLIC 链可达）——从 public 撤销后
--    显式只授予 authenticated，匿名 REST 一律无法调用，策略在登录态下照常求值。
-- 2) helper 函数补显式 search_path，消除角色可变 search_path 告警（不信任 "$user"）。

revoke execute on function public.create_edit_draft(uuid, text, smallint, jsonb, uuid[]) from public;
revoke execute on function public.is_question_creator(uuid) from public;
revoke execute on function public.is_school_admin_of_question(uuid) from public;

grant execute on function public.create_edit_draft(uuid, text, smallint, jsonb, uuid[]) to authenticated;
grant execute on function public.is_question_creator(uuid) to authenticated;
grant execute on function public.is_school_admin_of_question(uuid) to authenticated;

alter function public.can_attach_question(subject_nodes) set search_path = public;
alter function public.v_blank_count(text) set search_path = public;
