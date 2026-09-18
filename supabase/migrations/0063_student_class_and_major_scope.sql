-- 0063: 班级实体 + 学生名册与学情（教师端）+ 教师专业管辖。
--
-- 现象：
--   1) 学生的「班级」只有一个 ≤20 字的自由文本 profiles.class_name（0032），学校排班情况无从维护，
--      「以班级为单位」这件事在库里没有任何抓手；
--   2) 学生的就读信息只活在 Flutter 端，网页端一行都不显示；
--   3) 学生在 Flutter 端做的每一道题都写进 practice_answers，但那四张表是**仅本人可读**的 RLS，
--      网页端从教师到管理员，看不到任何一名学生的练习情况；
--   4) 学生和教师混在 /admin/users 一张表里，而那一页的每个动作都面向教师 —— 0059 只好在三个
--      任命 RPC 里硬加 identity='student' 断言把学生挡掉。
--
-- 动机：班级必须是实体（学校 × 专业节点 × 名称），学籍（专业大类/专业）由它派生；
--       教师的「任教专业」落在 profiles.major_node_id，据此限定其可见的学生范围。
--
-- 取舍（重要，改之前先读）：
--   · profiles 的 enroll_year / major_category / major / class_name **四列保留不删**，降级为
--     **显示镜像** —— 存量 Flutter 客户端（尚未升级的那批）仍在读写它们，删了就破。
--     规则定死：**class_id 是权威，class_name 是镜像**，任何写 class_id 的路径都要同步刷新镜像。
--   · update_my_enrollment 的签名与语义**一行不改**：不改签名就不用 drop function，也就不会连带
--     丢掉 grant；更要紧的是旧 App 只会写自由文本、**不碰 class_id**，比让它冲掉管理员的分配安全得多。
--     新客户端走本迁移新增的 update_my_study_info。
--   · 学情读路径全部走 SECURITY DEFINER RPC，**practice_* 四表与 exam_* 的 RLS 一行不动**
--     （理由见下面 my_student_detail 上方的四条论证）。

-- =====================================================================
-- 1) 班级表
-- =====================================================================
create table if not exists public.classes (
  id            uuid primary key default gen_random_uuid(),
  school_id     uuid not null references public.schools(id) on delete cascade,
  -- 允许指向 专业大类(category) 或 专业(major)：现实中确有「24级计算机类1班」这种不分具体专业的班；
  -- 而且教师按大类设专业时，这一条让它能覆盖到大类下的全部班级。
  major_node_id uuid not null references public.subject_nodes(id) on delete restrict,
  name          text not null check (length(btrim(name)) between 1 and 30),
  -- 入学年份挂在班级上（「24 级」是班属性，不是人属性），学生的 enroll_year 由它派生
  enroll_year   smallint check (enroll_year is null or enroll_year between 2000 and 2100),
  is_active     boolean not null default true,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
comment on table public.classes is '班级：学校 × 专业节点 × 名称。学生的专业大类/专业由它派生';
comment on column public.classes.major_node_id is '所属专业节点（subject_nodes 的 category 或 major）';

-- 部分唯一索引：停用「23数控1班」之后必须还能新建同名班级
create unique index if not exists uq_classes_school_name
  on public.classes (school_id, lower(btrim(name))) where is_active;
create index if not exists idx_classes_school on public.classes (school_id, name);

drop trigger if exists trg_classes_touch on public.classes;
create trigger trg_classes_touch before update on public.classes
  for each row execute function public.touch_updated_at();

-- 班级的专业节点必须是专业目录里的 大类/专业，且未被冻结
create or replace function public.validate_class()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind  subject_kind;
  v_scope subject_scope;
  v_frozen boolean;
begin
  select kind, scope, is_frozen into v_kind, v_scope, v_frozen
  from subject_nodes where id = new.major_node_id;
  if not found then
    raise exception '专业节点不存在';
  end if;
  if v_scope <> 'vocational' or v_kind not in ('category', 'major') then
    raise exception '班级必须挂在专业大类或专业节点上';
  end if;
  if v_frozen then
    raise exception '该专业节点已冻结，不能再建班';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_classes_validate on public.classes;
create trigger trg_classes_validate
  before insert or update of major_node_id on public.classes
  for each row execute function public.validate_class();

-- =====================================================================
-- 2) profiles 增列
-- =====================================================================
alter table public.profiles
  add column if not exists major_node_id uuid references public.subject_nodes(id) on delete set null,
  add column if not exists class_id      uuid references public.classes(id) on delete set null;

comment on column public.profiles.class_id is
  '所属班级（权威字段）。class_name 降级为它的显示镜像 —— 旧客户端只写文本、不写本列（0063 头注）';
comment on column public.profiles.major_node_id is
  '所属专业节点。学生：由班级派生；教师：任教专业，由学校管理员设置，可指 category（管该大类下全部专业）或 major';

-- FK 不会自动建索引
create index if not exists idx_profiles_class on public.profiles (class_id);
create index if not exists idx_profiles_major_node on public.profiles (major_node_id);

-- 一致性收口：班级不属于本人学校时（换校、班级被删）**静默**把 class_id 置空。
-- 用触发器而不是去改 admin_set_user_school / update_own_profile：那样等于把同一条不变量复制到多个函数里。
-- 不 raise：raise 会让「换校」这个正常操作直接卡死。旧的文本列保留，只是不再是权威。
create or replace function public.guard_profile_class()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_school uuid;
begin
  if new.class_id is not null then
    select school_id into v_school from classes where id = new.class_id;
    if v_school is null or v_school is distinct from new.school_id then
      new.class_id := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_profile_class on public.profiles;
create trigger trg_guard_profile_class
  before insert or update on public.profiles
  for each row execute function public.guard_profile_class();

-- =====================================================================
-- 3) 权限助手
-- =====================================================================
-- 节点及其全部后代（含自身）。口径同 lib/subject-nodes.js 的 subtreeIdsOf。
-- 返回 table(id) 而不是 setof uuid：后者的列名会取**函数名**，
-- 调用点写 `select id from major_subtree_ids(...)` 会报 42703 column "id" does not exist。
-- 函数体内一律用 node_id 并逐列限定：OUT 参数也叫 id，再让 CTE 也用 id 会留下歧义的口子。
create or replace function public.major_subtree_ids(p_node_id uuid)
returns table(id uuid)
language sql
stable
security definer
set search_path = public
as $$
  with recursive t(node_id) as (
    select sn.id from subject_nodes sn where sn.id = p_node_id
    union all
    select sn.id from subject_nodes sn join t on sn.parent_id = t.node_id
  )
  select t.node_id from t;
$$;

-- 调用者能否查看某个学生的学情。这是本功能**唯一的安全边界**。
--   系统管理员 → 全部；学校管理员 → 本校；教师 → 同校 且 学生专业落在我的专业子树内。
-- is_teacher()（0025）天然排除 teacher_pending，正合「审核岗位面向教师」的口径。
-- 教师未设 major_node_id 时 s.major_node_id in (null 子集) 恒为 null → false，即什么都看不到
--（页面必须为此给明确提示，否则会被当成故障）。
create or replace function public.can_view_student(p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from profiles s
    where s.user_id = p_student_id
      and s.identity = 'student'
      and (
        public.is_admin()
        or public.is_school_admin(s.school_id)
        or (
          public.is_teacher()
          and s.school_id is not distinct from
              (select me.school_id from profiles me where me.user_id = (select auth.uid()))
          and s.major_node_id in (
            select id from public.major_subtree_ids(
              (select me.major_node_id from profiles me where me.user_id = (select auth.uid()))
            )
          )
        )
      )
  );
$$;

-- 班级可见性：能看班里任意一个学生就能看这个班的概览。走同一套判断，不另开分支。
create or replace function public.can_view_class(p_class_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from classes c
    where c.id = p_class_id
      and (
        public.is_admin()
        or public.is_school_admin(c.school_id)
        or (
          public.is_teacher()
          and c.school_id is not distinct from
              (select me.school_id from profiles me where me.user_id = (select auth.uid()))
          and c.major_node_id in (
            select id from public.major_subtree_ids(
              (select me.major_node_id from profiles me where me.user_id = (select auth.uid()))
            )
          )
        )
      )
  );
$$;

-- 这两个助手接受任意 uid/班级 id，**只允许被其它 definer 函数内部调用**，不对外开户。
-- 将来若有「顺手给前端用」的改动，必须重新论证（口径同 0041 头注那句「不要给本函数加参数」）。
revoke execute on function public.major_subtree_ids(uuid) from public, anon, authenticated;
revoke execute on function public.can_view_student(uuid) from public, anon, authenticated;
revoke execute on function public.can_view_class(uuid) from public, anon, authenticated;

-- =====================================================================
-- 4) RLS / 授权：classes
-- =====================================================================
-- 班级名单是学校排课的公开元数据（不含个人信息），且**注册页在登录前就要选班级**，
-- 所以照 0039/0040 的先例对 anon 只读。写一律走下面的 definer RPC。
alter table public.classes enable row level security;

drop policy if exists select_any_auth on public.classes;
create policy select_any_auth on public.classes for select to authenticated using (true);

drop policy if exists select_anon_classes on public.classes;
create policy select_anon_classes on public.classes for select to anon using (true);

revoke all on public.classes from anon, authenticated;
grant select on public.classes to anon, authenticated;

-- =====================================================================
-- 5) 班级 / 学籍管理 RPC
-- =====================================================================
-- 统一授权口径：系统管理员 = 任意学校；学校管理员 = 该校（is_school_admin）。

-- 班级 → 学籍镜像的派生（admin_update_student / update_my_study_info / handle_new_user 共用同一口径）。
-- 内联进各函数而不是抽成函数：只有三处，且都紧挨着 UPDATE 语句，抽出去反而看不清写入了什么。

-- 建班
create or replace function public.admin_create_class(
  p_school_id uuid, p_major_node_id uuid, p_name text, p_enroll_year int default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  if not (public.is_admin() or public.is_school_admin(p_school_id)) then
    raise exception '仅该校学校管理员可建立班级';
  end if;
  if length(v_name) < 1 or length(v_name) > 30 then
    raise exception '班级名称需在 1~30 字之间';
  end if;
  if p_enroll_year is not null and (p_enroll_year < 2000 or p_enroll_year > 2100) then
    raise exception '入学年份需在 2000~2100 之间';
  end if;
  if not exists (select 1 from schools where id = p_school_id and is_active) then
    raise exception '学校不存在或已停用';
  end if;
  begin
    insert into classes (school_id, major_node_id, name, enroll_year, created_by)
    values (p_school_id, p_major_node_id, v_name, p_enroll_year::smallint, v_uid)
    returning id into v_id;
  exception when unique_violation then
    raise exception '该校已有同名班级';
  end;
  perform public.audit('admin_create_class', null, null,
    jsonb_build_object('class_id', v_id, 'school_id', p_school_id,
                       'major_node_id', p_major_node_id, 'name', v_name,
                       'enroll_year', p_enroll_year));
  return v_id;
end;
$$;

-- 改班级：名称 / 入学年份 / 所属专业，三项都可改。
-- 专业允许改：建班时选错专业是常有的事，不给改就只能弃用重建、全班学生跟着受牵连。
-- 改了专业就把**全班学生的镜像一起重刷** —— 否则学生档案上的专业会和班级对不上，
-- 而学生侧早已不再手选专业，没有任何地方能自愈。
create or replace function public.admin_update_class(
  p_class_id uuid, p_name text, p_enroll_year int, p_major_node_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_school uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_cat text;
  v_major text;
begin
  perform public.require_uid();
  select school_id into v_school from classes where id = p_class_id;
  if not found then
    raise exception '班级不存在';
  end if;
  if not (public.is_admin() or public.is_school_admin(v_school)) then
    raise exception '仅该校学校管理员可修改班级';
  end if;
  if length(v_name) < 1 or length(v_name) > 30 then
    raise exception '班级名称需在 1~30 字之间';
  end if;
  if p_enroll_year is not null and (p_enroll_year < 2000 or p_enroll_year > 2100) then
    raise exception '入学年份需在 2000~2100 之间';
  end if;

  -- 节点合法性交给 trg_classes_validate 断言，这里只取名称镜像
  select case when n.kind = 'category' then n.name else pn.name end,
         case when n.kind = 'major'    then n.name else null   end
    into v_cat, v_major
  from subject_nodes n
  left join subject_nodes pn on pn.id = n.parent_id
  where n.id = p_major_node_id;
  if not found then
    raise exception '专业节点不存在';
  end if;

  begin
    update classes
    set name = v_name, enroll_year = p_enroll_year::smallint,
        major_node_id = p_major_node_id, updated_at = now()
    where id = p_class_id;
  exception when unique_violation then
    raise exception '该校已有同名班级';
  end;

  -- class_name / major_category / major 都是显示镜像，班级一变就得整班重刷
  update profiles
  set class_name = v_name, major_category = v_cat, major = v_major,
      major_node_id = p_major_node_id, enroll_year = p_enroll_year::smallint,
      updated_at = now()
  where class_id = p_class_id;

  perform public.audit('admin_update_class', null, null,
    jsonb_build_object('class_id', p_class_id, 'name', v_name,
                       'enroll_year', p_enroll_year, 'major_node_id', p_major_node_id));
end;
$$;

-- 启用/停用。停用**不清空学生**：名册上标注「班级已停用」，学生仍可被查看与改派。
create or replace function public.admin_set_class_active(p_class_id uuid, p_is_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_school uuid;
begin
  perform public.require_uid();
  select school_id into v_school from classes where id = p_class_id;
  if not found then
    raise exception '班级不存在';
  end if;
  if not (public.is_admin() or public.is_school_admin(v_school)) then
    raise exception '仅该校学校管理员可修改班级';
  end if;
  update classes set is_active = p_is_active, updated_at = now() where id = p_class_id;
  perform public.audit('admin_set_class_active', null, null,
    jsonb_build_object('class_id', p_class_id, 'is_active', p_is_active));
end;
$$;

-- 批量归班。逐个断言：目标须是学生、且与班级同校。
create or replace function public.admin_bulk_assign_class(p_user_ids uuid[], p_class_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_school uuid;
  v_node uuid;
  v_cat text;
  v_major text;
  v_cname text;
  v_uid uuid := public.require_uid();
  v_bad int;
  v_n int;
begin
  if p_user_ids is null or coalesce(array_length(p_user_ids, 1), 0) = 0 then
    return 0;
  end if;
  select c.school_id, c.major_node_id,
         case when n.kind = 'category' then n.name else pn.name end,
         case when n.kind = 'major'    then n.name else null end,
         c.name
    into v_school, v_node, v_cat, v_major, v_cname
  from classes c
  join subject_nodes n on n.id = c.major_node_id
  left join subject_nodes pn on pn.id = n.parent_id
  where c.id = p_class_id;
  if not found then
    raise exception '班级不存在';
  end if;
  if not (public.is_admin() or public.is_school_admin(v_school)) then
    raise exception '仅该校学校管理员可分配班级';
  end if;

  -- 先校验再写：一次报清楚有几个不合格，不要写一半留一半
  select count(*) into v_bad
  from unnest(p_user_ids) as u(id)
  left join profiles p on p.user_id = u.id
  where p.user_id is null or p.identity <> 'student' or p.school_id is distinct from v_school;
  if v_bad > 0 then
    raise exception '有 % 个账号不是本校学生，未做任何改动', v_bad;
  end if;

  update profiles p
  set class_id      = p_class_id,
      major_node_id = v_node,
      major_category = v_cat,
      major          = v_major,
      class_name     = v_cname,
      updated_at     = now()
  where p.user_id = any(p_user_ids);
  get diagnostics v_n = row_count;

  perform public.audit('admin_bulk_assign_class', null, null,
    jsonb_build_object('class_id', p_class_id, 'count', v_n, 'by', v_uid));
  return v_n;
end;
$$;

-- 单个学生：改入学年份 + 班级（p_class_id 传 null = 取消分班）
create or replace function public.admin_update_student(
  p_user_id uuid, p_enroll_year int, p_class_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target profiles%rowtype;
  v_school uuid;
  v_node uuid;
  v_cat text;
  v_major text;
  v_cname text;
begin
  perform public.require_uid();
  select * into v_target from profiles where user_id = p_user_id;
  if not found then
    raise exception '学生不存在';
  end if;
  if v_target.identity <> 'student' then
    raise exception '该账号不是学生';
  end if;
  if not (public.is_admin() or public.is_school_admin(v_target.school_id)) then
    raise exception '仅该校学校管理员可修改学生学籍';
  end if;
  if p_enroll_year is not null and (p_enroll_year < 2000 or p_enroll_year > 2100) then
    raise exception '入学年份需在 2000~2100 之间';
  end if;

  if p_class_id is null then
    update profiles
    set enroll_year = p_enroll_year::smallint,
        class_id = null, major_node_id = null,
        major_category = null, major = null, class_name = null,
        updated_at = now()
    where user_id = p_user_id;
  else
    select c.school_id, c.major_node_id,
           case when n.kind = 'category' then n.name else pn.name end,
           case when n.kind = 'major'    then n.name else null end,
           c.name
      into v_school, v_node, v_cat, v_major, v_cname
    from classes c
    join subject_nodes n on n.id = c.major_node_id
    left join subject_nodes pn on pn.id = n.parent_id
    where c.id = p_class_id;
    if not found then
      raise exception '班级不存在';
    end if;
    if v_school is distinct from v_target.school_id then
      raise exception '该班级不属于学生所在的学校';
    end if;
    update profiles
    set enroll_year = p_enroll_year::smallint,
        class_id = p_class_id, major_node_id = v_node,
        major_category = v_cat, major = v_major, class_name = v_cname,
        updated_at = now()
    where user_id = p_user_id;
  end if;

  perform public.audit('admin_update_student', null, null,
    jsonb_build_object('user_id', p_user_id, 'class_id', p_class_id, 'enroll_year', p_enroll_year));
end;
$$;

-- 教师的任教专业（决定他能看到哪些学生）。传 null 清除。
create or replace function public.admin_set_teacher_major(p_user_id uuid, p_major_node_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target profiles%rowtype;
  v_kind subject_kind;
  v_scope subject_scope;
  v_cat text;
  v_major text;
begin
  perform public.require_uid();
  select * into v_target from profiles where user_id = p_user_id;
  if not found then
    raise exception '用户不存在';
  end if;
  if v_target.identity not in ('teacher', 'teacher_pending') then
    raise exception '只能给教师设置任教专业';
  end if;
  if not (public.is_admin() or public.is_school_admin(v_target.school_id)) then
    raise exception '仅该校学校管理员可设置任教专业';
  end if;

  if p_major_node_id is null then
    update profiles set major_node_id = null, major_category = null, major = null, updated_at = now()
    where user_id = p_user_id;
  else
    select n.kind, n.scope,
           case when n.kind = 'category' then n.name else pn.name end,
           case when n.kind = 'major'    then n.name else null   end
      into v_kind, v_scope, v_cat, v_major
    from subject_nodes n
    left join subject_nodes pn on pn.id = n.parent_id
    where n.id = p_major_node_id;
    if not found then
      raise exception '专业节点不存在';
    end if;
    if v_scope <> 'vocational' or v_kind not in ('category', 'major') then
      raise exception '任教专业只能选专业大类或专业';
    end if;
    update profiles
    set major_node_id = p_major_node_id, major_category = v_cat, major = v_major, updated_at = now()
    where user_id = p_user_id;
  end if;

  perform public.audit('admin_set_teacher_major', null, null,
    jsonb_build_object('user_id', p_user_id, 'major_node_id', p_major_node_id));
end;
$$;

-- =====================================================================
-- 6) 学生本人的自助维护
-- =====================================================================
-- 新契约：入学年份 + 班级（专业由班级派生）。p_class_id 传 null = 主动清空班级。
-- 注意 update_my_enrollment（0032）**保持不动**，旧客户端继续走它。
create or replace function public.update_my_study_info(
  p_enroll_year int default null, p_class_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_school uuid;
  v_node uuid;
  v_cat text;
  v_major text;
  v_cname text;
begin
  if p_enroll_year is not null and (p_enroll_year < 2000 or p_enroll_year > 2100) then
    raise exception '入学年份需在 2000~2100 之间';
  end if;

  -- 清空班级（或只想改入学年份）不需要绑校 —— 那是"退出"，不是"加入"。
  -- 绑校检查只在真的选一个班时才做，否则未绑校的学生连改个入学年份都会失败。
  if p_class_id is null then
    update profiles
    set enroll_year = p_enroll_year::smallint,
        class_id = null, major_node_id = null,
        major_category = null, major = null, class_name = null,
        updated_at = now()
    where user_id = v_uid;
    return;
  end if;

  select school_id into v_school from profiles where user_id = v_uid;
  if v_school is null then
    raise exception '请先绑定所属学校后再选择班级';
  end if;

  select c.major_node_id,
         case when n.kind = 'category' then n.name else pn.name end,
         case when n.kind = 'major'    then n.name else null end,
         c.name
    into v_node, v_cat, v_major, v_cname
  from classes c
  join subject_nodes n on n.id = c.major_node_id
  left join subject_nodes pn on pn.id = n.parent_id
  where c.id = p_class_id and c.is_active and c.school_id = v_school;
  if not found then
    raise exception '该班级不属于你所在的学校，或已停用';
  end if;

  update profiles
  set enroll_year = p_enroll_year::smallint,
      class_id = p_class_id, major_node_id = v_node,
      major_category = v_cat, major = v_major, class_name = v_cname,
      updated_at = now()
  where user_id = v_uid;
end;
$$;

-- =====================================================================
-- 7) 注册触发器：加 class_id 读取（旧键一个都不动）
-- =====================================================================
-- 关键：**绝不能因为一个过期 class_id 而失败** —— 那是 signUp 直接报错。
-- 班级不存在 / 已停用 / 不属于所选学校，一律静默丢弃，退化成「未分班」。
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
  v_class_id uuid := nullif(new.raw_user_meta_data ->> 'class_id', '')::uuid;
  v_node uuid;
  v_cat text;
  v_cm text;
  v_cname text;
  v_is_admin boolean := false;
begin
  if v_school is not null and not exists (select 1 from schools where id = v_school and is_active) then
    v_school := null;
  end if;
  if v_enroll_year is not null and (v_enroll_year < 2000 or v_enroll_year > 2100) then
    v_enroll_year := null;
  end if;

  -- 班级优先：命中则由班级派生专业与班级名，忽略随包提交的自由文本（避免两个真相源打架）
  if v_class_id is not null then
    select c.major_node_id,
           case when n.kind = 'category' then n.name else pn.name end,
           case when n.kind = 'major'    then n.name else null end,
           c.name
      into v_node, v_cat, v_cm, v_cname
    from classes c
    join subject_nodes n on n.id = c.major_node_id
    left join subject_nodes pn on pn.id = n.parent_id
    where c.id = v_class_id and c.is_active and c.school_id = v_school;
    if not found then
      v_class_id := null;
    else
      v_major_category := v_cat;
      v_major := v_cm;
      v_class_name := v_cname;
    end if;
  end if;

  -- 库中尚无任何档案时，本账号即系统管理员（首人引导）
  if not exists (select 1 from profiles) then
    v_is_admin := true;
  end if;
  insert into public.profiles (user_id, name, email, school_id, is_admin, identity,
                               enroll_year, major_category, major, class_name,
                               major_node_id, class_id)
  values (new.id, v_name, coalesce(new.email, ''), v_school, v_is_admin, v_identity,
          v_enroll_year, v_major_category, v_major, v_class_name,
          case when v_class_id is not null then v_node end, v_class_id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

-- =====================================================================
-- 8) 回填（只回填专业节点，**不自动建班**）
-- =====================================================================
-- 为什么不自动建班：线上 40 名学生的 class_name 是自由文本，同一个真实的班被写成了
--   「24级计算机2班」(12人) /「24计算机2班」(10人) /「24级计算机二班」(3) /「24计2」(4) /
--   「24计二」(1) /「24级计2」(2) /「24机计算机2班」(1) /「24级\r\r计2」(1)
-- 八种写法（还有 3 人没填）。按名字去重建班只会把这个乱象**固化成 8 个班** —— 那正是本迁移要治的病。
-- 所以：班级表建空，让学校管理员在 /admin/classes 里建一个「24级计算机2班」，再用
-- /students?unassigned=1 的批量归班一次收编。下面的 notice 会把待办清单打出来。
--
-- 专业节点则照填不误：专业大类/专业在树里是同级唯一（uq_subject_nodes_sibling_name），
-- 「名字对得上」即唯一解，对不上的一律不猜（留 null）。
do $$
declare
  v_linked int;
  v_teachers int;
  r record;
begin
  -- 先把「谁该填哪个节点」算成一张派生表再更新，而不是 update ... from ... left join：
  -- UPDATE 的目标表**不能**出现在 FROM 里那个 LEFT JOIN 的 ON 条件中
  --（42P01 invalid reference to FROM-clause entry），放进派生表就没这个限制。
  update public.profiles p
  set major_node_id = m.node_id
  from (
    select p2.user_id as uid, coalesce(maj.id, cat.id) as node_id
    from profiles p2
    join subject_nodes cat
      on cat.scope = 'vocational' and cat.kind = 'category'
     and lower(cat.name) = lower(btrim(coalesce(p2.major_category, '')))
    left join subject_nodes maj
      on maj.parent_id = cat.id and maj.kind = 'major'
     and lower(maj.name) = lower(btrim(coalesce(p2.major, '')))
    where p2.identity = 'student' and p2.major_node_id is null
  ) m
  where p.user_id = m.uid;
  get diagnostics v_linked = row_count;

  -- 教师侧不回填：存量教师本来就没有专业，由学校管理员在「本校用户与任命」里逐个指定。
  select count(*) into v_teachers from profiles where identity in ('teacher', 'teacher_pending');
  raise notice '0063 回填：学生专业节点 % 人已填；教师 % 人待学校管理员指定任教专业',
    v_linked, v_teachers;

  for r in
    select s.name as school, btrim(p.class_name) as cname, count(*) as n
    from profiles p
    join schools s on s.id = p.school_id
    where p.identity = 'student' and p.class_id is null
      and p.class_name is not null and btrim(p.class_name) <> ''
    group by 1, 2
    order by 3 desc
  loop
    raise notice '0063 待人工建班（同一真实的班可能有多行，注意归并）：% / % （% 人）',
      r.school, replace(r.cname, E'\r', '\r'), r.n;
  end loop;
end $$;

-- =====================================================================
-- 9) 教师端学情读 RPC
-- =====================================================================
-- 学生名册。权限靠 can_view_student 逐行过滤 —— 一个谓词同时覆盖三种角色，不写三份 WHERE。
create or replace function public.list_my_students(
  p_class_id uuid default null,
  p_only_unassigned boolean default false,
  p_keyword text default null,
  p_limit int default 100,
  p_offset int default 0)
returns table(
  user_id uuid,
  name text,
  email text,
  avatar_url text,
  school_id uuid,
  class_id uuid,
  class_name text,
  class_is_active boolean,
  enroll_year smallint,
  major_category text,
  major text,
  session_count bigint,
  answered_count bigint,
  correct_count bigint,
  graded_count bigint,
  last_practiced_at timestamptz,
  total_count bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_kw text := nullif(btrim(coalesce(p_keyword, '')), '');
begin
  perform public.require_uid();
  -- 注意：plpgsql 的 OUT 参数名与列名同名，**下面所有列引用都必须带表别名**，
  -- 否则会静默取到 OUT 参数（NULL）而不是表里的列。
  return query
  with page as materialized (
    select pr.user_id as uid, pr.name as pname, pr.email as pemail, pr.avatar_url as pavatar,
           pr.school_id as pschool, pr.class_id as pclass,
           coalesce(c.name, pr.class_name) as cname,
           c.is_active as cactive,
           pr.enroll_year as pyear, pr.major_category as pcat, pr.major as pmajor,
           count(*) over () as tcount
    from profiles pr
    left join classes c on c.id = pr.class_id
    where pr.identity = 'student'
      and public.can_view_student(pr.user_id)
      and (case when p_only_unassigned then pr.class_id is null
                when p_class_id is not null then pr.class_id = p_class_id
                else true end)
      and (v_kw is null
           or pr.name ilike '%' || v_kw || '%'
           or pr.email ilike '%' || v_kw || '%')
    order by pr.name nulls last, pr.user_id
    limit v_limit offset v_offset
  )
  -- materialized 不能省：否则 LIMIT 会在下面两个 lateral 聚合**之后**才生效，
  -- 变成先聚合全校学生再丢掉 90%。
  select g.uid, g.pname, g.pemail, g.pavatar, g.pschool, g.pclass, g.cname, g.cactive,
         g.pyear, g.pcat, g.pmajor,
         coalesce(s.scount, 0), coalesce(a.acount, 0), coalesce(a.ccount, 0), coalesce(a.gcount, 0),
         greatest(s.slast, a.alast), g.tcount
  from page g
  left join lateral (
    select count(*) as scount, max(ps.started_at) as slast
    from practice_sessions ps
    where ps.user_id = g.uid and ps.status <> 'abandoned'
  ) s on true
  left join lateral (
    -- graded_count 只数客观题（grading='auto'）—— 与 question_accuracy 同口径。
    -- 正确率必须用它当分母：主观自评题的 is_correct 恒为 null，混进去会把正确率压低。
    select count(*) as acount,
           count(*) filter (where pa.is_correct) as ccount,
           count(*) filter (where pa.grading = 'auto') as gcount,
           max(pa.answered_at) as alast
    from practice_answers pa
    where pa.user_id = g.uid
  ) a on true
  order by g.pname nulls last, g.uid;
end;
$$;

-- 班级下拉 + 班级概览（同一趟取回，省一次往返）：人数 / 汇总正确率 / 最近练习。
-- 「未分班」不在这里造虚拟行 —— 它是 p_only_unassigned 的语义，由前端用一个独立入口表达，
-- 免得把一个假 uuid 混进班级列表里到处传播。
create or replace function public.list_my_student_classes()
returns table(
  class_id uuid, class_name text, is_active boolean, enroll_year smallint,
  school_id uuid, major_node_id uuid, student_count bigint,
  answered_count bigint, correct_count bigint, graded_count bigint,
  last_practiced_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select c.id, c.name, c.is_active, c.enroll_year, c.school_id, c.major_node_id,
         (select count(*) from profiles p
           where p.class_id = c.id and p.identity = 'student'
             and public.can_view_student(p.user_id)),
         coalesce(agg.acount, 0), coalesce(agg.ccount, 0), coalesce(agg.gcount, 0), agg.alast
  from classes c
  left join lateral (
    -- 逐人取一次，与名册页同一口径（graded_count 只数客观题，正确率的分母用它）。
    -- 班级规模是几十人量级，比在 SQL 里再写一层派生表更清楚。
    select count(*) as acount,
           count(*) filter (where pa.is_correct) as ccount,
           count(*) filter (where pa.grading = 'auto') as gcount,
           max(pa.answered_at) as alast
    from profiles p
    join practice_answers pa on pa.user_id = p.user_id
    where p.class_id = c.id and p.identity = 'student'
      and public.can_view_student(p.user_id)
  ) agg on true
  where public.can_view_class(c.id)
  order by c.is_active desc, c.enroll_year desc nulls last, c.name;
$$;

-- 单个学生的完整学情。一次取全（口径同 0031 的 practice_dashboard），避免页面打七八次往返。
--
-- 考试为什么走这个 RPC，而不是给 exam_attempts 加一条 RLS 策略：
--   ① exam_answers 的策略是「attempt 可见则答案可见」。给 exam_attempts 加
--      `or can_view_student(user_id)` 等于**同时**把主观题作答原文、参考答案对照、教师批注开给
--      同校同专业的任何教师 —— 要的是成绩，开出去的是答卷。
--   ② 策略一旦加上就作用于所有未来查询路径（任何 PostgREST embed、任何客户端、含 Flutter），
--      审计面无限大；definer RPC 只暴露函数返回的那几个字段。
--   ③ is_paper_grader 的语义是 0051 刻意收窄的，往里塞第二个 or 分支会悄悄改写它，
--      阅卷台的授权推理随之失效。
--   ④ 失败模式不对称：RPC 写错 = 教师看不到；策略写松 = 教师看到别人的答卷。
create or replace function public.my_student_detail(p_student_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_s profiles%rowtype;
  v_sessions jsonb;
  v_wrong jsonb;
  v_nodes jsonb;
  v_exams jsonb;
begin
  perform public.require_uid();
  if not public.can_view_student(p_student_id) then
    raise exception '你只能查看本校且专业匹配的学生' using errcode = '42501';
  end if;

  select * into v_s from profiles where user_id = p_student_id;
  if not found then
    raise exception '学生不存在';
  end if;

  -- 练习历史（近 30 次）
  select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc), '[]'::jsonb) into v_sessions
  from (
    select ps.id, ps.source, ps.subject_node_id, ps.total_count, ps.answered_count,
           ps.correct_count, ps.status, ps.started_at, ps.submitted_at, ps.duration_ms
    from practice_sessions ps
    where ps.user_id = p_student_id and ps.status <> 'abandoned'
    order by ps.started_at desc
    limit 30
  ) x;

  -- 错题：最近一次作答为错的题（口径照抄 0029 list_my_wrong_questions，只把 v_uid 换成学生）
  select coalesce(jsonb_agg(to_jsonb(x) order by x.answered_at desc), '[]'::jsonb) into v_wrong
  from (
    select l.question_id,
           coalesce(cv.id, l.version_id) as version_id,
           coalesce(cv.qtype, lv.qtype) as qtype,
           coalesce(cv.difficulty, lv.difficulty) as difficulty,
           l.answered_at,
           (select count(*) from practice_answers a
             where a.user_id = p_student_id and a.question_id = l.question_id
               and a.is_correct is not true) as wrong_count,
           case when cv.id is not null then left(coalesce(cv.search_text, ''), 120) end as stem_text,
           (cv.id is not null) as available
    from (
      select distinct on (a.question_id) a.question_id, a.version_id, a.is_correct, a.answered_at
      from practice_answers a
      where a.user_id = p_student_id
      order by a.question_id, a.answered_at desc
    ) l
    join question_versions lv on lv.id = l.version_id
    left join questions q on q.id = l.question_id
      and q.state = 'live' and q.current_published_version_id is not null
    left join question_versions cv on cv.id = q.current_published_version_id and cv.status = 'published'
    where l.is_correct is not true
    order by l.answered_at desc
    limit 50
  ) x;

  -- 按科目节点的正确率（课程级；上卷到专业/大类交给前端 subtreeIdsOf）
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_nodes
  from (
    select q.course_node_id as node_id,
           count(*) as attempts,
           count(*) filter (where pa.is_correct) as correct
    from practice_answers pa
    join questions q on q.id = pa.question_id
    where pa.user_id = p_student_id and pa.grading = 'auto'
    group by q.course_node_id
  ) x;

  -- 组卷考试：**只出成绩摘要，不出作答内容**（见上方注释）
  select coalesce(jsonb_agg(to_jsonb(x) order by x.sort_key desc), '[]'::jsonb) into v_exams
  from (
    select a.id, pv.title as paper_title, a.status, a.total_score, a.full_score,
           a.objective_score, a.subjective_score, a.submitted_at, a.graded_at,
           a.pending_review_count, a.duration_ms,
           coalesce(a.submitted_at, a.started_at) as sort_key
    from exam_attempts a
    join paper_versions pv on pv.id = a.paper_version_id
    where a.user_id = p_student_id
      and a.status in ('submitted', 'grading', 'graded')
    order by sort_key desc
    limit 30
  ) x;

  return jsonb_build_object(
    'student', jsonb_build_object(
      'user_id', v_s.user_id, 'name', v_s.name, 'email', v_s.email,
      'avatar_url', v_s.avatar_url, 'school_id', v_s.school_id,
      'class_id', v_s.class_id, 'class_name', v_s.class_name,
      'enroll_year', v_s.enroll_year, 'major_category', v_s.major_category,
      'major', v_s.major, 'major_node_id', v_s.major_node_id,
      'created_at', v_s.created_at),
    'sessions', v_sessions,
    'wrong_questions', v_wrong,
    'node_accuracy', v_nodes,
    'exams', v_exams);
end;
$$;

-- =====================================================================
-- 10) 授权收口
-- =====================================================================
-- 触发器函数不在这里 revoke：PostgreSQL 只在 CREATE TRIGGER 时校验 EXECUTE，触发时不校验，
-- 收回授权毫无收益，反而给后人留一个"是不是漏了什么"的疑问。真正的权限收口在下面的 RPC 上。

revoke execute on function public.admin_create_class(uuid, uuid, text, int) from public, anon;
revoke execute on function public.admin_update_class(uuid, text, int, uuid) from public, anon;
revoke execute on function public.admin_set_class_active(uuid, boolean) from public, anon;
revoke execute on function public.admin_bulk_assign_class(uuid[], uuid) from public, anon;
revoke execute on function public.admin_update_student(uuid, int, uuid) from public, anon;
revoke execute on function public.admin_set_teacher_major(uuid, uuid) from public, anon;
revoke execute on function public.update_my_study_info(int, uuid) from public, anon;
revoke execute on function public.list_my_students(uuid, boolean, text, int, int) from public, anon;
revoke execute on function public.list_my_student_classes() from public, anon;
revoke execute on function public.my_student_detail(uuid) from public, anon;

grant execute on function public.admin_create_class(uuid, uuid, text, int) to authenticated;
grant execute on function public.admin_update_class(uuid, text, int, uuid) to authenticated;
grant execute on function public.admin_set_class_active(uuid, boolean) to authenticated;
grant execute on function public.admin_bulk_assign_class(uuid[], uuid) to authenticated;
grant execute on function public.admin_update_student(uuid, int, uuid) to authenticated;
grant execute on function public.admin_set_teacher_major(uuid, uuid) to authenticated;
grant execute on function public.update_my_study_info(int, uuid) to authenticated;
grant execute on function public.list_my_students(uuid, boolean, text, int, int) to authenticated;
grant execute on function public.list_my_student_classes() to authenticated;
grant execute on function public.my_student_detail(uuid) to authenticated;

notify pgrst, 'reload schema';
