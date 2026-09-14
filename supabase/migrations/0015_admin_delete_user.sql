-- 0015: 系统管理员清理用户（探针账号 / 离校账号）。
-- 删除语义（依赖外键级联/置空，先查后删）：
--   · profiles / user_roles / approver_assignments → 随 auth.users 级联删除（身份与任命一并清空）；
--   · approvals.assigned_user_id|decided_by、questions.creator_id、question_versions.created_by、
--     audit_log.user_id、media_objects.uploaded_by 等 → SET NULL：
--     已入库的共享题目不随作者删除（作者显示"已注销"）；在途任务转"待指派"（管理员可转派）；
--     审计留痕与内容时间线保留。
-- 防御：仅系统管理员；不可删除自己；不可删除系统管理员账号。

create or replace function public.admin_delete_user(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_target profiles%rowtype;
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可删除用户';
  end if;
  if p_user_id = v_uid then
    raise exception '不能删除当前登录账号';
  end if;
  select * into v_target from profiles where user_id = p_user_id;
  if not found then
    raise exception '用户不存在';
  end if;
  if v_target.is_admin then
    raise exception '系统管理员账号不可删除';
  end if;

  delete from auth.users where id = p_user_id;
  if not found then
    raise exception '用户不存在（认证记录缺失）';
  end if;

  perform public.audit('admin_delete_user', null, null,
    jsonb_build_object('user_id', p_user_id, 'name', v_target.name, 'email', v_target.email));
end;
$$;

revoke execute on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_delete_user(uuid) to authenticated;
