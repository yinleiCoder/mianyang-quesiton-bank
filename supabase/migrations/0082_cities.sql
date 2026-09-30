-- 0082: 多市区第一步 —— 新增 cities，schools 加 city_id。
--
-- 背景：题库要走出绵阳（四川省下的其他市）。而"现在只有绵阳"是靠**数据**实现的：
-- 迁移文件里零处市名，schema 里根本没有市这一级（`school_id` 是全库唯一的租户锚点，
-- profiles / questions / papers / classes / review_materials / import_jobs /
-- approval_inbox / approver_assignments 八张表都挂在它上面）。这一步把市补进 schema。
--
-- 设计（2026-09-30 定稿，见 docs/pending-design.md 第一节）：
--   **只加 schools.city_id 这一列，其余全部推导** ——
--   "这个人在哪个市" = profiles.school_id → schools.city_id，一次 join。
--   刻意**不**在 questions / approvals 上各加一列：那要改几十个查询（RLS 也得跟着动），
--   还多一份可能与 schools 不一致的状态。
--
-- **本步是纯增量的**：不删任何现有列、不动任何现有 RLS；现有页面按
-- `select id, name, code, is_active, created_at` 读 schools 照常工作。
-- 唯一的签名变更是文件末尾的 admin_create_school（要求指定市，并显式 drop 掉两参旧版）——
-- 原因写在那一节的注释里：**没有市的学校在第 2 步（市级审批池市域收口）里是隐性黑洞**，
-- 而仓库内唯一的调用方（components/admin/schools-manager.jsx）在本次改动里同步改掉。

-- ── 市 ──────────────────────────────────────────────────────────────────────
-- 结构与 schools 同形（超管维护的低频元数据）：name 与 code 都唯一 —— 这跟 schools 不同
--（schools 只约束 code）。市是省的下一级、数量在个位到十位，重名是真错而不是同名异地，
-- 所以名称也拦一道；超管撞名时拿到的是一句中文提示，不是 PG 的约束名。
create table public.cities (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  code       text not null unique,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.cities is '四川省下参与共建的市；由系统管理员维护。学校挂在市上，教师/题目/试卷的市由学校推导，不单独存';

create trigger trg_cities_touch before update on public.cities
  for each row execute function public.touch_updated_at();

-- ── 学校挂到市 ──────────────────────────────────────────────────────────────
-- 可空：现有行由下面回填，但列本身不设 not null —— "平台/省级"这类非实体学校本来就不属于
-- 任何一个市，第 2 步收口时再决定它怎么算。新建学校则一律要求指定市（见 admin_create_school）。
-- on delete restrict：与 profiles.school_id 同口径 —— 有学校挂着的市删不掉（市只停用不删除）。
alter table public.schools
  add column city_id uuid references public.cities(id) on delete restrict;
comment on column public.schools.city_id is '学校所属市；"这个人在哪个市"由 profiles.school_id → 这里推导，不在 profiles/questions 上另存';

-- 外键列不自动建索引；按市筛学校（第 2 步的市域收口）会走它
create index idx_schools_city on public.schools (city_id);

-- ── 一次性回填：线上 10 所学校全部在绵阳 ────────────────────────────────────
-- （2026-09-30 逐行核对过：盐亭/三台/梓潼/安州/北川/江油/游仙/绵阳职中，加两所停用的
--   「市级题库（平台）」「平武之中」。）
-- exists 守卫是给"将来在空库上重放"用的 —— 空库不该凭空长出一行绵阳市，
-- 该由超管自己建。回填也不覆盖已有 city_id，重放安全。
insert into public.cities (name, code)
select '绵阳市', 'MIANYANG'
where exists (select 1 from public.schools);

update public.schools
   set city_id = (select id from public.cities where code = 'MIANYANG')
 where city_id is null;

-- ── 权限：与 schools 同口径 ─────────────────────────────────────────────────
-- 只给 authenticated SELECT。**anon 刻意不给**：注册页目前只列学校、不显示市，
-- 而 anon 能读的表越少越好（全库现在只有 schools / classes / subject_nodes）。
-- 将来注册页要按市分组或显示"XX学校（绵阳市）"，再单开一条
-- `grant select on public.cities to anon`（cities 是公开元数据，开出去本身没有风险）。
alter table public.cities enable row level security;

drop policy if exists select_any_auth on public.cities;
create policy select_any_auth on public.cities for select to authenticated using (true);

revoke all on public.cities from anon, authenticated;
grant select on public.cities to authenticated;

-- ── 维护 RPC（超管）────────────────────────────────────────────────────────
create or replace function public.admin_create_city(p_name text, p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可创建市';
  end if;
  if trim(p_name) = '' or trim(p_code) = '' then
    raise exception '市名称与代码不能为空';
  end if;
  begin
    insert into cities (name, code)
    values (trim(p_name), upper(trim(p_code)))
    returning id into v_id;
  exception when unique_violation then
    raise exception '该市已存在：名称「%」或代码「%」与现有记录重复',
      trim(p_name), upper(trim(p_code));
  end;
  perform public.audit('admin_create_city', null, null,
    jsonb_build_object('city_id', v_id, 'name', trim(p_name), 'code', upper(trim(p_code))));
  return v_id;
end;
$$;

-- 停用/启用。**不拦"该市还有启用的学校"**：市停用只是"不再往这里挂新学校"的标记，
-- 迁移期完全可能先停市、再把剩下的学校逐个挪走。市真正的语义（停用后市的专家还审不审、
-- 题库还并进来吗）由第 2 步的市域收口定义，现在不预先规定。
create or replace function public.admin_set_city_active(p_city_id uuid, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可操作';
  end if;
  update cities set is_active = p_active where id = p_city_id;
  if not found then
    raise exception '市不存在';
  end if;
  perform public.audit('admin_set_city_active', null, null,
    jsonb_build_object('city_id', p_city_id, 'active', p_active));
end;
$$;

-- 学校改挂到别的市。**这是一步到位的整体迁移**：市是推导出来的，
-- 改完学校的市，该校的教师、题目、试卷、班级当场全部归到新市 —— 这正是"只加一列"的代价，
-- 也是它的好处（不存在"一半在旧市"）。界面上要如实这么讲。
create or replace function public.admin_set_school_city(p_school_id uuid, p_city_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可操作';
  end if;
  if not exists (select 1 from cities where id = p_city_id and is_active) then
    raise exception '市不存在或已停用';
  end if;
  update schools set city_id = p_city_id where id = p_school_id;
  if not found then
    raise exception '学校不存在';
  end if;
  perform public.audit('admin_set_school_city', null, null,
    jsonb_build_object('school_id', p_school_id, 'city_id', p_city_id));
end;
$$;

-- 建校要指定市（原来只有 name + code）。
-- 为什么必须：没有市的学校，在第 2 步的市域收口之后，它的题目不属于任何一个市的审批池 ——
-- 一个静默的黑洞，不会报错，只会"看不见"。堵在入口比事后补救便宜。
create or replace function public.admin_create_school(p_name text, p_code text, p_city_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_id uuid;
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可创建学校';
  end if;
  if trim(p_name) = '' or trim(p_code) = '' then
    raise exception '学校名称与代码不能为空';
  end if;
  if not exists (select 1 from cities where id = p_city_id and is_active) then
    raise exception '市不存在或已停用';
  end if;
  insert into schools (name, code, city_id)
  values (trim(p_name), upper(trim(p_code)), p_city_id)
  returning id into v_id;
  perform public.audit('admin_create_school', null, null,
    jsonb_build_object('school_id', v_id, 'name', trim(p_name), 'code', upper(trim(p_code)), 'city_id', p_city_id));
  return v_id;
end;
$$;

-- 旧的两参版本必须**显式 drop**：create or replace 只替换同参数列表的函数，
-- 留着它 PostgREST 对两参调用就有两个候选（PGRST203 "Could not choose the best candidate"），
-- 而且那条路径建出来的学校没有市 —— 正是上面要堵的洞。
-- 调用方只有网页端的 components/admin/schools-manager.jsx（同一次改动里已改成传 p_city_id）；
-- Flutter 客户端不调用它（grep 过 mianyang_quiz/）。
-- ⚠ 上线顺序：先发这一版网页端（或同时），别让旧页面在新库上点"创建学校"——它会撞 PGRST202。
drop function public.admin_create_school(text, text);

-- ── 授权收口 ────────────────────────────────────────────────────────────────
-- 0006 那次全量 revoke 只覆盖当时已存在的函数；新建的函数会被项目默认权限自动授予
-- anon/service_role（见 supabase-migration/CHECKLIST.md 记的那个坑），所以每个新函数都要自己收紧。
revoke all on function public.admin_create_city(text, text) from public, anon, service_role;
revoke all on function public.admin_set_city_active(uuid, boolean) from public, anon, service_role;
revoke all on function public.admin_set_school_city(uuid, uuid) from public, anon, service_role;
revoke all on function public.admin_create_school(text, text, uuid) from public, anon, service_role;

grant execute on function public.admin_create_city(text, text) to authenticated;
grant execute on function public.admin_set_city_active(uuid, boolean) to authenticated;
grant execute on function public.admin_set_school_city(uuid, uuid) to authenticated;
grant execute on function public.admin_create_school(text, text, uuid) to authenticated;

notify pgrst, 'reload schema';
