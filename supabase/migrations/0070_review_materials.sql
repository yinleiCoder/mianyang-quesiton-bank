-- 0070: 复习资料空间 —— 教师上传 PDF/Office/图片/音视频，全市学生可查看、下载、分享。
--
-- 为什么不复用 media_objects：那张表是**绑在题目版本上的**（version_media 是
-- (version_id, media_object_id)，GC 按引用计数走），而资料不挂在任何题目上。
-- 而且 register_media 硬校验 key 前缀必须是 qbank/，资料根本登记不进去。
-- 语义不匹配就别硬塞，另起一张表最省事。
--
-- 产品口径（用户拍板）：
--   · 全市共享，**不做可见范围过滤**——所有登录用户都能看到已发布的资料。
--   · 以学科/专业大类为单位组织（course_node_id 挂 subject_nodes，**不限层级**，
--     与试卷同口径；题只能挂课程/公共学科）。
--   · 标注上传人与学校、统计下载次数——"以此尊重教师的付出"。
--   · 上传即可见，不走审批链。
--
-- 删除为什么必须走服务端路由而不是像头像那样从浏览器传 key：
--   头像那条路的残余风险（delete/route.js:12-15 自认）是"知道自己旧 key 的人能删掉
--   已无人引用的对象"。资料是**要长期存在的教学资产**，不能带这个洞。这里的做法是
--   客户端只传**资料 id**，服务端调 delete_review_material 判归属并拿到 key，再去删 OSS——
--   key 全程不出服务端，无从伪造。
--
-- **先删行、后删对象**：反过来的话，一旦 OSS 删成功而行没删掉，库里就留着一行指向
-- 不存在的对象（学生点开是坏链）。现在最坏情况是留个孤儿对象——用户看不见，代价只是存储。

-- =====================================================================
-- 1) 表
-- =====================================================================
create table if not exists public.review_materials (
  id uuid primary key default gen_random_uuid(),

  -- OSS 对象。key 由服务端生成（materials/YYYY/MM/<uuid>.<ext>），这里只存相对 key，
  -- 展示时由 lib/oss-url.js 拼域名——与库里其他媒体同一个口径。
  object_key text not null unique,
  bucket text not null,
  size bigint not null default 0,
  mime text not null,

  title text not null,
  description text,
  -- 搜索用。生成列而不是触发器：少一个会忘记维护的写路径。
  search_text text generated always as (
    lower(title || ' ' || coalesce(description, ''))
  ) stored,

  -- 卡片上的类型图标与筛选维度。由扩展名派生（见 material_kind_from_key），
  -- **不在 SQL 里重复一份 mime 白名单**：白名单真源是 lib/media-spec.js，
  -- 上传时 sign 路由已经卡过一道，这里再抄一份只会漂移。
  kind text not null,

  course_node_id uuid references public.subject_nodes(id) on delete restrict,
  creator_id uuid references auth.users(id) on delete set null,
  school_id uuid references public.schools(id) on delete restrict,

  download_count integer not null default 0,
  is_published boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint review_materials_key_prefix check (object_key like 'materials/%'),
  constraint review_materials_title_len check (char_length(btrim(title)) between 1 and 120),
  constraint review_materials_size_check check (size >= 0),
  constraint review_materials_download_check check (download_count >= 0),
  constraint review_materials_kind_check check (
    kind in ('pdf', 'word', 'sheet', 'slide', 'image', 'audio', 'video', 'other'))
);

comment on table public.review_materials is
  '复习资料：全市共享，按学科/专业大类组织。写操作全部走下面的 RPC，表上只给 SELECT。';
comment on column public.review_materials.creator_id is
  '上传人。on delete set null —— 共享内容随作者注销保留（0021 口径）。';
comment on column public.review_materials.download_count is
  '**只在学生真的保存到本地时 +1**，光是打开查看不计数（用户要的是"下载次数"，不拿浏览数灌水）。';

create index if not exists review_materials_list_idx
  on public.review_materials (is_published, created_at desc);
create index if not exists review_materials_node_idx
  on public.review_materials (course_node_id, created_at desc)
  where is_published;
create index if not exists review_materials_creator_idx
  on public.review_materials (creator_id, created_at desc);

drop trigger if exists trg_review_materials_touch on public.review_materials;
create trigger trg_review_materials_touch
  before update on public.review_materials
  for each row execute function public.touch_updated_at();

-- =====================================================================
-- 2) 扩展名 → 类型（内部助手）
-- =====================================================================
-- 客户端的图标与筛选都按这个 kind 走。认不出的扩展名归 other，不报错——
-- 上传时 sign 路由已经按 lib/media-spec.js 卡过了，这里只是给个展示分类。
create or replace function public.material_kind_from_key(p_object_key text)
returns text
language sql
immutable
as $$
  select case lower(split_part(p_object_key, '.', -1))
           when 'pdf' then 'pdf'
           when 'doc' then 'word' when 'docx' then 'word'
           when 'xls' then 'sheet' when 'xlsx' then 'sheet' when 'csv' then 'sheet'
           when 'ppt' then 'slide' when 'pptx' then 'slide'
           when 'png' then 'image' when 'jpg' then 'image'
           when 'jpeg' then 'image' when 'webp' then 'image' when 'gif' then 'image'
           when 'mp3' then 'audio' when 'wav' then 'audio' when 'ogg' then 'audio'
           when 'mp4' then 'video' when 'webm' then 'video'
           else 'other'
         end;
$$;

comment on function public.material_kind_from_key(text) is
  '资料类型分类（卡片图标与筛选用）。认不出归 other，不做白名单校验——那是 lib/media-spec.js 的事。';

revoke all on function public.material_kind_from_key(text) from public, anon, authenticated;

-- =====================================================================
-- 3) RLS：全市共享，只读
-- =====================================================================
alter table public.review_materials enable row level security;

-- 所有登录用户都能看已发布的；作者额外能看自己的未发布（下架）行。
-- **不建 insert/update/delete 策略**：写操作一律走下面的 SECURITY DEFINER RPC
--（AGENTS.md 硬约束 #4 —— 客户端对表只有 SELECT 权限）。
drop policy if exists rm_select on public.review_materials;
create policy rm_select on public.review_materials
  for select to authenticated
  using (is_published or creator_id = (select auth.uid()));

revoke all on public.review_materials from anon;
grant select on public.review_materials to authenticated;

-- =====================================================================
-- 4) RPC
-- =====================================================================
-- 登记一份资料。文件本身早已由浏览器直传进了 OSS（purpose=material），
-- 这里只落库。**校验 key 前缀与形状**：不信任客户端传来的路径，与 register_media 同款。
create or replace function public.create_review_material(
  p_object_key text,
  p_bucket text,
  p_size bigint,
  p_mime text,
  p_title text,
  p_description text default null,
  p_course_node_id uuid default null)
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
    raise exception '只有教师可以上传复习资料' using errcode = '42501';
  end if;

  -- key 形状必须是服务端生成的那一种：materials/YYYY/MM/<uuid>.<ext>
  if p_object_key !~ '^materials/\d{4}/\d{2}/[0-9a-f-]{36}\.[a-z0-9]+$' then
    raise exception '非法的对象路径';
  end if;

  if char_length(v_title) < 1 or char_length(v_title) > 120 then
    raise exception '标题需在 1~120 字之间';
  end if;

  select school_id into v_school from profiles where user_id = v_uid;

  insert into review_materials (
    object_key, bucket, size, mime, title, description, kind,
    course_node_id, creator_id, school_id)
  values (
    p_object_key, coalesce(p_bucket, ''), greatest(coalesce(p_size, 0), 0),
    coalesce(p_mime, ''), v_title,
    nullif(btrim(coalesce(p_description, '')), ''),
    public.material_kind_from_key(p_object_key),
    p_course_node_id, v_uid, v_school)
  returning id into v_id;

  perform public.audit('create_review_material', null, null,
    jsonb_build_object('material_id', v_id, 'title', v_title, 'key', p_object_key));

  return v_id;
end;
$$;

comment on function public.create_review_material(text, text, bigint, text, text, text, uuid) is
  '登记一份复习资料（文件已由浏览器直传进 OSS）。仅教师可调，上传即可见（is_published 默认 true）。';

-- 删除一份资料：**判归属 → 删行 → 把 key 交回给服务端去删 OSS 对象**。
-- 客户端传的是 id 而不是 key，所以伪造不出别的对象路径。
create or replace function public.delete_review_material(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_row public.review_materials;
begin
  select * into v_row from review_materials where id = p_id for update;
  if not found then
    raise exception '资料不存在或已被删除';
  end if;

  -- 作者本人或管理员。**判据放在函数里而不是 RLS**：删除是硬删，
  -- 没有 delete 策略可以依赖（全仓口径）。
  if v_row.creator_id is distinct from v_uid and not public.is_admin() then
    raise exception '只能删除自己上传的资料' using errcode = '42501';
  end if;

  delete from review_materials where id = p_id;

  perform public.audit('delete_review_material', null, null,
    jsonb_build_object('material_id', p_id, 'title', v_row.title, 'key', v_row.object_key));

  return jsonb_build_object(
    'object_key', v_row.object_key,
    'bucket', v_row.bucket,
    'title', v_row.title);
end;
$$;

comment on function public.delete_review_material(uuid) is
  '删除资料：判归属后硬删行，并把 object_key 交回给服务端（由 /api/materials/delete 去删 OSS 对象）。';

-- 上架 / 下架。给"传错了但不想删"的场合用——全仓惯例是状态机而不是删除。
create or replace function public.set_review_material_published(
  p_id uuid,
  p_published boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_creator uuid;
begin
  select creator_id into v_creator from review_materials where id = p_id;
  if not found then
    raise exception '资料不存在或已被删除';
  end if;
  if v_creator is distinct from v_uid and not public.is_admin() then
    raise exception '只能操作自己上传的资料' using errcode = '42501';
  end if;

  update review_materials set is_published = coalesce(p_published, true) where id = p_id;

  perform public.audit(
    case when p_published then 'publish_review_material' else 'unpublish_review_material' end,
    null, null, jsonb_build_object('material_id', p_id));

  return coalesce(p_published, true);
end;
$$;

comment on function public.set_review_material_published(uuid, boolean) is
  '资料的上下架。下架后只有作者与管理员还看得到（RLS 的 rm_select）。';

-- 下载计数。学生每次真的保存到本地时 +1。
create or replace function public.increment_material_download(p_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  perform public.require_uid();

  update review_materials
     set download_count = download_count + 1
   where id = p_id and is_published
  returning download_count into v_count;

  -- 未发布或不存在时静默返回 0：计数是附带效果，不该让"保存文件"这个动作失败
  return coalesce(v_count, 0);
end;
$$;

comment on function public.increment_material_download(uuid) is
  '学生保存资料到本地时计数 +1。找不到或未发布时返回 0 而不抛错（计数不该阻断下载）。';

-- =====================================================================
-- 5) 权限收口（0006 口径：新函数默认对 PUBLIC 开放，必须显式收回）
-- =====================================================================
revoke all on function public.create_review_material(text, text, bigint, text, text, text, uuid)
  from public, anon;
revoke all on function public.delete_review_material(uuid) from public, anon;
revoke all on function public.set_review_material_published(uuid, boolean) from public, anon;
revoke all on function public.increment_material_download(uuid) from public, anon;

grant execute on function public.create_review_material(text, text, bigint, text, text, text, uuid)
  to authenticated;
grant execute on function public.delete_review_material(uuid) to authenticated;
grant execute on function public.set_review_material_published(uuid, boolean) to authenticated;
grant execute on function public.increment_material_download(uuid) to authenticated;

notify pgrst, 'reload schema';
