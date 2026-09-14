-- 0002: 枚举类型 + 核心组织/角色/科目树表

-- ============ 枚举 ============
create type subject_scope as enum ('common', 'vocational');   -- 公共科目 / 专业科目
create type subject_kind as enum ('discipline', 'category', 'major', 'course');
create type assignee_role as enum ('group_leader', 'city_expert');

-- ============ 学校 ============
create table public.schools (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  code       text not null unique,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.schools is '参与共建的学校；由系统管理员维护';

-- ============ 用户档案 ============
create table public.profiles (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  name       text not null,
  email      text not null,
  school_id  uuid references public.schools(id) on delete restrict, -- 市级专家等可无学校
  is_admin   boolean not null default false,  -- 系统管理员（固定一人）
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- 系统管理员全局唯一，防止漂移
create unique index uq_profiles_single_admin on public.profiles (is_admin) where is_admin;

-- 注册用户自动建 profile：name/school_id 取自注册时的 raw_user_meta_data
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1));
  v_school uuid := nullif(new.raw_user_meta_data ->> 'school_id', '')::uuid;
begin
  if v_school is not null and not exists (select 1 from schools where id = v_school and is_active) then
    v_school := null;
  end if;
  insert into public.profiles (user_id, name, email, school_id)
  values (new.id, v_name, coalesce(new.email, ''), v_school)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 学校管理员角色（作用于该用户档案所属学校，RBAC 可与其他身份重叠）
create table public.user_roles (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null check (role in ('school_admin')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  unique (user_id, role)
);
comment on table public.user_roles is '无科目范围的 RBAC 角色（目前仅 school_admin），一人可持多角色';

-- ============ 科目树 ============
create table public.subject_nodes (
  id         uuid primary key default gen_random_uuid(),
  parent_id  uuid references public.subject_nodes(id) on delete restrict,
  scope      subject_scope not null,
  kind       subject_kind not null,
  name       text not null,
  sort_order int not null default 0,
  is_frozen  boolean not null default false,  -- 冻结=暂停挂新题，在途审批不受影响
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.subject_nodes is '科目树：公共=discipline 单层(可挂题)；专业=category→major→course(课程挂题)';

-- 兄弟节点名称唯一（忽略大小写、跨父级按 scope 隔离；父为 null 用零 uuid 占位解决 NULL 去重问题）
create unique index uq_subject_nodes_sibling_name
  on public.subject_nodes (scope, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'), lower(name));

-- 结构校验：kind 与 parent/scope 层级矩阵
create or replace function public.validate_subject_node()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent_kind subject_kind;
  v_parent_scope subject_scope;
begin
  if new.parent_id is not null then
    select kind, scope into v_parent_kind, v_parent_scope from subject_nodes where id = new.parent_id;
    if not found then
      raise exception '父节点不存在';
    end if;
    if v_parent_scope <> new.scope then
      raise exception '父子节点必须属于同一目录（公共/专业）';
    end if;
  end if;

  case new.kind
    when 'discipline' then
      if new.scope <> 'common' or new.parent_id is not null then
        raise exception '公共学科(discipline)必须位于公共目录顶层且无父节点';
      end if;
    when 'category' then
      if new.scope <> 'vocational' or new.parent_id is not null then
        raise exception '专业大类(category)必须位于专业目录顶层且无父节点';
      end if;
    when 'major' then
      if v_parent_kind is distinct from 'category' then
        raise exception '专业(major)的父节点必须是专业大类(category)';
      end if;
    when 'course' then
      if new.scope = 'vocational' and v_parent_kind is distinct from 'major' then
        raise exception '专业课程(course)的父节点必须是专业(major)';
      end if;
      -- 公共科目下的 course：父节点为 discipline（教材/模块层预留）
      if new.scope = 'common' and v_parent_kind is distinct from 'discipline' then
        raise exception '公共目录下仅允许 discipline 下挂 course';
      end if;
  end case;
  return new;
end;
$$;

drop trigger if exists trg_subject_nodes_validate on public.subject_nodes;
create trigger trg_subject_nodes_validate
  before insert or update on public.subject_nodes
  for each row execute function public.validate_subject_node();

-- 判断节点是否可挂题目：公共 discipline 或（专业/公共的）course
create or replace function public.can_attach_question(p_node subject_nodes)
returns boolean
language sql
immutable
as $$
  select p_node.kind in ('discipline', 'course');
$$;

-- ============ 审核岗位任命（一岗一人） ============
create table public.approver_assignments (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       assignee_role not null,
  school_id  uuid references public.schools(id) on delete cascade, -- 组长必填；专家为空
  node_id    uuid not null references public.subject_nodes(id) on delete cascade,
  is_active  boolean not null default true,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);
comment on table public.approver_assignments is '审核岗位：组长(学校+科目节点,覆盖后代) / 市级专家(科目节点,全市)；一岗一人(停旧启新即换人)';
alter table public.approver_assignments
  add constraint chk_approver_scope check (
    (role = 'group_leader' and school_id is not null)
    or (role = 'city_expert' and school_id is null)
  );

-- 一岗一人：同一 (学校,节点,岗位) 至多一条生效任命（专家 school_id 为 null → coalesce 消除 NULL 去重陷阱）
create unique index uq_approver_one_active
  on public.approver_assignments (role, coalesce(school_id, '00000000-0000-0000-0000-000000000000'), node_id)
  where is_active;

-- ============ 触发器函数：更新 updated_at ============
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_schools_touch before update on public.schools
  for each row execute function public.touch_updated_at();
create trigger trg_profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger trg_subject_nodes_touch before update on public.subject_nodes
  for each row execute function public.touch_updated_at();

-- questions 的 touch 触发器随 0003 建表后创建
