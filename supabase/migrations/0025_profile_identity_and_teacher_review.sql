-- 0025: 账号身份（学生 / 教师待审核 / 教师）与教师身份审核。
-- 背景：新增刷题客户端后，注册者不再默认都是教师；「教师」涉及出题等写权限（见 0026 断言），须审核把关。
--   · profiles.identity 三态；存量账号（此前只能按教师注册）统一回填 'teacher'，行为不受影响；
--   · 注册触发器按 raw_user_meta_data.identity 判定：显式 'teacher' → teacher_pending，其余 → student；
--   · 审核入口 review_teacher_identity：系统管理员全局、学校管理员限本校；审计 teacher_approve/teacher_reject；
--   · 学生可经 request_teacher_identity 再次申请（需已绑定学校）；
--   · school_contribution_stats 的 teacher_count 改为只统计教师，避免学生绑校污染统计。

alter table public.profiles
  add column if not exists identity text not null default 'student'
    check (identity in ('student', 'teacher_pending', 'teacher'));

comment on column public.profiles.identity is
  '账号身份：student 学生 / teacher_pending 教师待审核 / teacher 教师；仅注册触发器与审核 RPC 可写（客户端无 DML）';

-- 存量账号此前均按教师注册，保持教师身份
update public.profiles set identity = 'teacher' where identity <> 'teacher';

-- 身份助手：仅审核通过的教师（系统管理员视为教师）
create or replace function public.is_teacher()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from profiles p
    where p.user_id = auth.uid() and (p.identity = 'teacher' or p.is_admin)
  );
$$;

-- 注册触发器：增加身份判定（name/school_id 逻辑同 0007）
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1));
  v_school uuid := nullif(new.raw_user_meta_data ->> 'school_id', '')::uuid;
  v_identity text := case
    when new.raw_user_meta_data ->> 'identity' = 'teacher' then 'teacher_pending'
    else 'student'
  end;
  v_is_admin boolean := false;
begin
  if v_school is not null and not exists (select 1 from schools where id = v_school and is_active) then
    v_school := null;
  end if;
  -- 库中尚无任何档案时，本账号即系统管理员（首人引导）
  if not exists (select 1 from profiles) then
    v_is_admin := true;
  end if;
  insert into public.profiles (user_id, name, email, school_id, is_admin, identity)
  values (new.id, v_name, coalesce(new.email, ''), v_school, v_is_admin, v_identity)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- 教师身份审核：通过 → teacher，拒绝 → student（仅待审核状态可审）
create or replace function public.review_teacher_identity(p_user_id uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target profiles%rowtype;
begin
  perform public.require_uid();
  select * into v_target from profiles where user_id = p_user_id;
  if not found then
    raise exception '用户不存在';
  end if;
  if v_target.identity <> 'teacher_pending' then
    raise exception '该用户不处于教师待审核状态';
  end if;
  if not (public.is_admin()
          or (v_target.school_id is not null and public.is_school_admin(v_target.school_id))) then
    raise exception '无权审核该用户的教师身份（仅系统管理员或本校学校管理员）';
  end if;
  update profiles
  set identity = case when p_approve then 'teacher' else 'student' end,
      updated_at = now()
  where user_id = p_user_id;
  perform public.audit(
    case when p_approve then 'teacher_approve' else 'teacher_reject' end,
    null, null,
    jsonb_build_object('user_id', p_user_id, 'school_id', v_target.school_id));
end;
$$;

-- 学生再次申请教师身份（需已绑定学校，便于学校管理员审核）
create or replace function public.request_teacher_identity()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_cur profiles%rowtype;
begin
  select * into v_cur from profiles where user_id = v_uid;
  if not found then
    raise exception '档案不存在';
  end if;
  if v_cur.identity = 'teacher' then
    raise exception '你已是教师，无需申请';
  end if;
  if v_cur.identity = 'teacher_pending' then
    raise exception '教师身份申请已在审核中，请耐心等待';
  end if;
  if v_cur.school_id is null then
    raise exception '请先绑定所属学校后再申请教师身份';
  end if;
  update profiles set identity = 'teacher_pending', updated_at = now() where user_id = v_uid;
  perform public.audit('teacher_apply', null, null, jsonb_build_object('school_id', v_cur.school_id));
end;
$$;

-- 学校贡献统计：教师数只计已审核教师（学生绑校不再计入）
create or replace function public.school_contribution_stats()
returns table(school_id uuid, name text, teacher_count bigint, question_count bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select s.id,
           s.name,
           (select count(*) from profiles p
             where p.school_id = s.id and (p.identity = 'teacher' or p.is_admin)) as teacher_count,
           (select count(*) from questions q where q.school_id = s.id) as question_count
    from schools s
    where s.is_active
    order by s.name;
end;
$$;

revoke execute on function public.is_teacher() from public, anon;
revoke execute on function public.review_teacher_identity(uuid, boolean) from public, anon;
revoke execute on function public.request_teacher_identity() from public, anon;
revoke execute on function public.school_contribution_stats() from public, anon;
grant execute on function public.is_teacher() to authenticated;
grant execute on function public.review_teacher_identity(uuid, boolean) to authenticated;
grant execute on function public.request_teacher_identity() to authenticated;
grant execute on function public.school_contribution_stats() to authenticated;
