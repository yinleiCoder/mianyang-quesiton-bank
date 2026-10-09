-- 0094：教学动画空间 —— 数据层（M1）
--
-- 口径与分层见 docs/animation-space-design.md。一句话复述最要紧的那条：
-- **学生消费的是"成片"（OSS 上的视频），不是 Remotion 运行时**；源码只是创作期产物，
-- 存在**单独一张表**里、只在沙箱 iframe 内被编译执行，永不进 Next 的 bundle。
--
-- 形状整体照 0070_review_materials.sql（教师产出 + OSS 媒体 + 挂科目树 + 写操作全走
-- SECURITY DEFINER RPC，表上只给 SELECT）。与它的两处不同：
--   1. **源码拆表**：Postgres 没有列级 RLS，源码留在主表上，任何登录用户（含学生）
--      直接 select 就能拿到 —— 而"UI 不选这一列"不是边界。
--   2. **状态机**：资料是 is_published 一个布尔，动画要走两级审批，所以是 status 枚举。

-- =====================================================================
-- 1) 表
-- =====================================================================
create table if not exists public.teaching_animations (
  id uuid primary key default gen_random_uuid(),

  title text not null,
  description text,
  -- 搜索用。生成列而不是触发器：少一个会忘记维护的写路径。
  search_text text generated always as (
    lower(title || ' ' || coalesce(description, ''))
  ) stored,

  course_node_id uuid references public.subject_nodes(id) on delete restrict,
  creator_id uuid references auth.users(id) on delete set null,
  school_id uuid references public.schools(id) on delete restrict,

  -- 成片（渲染产物）。**null = 还没渲染过**，此时不许提交审批。
  -- key 由服务端生成（animations/YYYY/MM/<uuid>.<ext>），展示时由 lib/oss-url.js 拼域名。
  -- unique：教师不能把自己的 key 改成别人已发布动画的 key（否则重渲染时会把别人的成片删掉）。
  object_key text unique,
  poster_key text unique,
  bucket text,
  size bigint not null default 0,
  mime text,

  -- 渲染规格：与 renderMediaOnWeb 的参数一致，播放与排查都读它。
  -- 上限是**浏览器渲染**的耗时/内存兜底（3 分钟 @ 该帧率），不是随便定的。
  fps integer not null default 30,
  width integer not null default 1920,
  height integer not null default 1080,
  duration_in_frames integer not null default 0,

  -- 审批状态机。v1 **没有版本表**（口径：入库后不可改，要改就另起一份）。
  status text not null default 'draft',
  published_at timestamptz,
  render_count integer not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint teaching_animations_status_check check (
    status in ('draft', 'pending_group', 'pending_city', 'published', 'returned', 'offline')),
  constraint teaching_animations_key_prefix check (
    object_key is null or object_key like 'animations/%'),
  constraint teaching_animations_poster_prefix check (
    poster_key is null or poster_key like 'animations/%'),
  constraint teaching_animations_title_len check (char_length(btrim(title)) between 1 and 120),
  constraint teaching_animations_size_check check (size >= 0),
  constraint teaching_animations_render_check check (render_count >= 0),
  constraint teaching_animations_spec_check check (
    fps between 1 and 60
    and width between 1 and 1920
    and height between 1 and 1080
    and duration_in_frames between 0 and fps * 180)
);

comment on table public.teaching_animations is
  '教学动画（成片）：全市共享，按学科组织。写操作全部走下面的 RPC，表上只给 SELECT。';
comment on column public.teaching_animations.object_key is
  '渲染成片的 OSS key。null = 还没渲染，此时 submit 会被拒（审批人审的是成片，不是源码）。';
comment on column public.teaching_animations.duration_in_frames is
  '帧数上限 fps*180（3 分钟）——浏览器渲染是单线程的，长动画会把作者的标签页卡住。';
comment on column public.teaching_animations.creator_id is
  '作者。on delete set null —— 共享内容随作者注销保留（0021 口径）。';

-- 源码：**单独一张表**，理由见文件头。一张动画一行，随主行级联删除。
create table if not exists public.teaching_animation_sources (
  animation_id uuid primary key references public.teaching_animations(id) on delete cascade,
  -- AI/教师写出来的 Remotion 组件源码（一段函数体，见 remotion/sandbox 的约定）。
  -- 它**只在沙箱 iframe 里**被编译执行，服务端从不执行它。
  source text not null,
  input_props jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint teaching_animation_sources_len check (char_length(source) between 1 and 20000)
);

comment on table public.teaching_animation_sources is
  '动画源码。拆表是为了 RLS：Postgres 没有列级授权，源码留在主表上学生也能读到。';

create index if not exists teaching_animations_list_idx
  on public.teaching_animations (status, published_at desc nulls last);
create index if not exists teaching_animations_node_idx
  on public.teaching_animations (course_node_id, published_at desc nulls last)
  where status = 'published';
create index if not exists teaching_animations_creator_idx
  on public.teaching_animations (creator_id, created_at desc);

drop trigger if exists trg_teaching_animations_touch on public.teaching_animations;
create trigger trg_teaching_animations_touch
  before update on public.teaching_animations
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_teaching_animation_sources_touch on public.teaching_animation_sources;
create trigger trg_teaching_animation_sources_touch
  before update on public.teaching_animation_sources
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- 2) 内部助手
-- =====================================================================
-- 学校归属判断（RLS 用）。**逐字照 is_school_admin_of_paper**：
-- 角色不在 profiles 上，而在 user_roles 表里（profiles 只有 is_admin 这一个布尔）。
-- 别凭印象写 p.role —— 线上直接报 42703 column p.role does not exist。
create or replace function public.is_school_admin_of_animation(p_animation_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from teaching_animations a
    join profiles pr on pr.user_id = (select auth.uid())
    join user_roles r on r.user_id = pr.user_id and r.role = 'school_admin'
    where a.id = p_animation_id and pr.school_id = a.school_id
  );
$$;

-- ⚠ **不能连 authenticated 一起收回**：RLS 策略是以查询者身份求值的，
-- 策略里调用的函数必须对该角色可执行，否则一读表就 42501 permission denied。
-- 对照线上 is_school_admin_of_paper 的 ACL：postgres | authenticated | service_role。
revoke all on function public.is_school_admin_of_animation(uuid) from public, anon;
grant execute on function public.is_school_admin_of_animation(uuid) to authenticated;

-- =====================================================================
-- 3) RLS：已入库的全市可读；作者看自己的；管理员看全部
-- =====================================================================
alter table public.teaching_animations enable row level security;

-- 审批人那一支要等 0095（动画审批表）落地后再加——届时补一条
-- is_animation_approver(id) 的分支，**不要**在这里预留一个永远为假的函数。
drop policy if exists ta_select on public.teaching_animations;
create policy ta_select on public.teaching_animations
  for select to authenticated
  using (
    status = 'published'
    or creator_id = (select auth.uid())
    or (select public.is_admin())
    or (select public.is_school_admin_of_animation(id))
  );

-- 源码只给作者与管理员。审批人要不要看源码，等 0095 一起定（默认不给：他审的是成片）。
alter table public.teaching_animation_sources enable row level security;

drop policy if exists tas_select on public.teaching_animation_sources;
create policy tas_select on public.teaching_animation_sources
  for select to authenticated
  using (
    exists (
      select 1 from public.teaching_animations a
      where a.id = animation_id
        and (a.creator_id = (select auth.uid()) or (select public.is_admin()))
    )
  );

revoke all on public.teaching_animations from anon;
revoke all on public.teaching_animation_sources from anon;
grant select on public.teaching_animations to authenticated;
grant select on public.teaching_animation_sources to authenticated;

-- =====================================================================
-- 4) RPC（全部 SECURITY DEFINER；客户端对表只有 SELECT）
-- =====================================================================
-- 建一条动画（**只有源码，还没有成片**）。渲染与上传在浏览器里完成，
-- 之后调 save_teaching_animation_render 把成片贴上。
create or replace function public.create_teaching_animation(
  p_title text,
  p_description text,
  p_course_node_id uuid,
  p_source text,
  p_fps integer default 30,
  p_width integer default 1920,
  p_height integer default 1080,
  p_duration_in_frames integer default 0,
  p_input_props jsonb default '{}'::jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_id uuid;
  v_school uuid;
  v_title text := btrim(coalesce(p_title, ''));
begin
  if not public.is_teacher() then
    raise exception '只有教师可以创建教学动画' using errcode = '42501';
  end if;

  if char_length(v_title) < 1 or char_length(v_title) > 120 then
    raise exception '标题需在 1~120 字之间';
  end if;
  if p_course_node_id is null then
    raise exception '请选择所属学科';
  end if;

  select school_id into v_school from profiles where user_id = v_uid;

  insert into teaching_animations (
    title, description, course_node_id, creator_id, school_id,
    fps, width, height, duration_in_frames)
  values (
    v_title, nullif(btrim(coalesce(p_description, '')), ''), p_course_node_id, v_uid, v_school,
    coalesce(p_fps, 30), coalesce(p_width, 1920), coalesce(p_height, 1080),
    greatest(coalesce(p_duration_in_frames, 0), 0))
  returning id into v_id;

  insert into teaching_animation_sources (animation_id, source, input_props)
  values (v_id, p_source, coalesce(p_input_props, '{}'::jsonb));

  perform public.audit('create_teaching_animation', null, null,
    jsonb_build_object('animation_id', v_id, 'title', v_title));

  return v_id;
end;
$$;

-- 改源码（只允许草稿/被退回的行，且必须是作者或管理员）。
-- 与"入库后不可改"的口径不冲突：这里改的是**还没入库**的东西。
create or replace function public.update_teaching_animation_source(
  p_animation_id uuid,
  p_source text,
  p_duration_in_frames integer default null,
  p_input_props jsonb default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_row teaching_animations%rowtype;
begin
  select * into v_row from teaching_animations where id = p_animation_id;
  if not found then
    raise exception '动画不存在';
  end if;
  if v_row.creator_id is distinct from v_uid and not public.is_admin() then
    raise exception '只能修改自己创建的动画' using errcode = '42501';
  end if;
  if v_row.status not in ('draft', 'returned') then
    raise exception '已提交审核或已入库的动画不可修改（改动请另起一份）';
  end if;

  update teaching_animation_sources
     set source = p_source,
         input_props = coalesce(p_input_props, input_props)
   where animation_id = p_animation_id;

  if p_duration_in_frames is not null then
    update teaching_animations
       set duration_in_frames = greatest(p_duration_in_frames, 0)
     where id = p_animation_id;
  end if;
end;
$$;

-- 贴上渲染结果（重渲染也走这里）。**返回旧 key**，让服务端把旧对象删掉。
-- 客户端传 key 而不是自己删对象：删什么由服务端说了算，伪造不出别的路径（同 0070）。
create or replace function public.save_teaching_animation_render(
  p_animation_id uuid,
  p_object_key text,
  p_poster_key text,
  p_bucket text,
  p_size bigint,
  p_mime text,
  p_duration_in_frames integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_row teaching_animations%rowtype;
  v_old jsonb;
begin
  select * into v_row from teaching_animations where id = p_animation_id;
  if not found then
    raise exception '动画不存在';
  end if;
  if v_row.creator_id is distinct from v_uid and not public.is_admin() then
    raise exception '只能修改自己创建的动画' using errcode = '42501';
  end if;
  if v_row.status not in ('draft', 'returned') then
    raise exception '已提交审核或已入库的动画不可重新渲染（改动请另起一份）';
  end if;

  if p_object_key !~ '^animations/\d{4}/\d{2}/[0-9a-f-]{36}\.[a-z0-9]+$' then
    raise exception '非法的对象路径';
  end if;
  if p_poster_key is not null and p_poster_key !~ '^animations/\d{4}/\d{2}/[0-9a-f-]{36}\.[a-z0-9]+$' then
    raise exception '非法的封面路径';
  end if;

  v_old := jsonb_build_object('object_key', v_row.object_key, 'poster_key', v_row.poster_key);

  update teaching_animations
     set object_key = p_object_key,
         poster_key = p_poster_key,
         bucket = coalesce(p_bucket, ''),
         size = greatest(coalesce(p_size, 0), 0),
         mime = coalesce(p_mime, ''),
         duration_in_frames = greatest(coalesce(p_duration_in_frames, v_row.duration_in_frames), 0),
         render_count = v_row.render_count + 1
   where id = p_animation_id;

  perform public.audit('save_animation_render', null, null,
    jsonb_build_object('animation_id', p_animation_id, 'key', p_object_key,
                       'size', p_size, 'frames', p_duration_in_frames));

  return v_old;
end;
$$;

-- 删除：**判归属 → 删行 → 把两个 key 交回给服务端去删 OSS 对象**（同 0070 的顺序）。
create or replace function public.delete_teaching_animation(p_animation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_row teaching_animations%rowtype;
begin
  select * into v_row from teaching_animations where id = p_animation_id;
  if not found then
    raise exception '动画不存在';
  end if;
  if v_row.creator_id is distinct from v_uid and not public.is_admin() then
    raise exception '只能删除自己创建的动画' using errcode = '42501';
  end if;
  if v_row.status in ('pending_group', 'pending_city') then
    raise exception '审核中的动画不能删除，请先撤回';
  end if;

  perform public.audit('delete_teaching_animation', null, null,
    jsonb_build_object('animation_id', p_animation_id, 'title', v_row.title,
                       'status', v_row.status));

  delete from teaching_animations where id = p_animation_id;

  return jsonb_build_object('object_key', v_row.object_key, 'poster_key', v_row.poster_key);
end;
$$;

-- 上下架。**可逆动作，不走审批**（与复习资料同口径）。
--
-- ⚠ 到期日：M5 接入两级审批后，"从 draft 到 published"这条路要**收回给审批链**——
--   那时本函数增加一条断言：只有 `published`/`offline` 之间才允许切换。
--   现在（0095 之前）没有审批链，若不允许直接上线，最小闭环就没法在真实数据上验收。
create or replace function public.set_teaching_animation_published(
  p_animation_id uuid,
  p_published boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_row teaching_animations%rowtype;
begin
  select * into v_row from teaching_animations where id = p_animation_id;
  if not found then
    raise exception '动画不存在';
  end if;
  if v_row.creator_id is distinct from v_uid and not public.is_admin() then
    raise exception '只能操作自己创建的动画' using errcode = '42501';
  end if;
  if v_row.object_key is null then
    raise exception '这份动画还没有渲染出成片，不能上线';
  end if;

  if p_published then
    update teaching_animations
       set status = 'published',
           published_at = coalesce(published_at, now())
     where id = p_animation_id;
  else
    update teaching_animations
       set status = 'offline'
     where id = p_animation_id;
  end if;

  perform public.audit(case when p_published then 'publish_animation' else 'offline_animation' end,
    null, null, jsonb_build_object('animation_id', p_animation_id));
end;
$$;

-- =====================================================================
-- 5) 权限收口（0006 口径：新函数默认对 PUBLIC 开放，必须显式收回）
-- =====================================================================
revoke all on function public.create_teaching_animation(text, text, uuid, text, integer, integer, integer, integer, jsonb) from public, anon;
revoke all on function public.update_teaching_animation_source(uuid, text, integer, jsonb) from public, anon;
revoke all on function public.save_teaching_animation_render(uuid, text, text, text, bigint, text, integer) from public, anon;
revoke all on function public.delete_teaching_animation(uuid) from public, anon;
revoke all on function public.set_teaching_animation_published(uuid, boolean) from public, anon;

grant execute on function public.create_teaching_animation(text, text, uuid, text, integer, integer, integer, integer, jsonb) to authenticated;
grant execute on function public.update_teaching_animation_source(uuid, text, integer, jsonb) to authenticated;
grant execute on function public.save_teaching_animation_render(uuid, text, text, text, bigint, text, integer) to authenticated;
grant execute on function public.delete_teaching_animation(uuid) to authenticated;
grant execute on function public.set_teaching_animation_published(uuid, boolean) to authenticated;

notify pgrst, 'reload schema';
