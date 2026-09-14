-- 0032: 学生就读信息（年级 / 专业大类 / 专业 / 班级）。
-- 场景：学生注册或在个人资料里录入「24级 计算机类 计算机专业 1班」这类信息，
-- 与所在学校一起构成完整的就读身份；教师账号不使用这些字段（界面只在学生身份下展示）。
--   · profiles 增加 enroll_year / major_category / major / class_name 四列（可空）；
--   · 注册触发器从 raw_user_meta_data 读取（Flutter 注册时随 metadata 提交）；
--   · 单独提供 update_my_enrollment 自助维护——不改 update_own_profile 的签名，
--     避免网页端旧调用（只传姓名/学校/头像）把就读信息清空。

alter table public.profiles
  add column if not exists enroll_year smallint
    check (enroll_year is null or (enroll_year between 2000 and 2100)),
  add column if not exists major_category text,
  add column if not exists major text,
  add column if not exists class_name text;

comment on column public.profiles.enroll_year is '入学年份（2024 → 界面显示 24 级）；学生填写';
comment on column public.profiles.major_category is '专业大类（如 计算机类）；学生填写';
comment on column public.profiles.major is '专业（如 计算机应用）；学生填写';
comment on column public.profiles.class_name is '班级（如 1班）；学生填写';

-- 注册触发器：增加就读信息读取（其余逻辑同 0025）
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
  v_enroll_year smallint := nullif(new.raw_user_meta_data ->> 'enroll_year', '')::smallint;
  v_major_category text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'major_category', '')), '');
  v_major text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'major', '')), '');
  v_class_name text := nullif(trim(coalesce(new.raw_user_meta_data ->> 'class_name', '')), '');
  v_is_admin boolean := false;
begin
  if v_school is not null and not exists (select 1 from schools where id = v_school and is_active) then
    v_school := null;
  end if;
  if v_enroll_year is not null and (v_enroll_year < 2000 or v_enroll_year > 2100) then
    v_enroll_year := null;
  end if;
  -- 库中尚无任何档案时，本账号即系统管理员（首人引导）
  if not exists (select 1 from profiles) then
    v_is_admin := true;
  end if;
  insert into public.profiles (user_id, name, email, school_id, is_admin, identity,
                               enroll_year, major_category, major, class_name)
  values (new.id, v_name, coalesce(new.email, ''), v_school, v_is_admin, v_identity,
          v_enroll_year, v_major_category, v_major, v_class_name)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- 自助维护就读信息（学生端「就读信息」表单）
create or replace function public.update_my_enrollment(
  p_enroll_year int default null,
  p_major_category text default null,
  p_major text default null,
  p_class_name text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if p_enroll_year is not null and (p_enroll_year < 2000 or p_enroll_year > 2100) then
    raise exception '入学年份需在 2000~2100 之间';
  end if;
  if length(coalesce(p_major_category, '')) > 40
     or length(coalesce(p_major, '')) > 40
     or length(coalesce(p_class_name, '')) > 20 then
    raise exception '就读信息过长（专业大类/专业 ≤40 字，班级 ≤20 字）';
  end if;

  update profiles
  set enroll_year = p_enroll_year::smallint,
      major_category = nullif(trim(coalesce(p_major_category, '')), ''),
      major = nullif(trim(coalesce(p_major, '')), ''),
      class_name = nullif(trim(coalesce(p_class_name, '')), ''),
      updated_at = now()
  where user_id = v_uid;
end;
$$;

revoke execute on function public.update_my_enrollment(int, text, text, text) from public, anon;
grant execute on function public.update_my_enrollment(int, text, text, text) to authenticated;
