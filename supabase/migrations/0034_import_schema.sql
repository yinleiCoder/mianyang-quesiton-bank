-- 0034: 批量导入题库（大模型解析任务）。
-- 场景：教师手里有现成试卷（PDF / Word / 拍照），一次导入几十到几百道题：模型解析 →
-- 人工预览校对 → 批量生成草稿 → 走既有的两级审核链（本功能不绕过审核）。
-- 设计取舍（三条都不显然，改动前先读完）：
--   · **源文件不上传**：上百兆的 PDF 留在浏览器里用 pdf.js 本地渲染，只把「当前批次的
--     页面图/文本」发给服务端——既绕开 OSS question_media 的 50MB 上限，也不需要服务端
--     PDF 渲染工具链。代价是刷新后必须重新选同一份文件才能续跑，用 source_sha256 校验
--     是同一份；**已完成页永不重跑**（进度权威在 import_job_pages 表里，不在前端内存）。
--   · **三张表分层**：任务（配置与进度）/ 页（执行单元：认领、租约、重试）/ 题目（解析产物）。
--     页表是并发与幂等的唯一支点：多标签页、StrictMode 双跑、断网重试都由它兜住。
--   · 指纹（source_sha256 / content_hash）只用于提示，**不建唯一约束**：不同学校的老师
--     真的可能出同一道题，导入只提醒不拦截（幂等只靠 import_job_items.status='imported'）。
-- 客户端零 DML：本文件只授 select，写操作全部走 0035 的 RPC。

-- ============ 任务 ============
create table public.import_jobs (
  id                 uuid primary key default gen_random_uuid(),
  created_by         uuid not null references auth.users(id) on delete cascade,
  school_id          uuid not null references public.schools(id) on delete restrict,
  course_node_id     uuid not null references public.subject_nodes(id) on delete restrict,
  title              text not null check (char_length(title) between 1 and 120),
  source_kind        text not null check (source_kind in ('pdf', 'docx', 'image')),
  source_name        text not null check (char_length(source_name) between 1 and 200),
  source_pages       int not null default 0 check (source_pages between 0 and 20000),
  source_sha256      text check (source_sha256 is null or char_length(source_sha256) = 64),
  page_from          int not null check (page_from >= 1),
  page_to            int not null,
  image_mode         text not null default 'auto' check (image_mode in ('auto', 'single', 'tiles')),
  image_detail       text not null default 'high' check (image_detail in ('low', 'high', 'original')),
  answer_mode        text not null default 'embedded' check (answer_mode in ('embedded', 'separate', 'none')),
  answer_from        int,
  answer_to          int,
  gen_analysis       boolean not null default true,
  default_qtype      text check (default_qtype is null
                       or default_qtype in ('single_choice', 'multiple_choice', 'true_false',
                                            'fill_blank', 'short_answer', 'composite')),
  default_difficulty smallint not null default 2 check (default_difficulty between 1 and 3),
  tag_ids            uuid[] not null default '{}'::uuid[]
                       check (cardinality(tag_ids) <= 20),
  status             text not null default 'running'
                       check (status in ('running', 'review', 'importing', 'done', 'discarded')),
  total_pages        int not null default 0 check (total_pages >= 0),
  done_pages         int not null default 0 check (done_pages >= 0),
  failed_pages       int not null default 0 check (failed_pages >= 0),
  item_count         int not null default 0 check (item_count >= 0),
  kept_count         int not null default 0 check (kept_count >= 0),
  imported_count     int not null default 0 check (imported_count >= 0),
  usage              jsonb not null default '{}'::jsonb,
  last_error         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  finished_at        timestamptz,
  check (page_to >= page_from),
  -- 单任务页数上限：一次几百页是正常需求，上千页多半是选错了文件；按批跑，不是按任务堆
  check (page_to - page_from + 1 <= 500),
  check (answer_mode <> 'separate'
         or (answer_from is not null and answer_to is not null and answer_to >= answer_from))
);

comment on table public.import_jobs is '批量导入任务：源文件留在浏览器，本表只记配置/进度/用量';
comment on column public.import_jobs.school_id is '归属学校：建任务时由 check_can_author 快照，与题目保持一致';
comment on column public.import_jobs.course_node_id is '本批题目的统一课程节点（题目必须有挂点，见 questions.course_node_id）';
comment on column public.import_jobs.source_sha256 is '源文件指纹：刷新后重选文件时校验是同一份，也用于同一文件重复导入的提醒';
comment on column public.import_jobs.image_mode is '图片切分模式：auto 由客户端几何预判，single 整页，tiles 切成 ≤800×800 的小块换分辨率';
comment on column public.import_jobs.image_detail is '传给多模态模型的 detail 档位（low/high/original）';
comment on column public.import_jobs.answer_mode is '答案位置：embedded 题内自带，separate 卷末答案页（v1.1），none 无答案';
comment on column public.import_jobs.usage is '上游 token 用量累计（原样落 DeepSeek 返回的 usage，含缓存命中字段）';
comment on column public.import_jobs.status is '任务态：running 解析中 / review 待校对 / importing 入库中 / done 完成 / discarded 已放弃';

create index idx_import_jobs_creator on public.import_jobs (created_by, created_at desc);
create index idx_import_jobs_active on public.import_jobs (status)
  where status in ('running', 'importing');

create trigger trg_import_jobs_touch before update on public.import_jobs
  for each row execute function public.touch_updated_at();

-- ============ 页（执行单元） ============
-- 一行 = 一页。建任务时一次写全，之后只改状态——续跑、重试、并发都读这张表。
create table public.import_job_pages (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references public.import_jobs(id) on delete cascade,
  page_no          int not null check (page_no >= 1),
  mode             text not null default 'auto' check (mode in ('auto', 'text', 'vision', 'hybrid')),
  status           text not null default 'pending'
                     check (status in ('pending', 'running', 'done', 'failed', 'skipped')),
  attempts         smallint not null default 0 check (attempts between 0 and 9),
  tile_count       smallint not null default 0,
  lease_token      uuid,
  lease_expires_at timestamptz,
  error            text,
  raw_text         text check (raw_text is null or char_length(raw_text) <= 40000),
  usage            jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (job_id, page_no)
);

comment on table public.import_job_pages is '页级执行单元：认领/租约/重试都在这里，是「刷新可续跑」的权威进度源';
comment on column public.import_job_pages.attempts is '认领次数（在 claim 时 +1，不是成功/失败时）：响应丢失也算一次，防止死循环';
comment on column public.import_job_pages.raw_text is '模型原始返回（截断 40KB）：失败可复现、规范化逻辑可离线回放，不必重调大模型';
comment on column public.import_job_pages.lease_token is '租约令牌：回写时校验，防止过期页面被另一标签页认领后又被旧请求覆盖';

create index idx_import_job_pages_claim on public.import_job_pages (job_id, status, page_no);

create trigger trg_import_job_pages_touch before update on public.import_job_pages
  for each row execute function public.touch_updated_at();

-- ============ 解析出的题目 ============
-- content 是**严格 content 契约**（与 question_versions.content 同形），因为最终要直接喂给
-- create_question_draft 的校验；规范化在服务端完成，前端只做展示与轻量编辑。
create table public.import_job_items (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.import_jobs(id) on delete cascade,
  page_no      int not null check (page_no >= 1),
  page_no_end  int,
  seq          int not null check (seq >= 0),
  qno          text,
  qtype        text not null check (qtype in ('single_choice', 'multiple_choice', 'true_false',
                                              'fill_blank', 'short_answer', 'composite')),
  difficulty   smallint not null default 2 check (difficulty between 1 and 3),
  content      jsonb not null default '{}'::jsonb check (jsonb_typeof(content) = 'object'),
  status       text not null default 'pending'
                 check (status in ('pending', 'kept', 'skipped', 'imported', 'failed')),
  flags        text[] not null default '{}'
                 check (flags <@ array['cross_page', 'merged_cross_page', 'has_figure', 'has_formula',
                                        'answer_missing', 'blank_mismatch', 'qno_gap', 'low_confidence',
                                        'dup_in_job', 'dup_in_bank', 'truncated', 'no_analysis',
                                        'ai_analysis']),
  confidence   real check (confidence is null or (confidence >= 0 and confidence <= 1)),
  source_quote text,
  note         text,
  error        text,
  content_hash text,
  question_id  uuid references public.questions(id) on delete set null,
  version_id   uuid references public.question_versions(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (job_id, page_no, seq)
);

comment on table public.import_job_items is '解析出的单题：status=imported 是入库幂等锚点，重复入库会被跳过';
comment on column public.import_job_items.flags is '需人工注意的点：跨页/含图/含公式/缺答案/空位不匹配/跳号/低置信/重复';
comment on column public.import_job_items.source_quote is '原文片段：让教师能一键核对模型有没有编造，是抑制幻觉最有效的手段';
comment on column public.import_job_items.content_hash is 'md5(规范化题干+答案)：卷内去重与跨任务查重的依据（只提示，不拦截）';
comment on column public.import_job_items.status is 'pending 待定 / kept 纳入入库 / skipped 不入库 / imported 已生成草稿 / failed 入库失败';

create index idx_import_job_items_job on public.import_job_items (job_id, page_no, seq);
create index idx_import_job_items_hash on public.import_job_items (content_hash);
create index idx_import_job_items_q on public.import_job_items (question_id)
  where question_id is not null;

create trigger trg_import_job_items_touch before update on public.import_job_items
  for each row execute function public.touch_updated_at();

-- ============ 归属判定 + RLS ============
-- 三张表共用一个归属口径：本人 / 本校学校管理员 / 系统管理员。
-- 它是 security definer（内部要读 import_jobs，若以内联者的权限跑会撞上同一套策略形成递归），
-- 但仍必须给 authenticated 授 execute——策略表达式是按调用者身份做权限检查的。
create or replace function public.is_import_job_owner(p_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from import_jobs j
    where j.id = p_job_id
      and (
        j.created_by = auth.uid()
        or public.is_admin()
        or exists (
          select 1 from profiles p
          join user_roles r on r.user_id = p.user_id
          where p.user_id = auth.uid() and r.role = 'school_admin' and p.school_id = j.school_id
        )
      )
  );
$$;

alter table public.import_jobs enable row level security;
alter table public.import_job_pages enable row level security;
alter table public.import_job_items enable row level security;

drop policy if exists select_owner on public.import_jobs;
create policy select_owner on public.import_jobs for select to authenticated
  using (
    created_by = (select auth.uid())
    or (select public.is_admin())
    or exists (
      select 1 from profiles p
      join user_roles r on r.user_id = p.user_id
      where p.user_id = (select auth.uid()) and r.role = 'school_admin' and p.school_id = import_jobs.school_id
    )
  );

drop policy if exists select_owner on public.import_job_pages;
create policy select_owner on public.import_job_pages for select to authenticated
  using (public.is_import_job_owner(job_id));

drop policy if exists select_owner on public.import_job_items;
create policy select_owner on public.import_job_items for select to authenticated
  using (public.is_import_job_owner(job_id));

revoke all on public.import_jobs, public.import_job_pages, public.import_job_items from anon, authenticated;
grant select on public.import_jobs, public.import_job_pages, public.import_job_items to authenticated;

revoke execute on function public.is_import_job_owner(uuid) from public, anon;
grant execute on function public.is_import_job_owner(uuid) to authenticated;
