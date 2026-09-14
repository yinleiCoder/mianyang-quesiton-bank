-- 0003: 题目/版本/标签/审批/审计/媒体 及全部约束、索引、触发器
-- 设计要点：逻辑题(questions)与不可变内容快照(question_versions)分层；
-- 上下线是题目级状态(state)，下线/恢复以 approval(kind=offline/restore) 事件表达，不做内容版本。

-- ============ 逻辑题目 ============
create table public.questions (
  id                           uuid primary key default gen_random_uuid(),
  school_id                    uuid not null references public.schools(id) on delete restrict,
  creator_id                   uuid not null references auth.users(id),
  course_node_id               uuid not null references public.subject_nodes(id) on delete restrict,
  state                        text not null default 'live' check (state in ('live','offline')),
  current_published_version_id uuid, -- FK 在 question_versions 建表后回填
  created_at                   timestamptz not null default now(),
  updated_at                   timestamptz not null default now()
);
comment on table public.questions is '逻辑题主档（含归属学校/作者/课程节点/上下线）';

create trigger trg_questions_touch before update on public.questions
  for each row execute function public.touch_updated_at();

-- ============ 题目版本（不可变快照） ============
create table public.question_versions (
  id             uuid primary key default gen_random_uuid(),
  question_id    uuid not null references public.questions(id) on delete cascade,
  version_no     int not null,
  change_type    text not null check (change_type in ('create','edit','admin_direct')),
  base_version_id uuid references public.question_versions(id) on delete set null, -- 基于哪个已发布版本起草
  status         text not null default 'draft'
                 check (status in ('draft','pending_group','pending_city','published','superseded','returned','retracted')),
  qtype          text not null check (qtype in ('single_choice','multiple_choice','true_false','fill_blank','short_answer','composite')),
  difficulty     smallint not null default 2 check (difficulty between 1 and 3), -- 1易 2中 3难
  content        jsonb not null default '{}'::jsonb check (jsonb_typeof(content) = 'object'),
  search_text    text not null default '',   -- 题干纯文本，提交时生成，供 pg_trgm 检索
  created_by     uuid not null references auth.users(id),
  submitted_at   timestamptz,
  published_at   timestamptz,
  created_at     timestamptz not null default now()
);
comment on table public.question_versions is '不可变内容快照；状态机 draft→pending_group→pending_city→published，终态 returned/retracted/superseded';

create unique index uq_question_versions_no on public.question_versions (question_id, version_no);
-- 物理防并发双流：每题至多一个"在流"版本（草稿/待审/退回 互斥）
create unique index uq_questions_one_inflight
  on public.question_versions (question_id)
  where status in ('draft','pending_group','pending_city','returned');

-- 版本行兜底保护（角色级 revoke 已封死客户端直写；此处防函数误改终态）：
-- 已发布/已替换/已撤回版本任何角色不可再改；删除仅允许纯草稿
-- （注意：pending_* 的合法状态迁移只发生在安全函数内，须放行）
create or replace function public.guard_version_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status in ('published', 'superseded', 'retracted') then
    raise exception '该状态的版本不可直接修改';
  end if;
  if tg_op = 'DELETE' and old.status <> 'draft' then
    raise exception '只能删除纯草稿版本';
  end if;
  return new;
end;
$$;

create trigger trg_versions_guard
  before update or delete on public.question_versions
  for each row execute function public.guard_version_immutable();

-- 回填循环外键：questions.current_published_version_id
alter table public.questions
  add constraint fk_questions_current_version
  foreign key (current_published_version_id) references public.question_versions(id) on delete set null;

create index idx_questions_course_node on public.questions (course_node_id);
create index idx_questions_school on public.questions (school_id);
create index idx_questions_creator on public.questions (creator_id);
create index idx_questions_live on public.questions (id) where state = 'live';
create index idx_qversions_question on public.question_versions (question_id, version_no desc);
create index idx_qversions_search on public.question_versions
  using gin (search_text gin_trgm_ops)
  where status = 'published';

-- ============ 知识点标签（教师自由创建，唯一忽略大小写） ============
create table public.tags (
  id         uuid primary key default gen_random_uuid(),
  name       citext not null unique,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table public.version_tags (
  version_id  uuid not null references public.question_versions(id) on delete cascade,
  tag_id      uuid not null references public.tags(id),
  tag_name    citext not null, -- 建版本时的快照：改名/合并不影响历史展示
  primary key (version_id, tag_id)
);
create index idx_version_tags_tag on public.version_tags (tag_id);

-- ============ 审批任务/记录 ============
create table public.approvals (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null default 'content' check (kind in ('content','offline','restore')),
  version_id       uuid references public.question_versions(id) on delete cascade,
  question_id      uuid not null references public.questions(id) on delete cascade,
  stage            text not null check (stage in ('group','city')),
  state            text not null default 'waiting' check (state in ('waiting','approved','returned','cancelled')),
  assigned_user_id uuid references auth.users(id), -- 快照化指派；NULL=待管理员指派
  decided_by       uuid references auth.users(id),
  decided_at       timestamptz,
  comment          text,
  created_at       timestamptz not null default now(),
  check ((kind = 'content') = (version_id is not null))
);
comment on table public.approvals is '审批任务：assignee 于创建时刻快照（树/任命后续变动不影响在途任务）；content 两阶段流转，offline/restore 仅组长级事件';

-- 每版本每环节至多一个未决任务
create unique index uq_approvals_one_waiting
  on public.approvals (version_id, stage)
  where state = 'waiting';
-- 上下线事件：同一题同时至多一个未决非内容事件
create unique index uq_approvals_one_noncontent
  on public.approvals (question_id, kind)
  where state = 'waiting' and kind <> 'content';

create index idx_approvals_inbox on public.approvals (assigned_user_id) where state = 'waiting';
create index idx_approvals_question on public.approvals (question_id, created_at desc);
create index idx_approvals_version on public.approvals (version_id);

-- 审批记录兜底保护：已决(approved/returned/cancelled)任何角色均不可再改/删
-- （waiting 行仅由安全函数推进）
create or replace function public.guard_approval_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.state in ('approved', 'returned', 'cancelled') then
    raise exception '已决审批记录不可修改或删除';
  end if;
  return new;
end;
$$;

create trigger trg_approvals_guard
  before update or delete on public.approvals
  for each row execute function public.guard_approval_immutable();

-- ============ 审计日志（与被审计操作同事务写入） ============
create table public.audit_log (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id),
  question_id uuid references public.questions(id) on delete set null,
  version_id  uuid references public.question_versions(id) on delete set null,
  action      text not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
create index idx_audit_question on public.audit_log (question_id, created_at desc);
create index idx_audit_user on public.audit_log (user_id, created_at desc);

-- ============ 媒体对象（阿里云 OSS 引用登记） ============
create table public.media_objects (
  id          uuid primary key default gen_random_uuid(),
  object_key  text not null unique,
  bucket      text not null,
  size        bigint not null default 0 check (size >= 0),
  mime        text,
  sha256      text,
  uploaded_by uuid not null references auth.users(id),
  created_at  timestamptz not null default now()
);
create table public.version_media (
  version_id      uuid not null references public.question_versions(id) on delete cascade,
  media_object_id uuid not null references public.media_objects(id) on delete cascade,
  primary key (version_id, media_object_id)
);
create index idx_version_media_media on public.version_media (media_object_id);
comment on table public.version_media is '版本内容引用的媒体（每次保存内容时同步），GC 以它为准';

-- =====================================================================
-- 内容契约校验 / 文本与媒体提取 helper（纯函数，RPC 与管理员体检共用）
-- =====================================================================

-- 校验一个文本块列表，返回拼接文本
create or replace function public.v_blocks_text(blocks jsonb)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  b jsonb;
  out_text text := '';
begin
  if blocks is null or jsonb_typeof(blocks) <> 'array' then
    raise exception '块列表必须是数组';
  end if;
  for b in select * from jsonb_array_elements(blocks) loop
    if b ->> 't' = 'text' then
      if (b ->> 'text') is null then
        raise exception '文本块缺少 text 字段';
      end if;
      out_text := out_text || b ->> 'text' || ' ';
    elsif b ->> 't' = 'media' then
      if b ->> 'key' is null or b ->> 'kind' is null then
        raise exception '媒体块缺少 key/kind 字段';
      end if;
    else
      raise exception '未知块类型 %', b ->> 't';
    end if;
  end loop;
  return out_text;
end;
$$;

-- 校验单选/多选共用部分（answer.keys ⊆ options，key 唯一）
create or replace function public.v_choice(opt jsonb, ans jsonb, single boolean)
returns void
language plpgsql
immutable
set search_path = public
as $$
declare
  o jsonb;
  keys text[];
  k text;
begin
  if opt is null or jsonb_array_length(opt) < 2 then
    raise exception '选择题至少需要 2 个选项';
  end if;
  if jsonb_array_length(opt) > 26 then
    raise exception '选择题最多 26 个选项';
  end if;
  keys := '{}'::text[];
  for o in select * from jsonb_array_elements(opt) loop
    k := upper(o ->> 'key');
    if k is null or k = '' then
      raise exception '选项缺少 key';
    end if;
    if array_position(keys, k) is not null then
      raise exception '选项 key 重复: %', k;
    end if;
    keys := keys || k;
    perform public.v_blocks_text(o -> 'label');
  end loop;
  if ans is null or ans ->> 'type' <> 'choice' or ans -> 'keys' is null then
    raise exception '答案格式错误（应为 choice）';
  end if;
  if jsonb_array_length(ans -> 'keys') = 0 then
    raise exception '答案不能为空';
  end if;
  if single and jsonb_array_length(ans -> 'keys') <> 1 then
    raise exception '单选题必须且只能有一个正确答案';
  end if;
  for k in select jsonb_array_elements_text(ans -> 'keys') loop
    k := upper(k);
    if array_position(keys, k) is null then
      raise exception '答案 % 不在选项中', k;
    end if;
  end loop;
end;
$$;

-- 题干中空位数（连续 3+ 下划线）与填空答案数一致性
create or replace function public.v_blank_count(text_str text)
returns int
language sql
immutable
as $$
  select count(*)::int from regexp_matches(text_str, '_{3,}', 'g');
$$;

-- 校验某（非复合）子题/整题结构
create or replace function public.v_simple_question(qtype text, content jsonb)
returns void
language plpgsql
immutable
set search_path = public
as $$
declare
  stem_text text;
  ans jsonb := content -> 'answer';
begin
  stem_text := public.v_blocks_text(content -> 'stem');
  if length(trim(stem_text)) = 0 and content -> 'stem' is null or content -> 'stem' = '[]'::jsonb then
    raise exception '题干不能为空';
  end if;
  case qtype
    when 'single_choice' then
      perform public.v_choice(content -> 'options', ans, true);
    when 'multiple_choice' then
      perform public.v_choice(content -> 'options', ans, false);
    when 'true_false' then
      if ans is null or ans ->> 'type' <> 'tf' or ans -> 'value' is null then
        raise exception '判断题答案格式错误（应为 tf）';
      end if;
    when 'fill_blank' then
      if ans is null or ans ->> 'type' <> 'blank' or ans -> 'values' is null
         or jsonb_array_length(ans -> 'values') = 0 then
        raise exception '填空题答案格式错误（应为 blank）';
      end if;
      if public.v_blank_count(stem_text) <> jsonb_array_length(ans -> 'values') then
        raise exception '题干空位(______)数量与答案数量不一致';
      end if;
    when 'short_answer' then
      if ans is null or ans ->> 'type' <> 'text' or ans -> 'samples' is null
         or jsonb_array_length(ans -> 'samples') = 0 then
        raise exception '主观题需提供参考答案';
      end if;
    else
      raise exception '未知题型 %', qtype;
  end case;
end;
$$;

-- 整题（含复合题递归）结构校验；error 信息直接透传客户端
create or replace function public.validate_question_content(qtype text, content jsonb)
returns void
language plpgsql
immutable
set search_path = public
as $$
declare
  s jsonb;
  i int := 0;
begin
  if content is null or jsonb_typeof(content) <> 'object' then
    raise exception '题目内容格式错误';
  end if;
  if content ->> 'format_version' is null then
    raise exception '题目内容缺少 format_version';
  end if;
  if qtype = 'composite' then
    if content -> 'sub' is null or jsonb_array_length(content -> 'sub') = 0 then
      raise exception '复合题至少包含 1 个子题';
    end if;
    if jsonb_array_length(content -> 'sub') > 20 then
      raise exception '复合题子题最多 20 道';
    end if;
    for s in select * from jsonb_array_elements(content -> 'sub') loop
      i := i + 1;
      if s ->> 'type' is null then
        raise exception '子题 % 缺少题型', i;
      end if;
      if s ->> 'type' = 'composite' then
        raise exception '子题不能嵌套复合题';
      end if;
      perform public.v_simple_question(s ->> 'type', s);
    end loop;
    -- 材料题整体也需要题干
    perform public.v_blocks_text(content -> 'stem');
  else
    perform public.v_simple_question(qtype, content);
  end if;
end;
$$;

-- 提取可检索文本（题干 + 子题题干，不含选项/答案/解析，避免答案检索干扰）
create or replace function public.question_search_text(content jsonb)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  out_text text := '';
  s jsonb;
begin
  out_text := public.v_blocks_text(content -> 'stem');
  if content -> 'sub' is not null then
    for s in select * from jsonb_array_elements(content -> 'sub') loop
      out_text := out_text || ' ' || public.v_blocks_text(s -> 'stem');
    end loop;
  end if;
  return out_text;
end;
$$;

-- 递归收集 content 中所有媒体块 key（用于版本媒体引用登记）
create or replace function public.collect_media_keys(c jsonb)
returns setof text
language plpgsql
immutable
set search_path = public
as $$
declare
  k text;
  v jsonb;
  e jsonb;
begin
  if jsonb_typeof(c) = 'object' then
    if c ? 't' and c ->> 't' = 'media' and c ? 'key' then
      return next c ->> 'key';
      return;
    end if;
    for k, v in select * from jsonb_each(c) loop
      if jsonb_typeof(v) in ('object','array') then
        return query select public.collect_media_keys(v);
      end if;
    end loop;
  elsif jsonb_typeof(c) = 'array' then
    for e in select * from jsonb_array_elements(c) loop
      if jsonb_typeof(e) in ('object','array') then
        return query select public.collect_media_keys(e);
      end if;
    end loop;
  end if;
end;
$$;

-- 同步版本媒体引用（内容保存时调用：删旧插新，草稿也登记以保证 GC 不误删）
create or replace function public.sync_version_media(p_version_id uuid, p_content jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from version_media where version_id = p_version_id;
  insert into version_media (version_id, media_object_id)
  select p_version_id, m.id
  from public.collect_media_keys(p_content) k
  join media_objects m on m.object_key = k;
end;
$$;

-- 内部审计写入
create or replace function public.write_audit(p_action text, p_question_id uuid, p_version_id uuid, p_detail jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into audit_log (user_id, question_id, version_id, action, detail)
  values (auth.uid(), p_question_id, p_version_id, p_action, p_detail);
$$;
