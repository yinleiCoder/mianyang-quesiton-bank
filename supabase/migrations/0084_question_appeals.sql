-- 0084: 题目申诉 —— 教师对已发布题提出异议、三方对话、受理即下线整改。
--
-- 接在 0066 的 question_reports 上，**不另起一张表**（数据模型 90% 重合，另起一张
-- 要把 version_id 那类教训再踩一遍）。补的是三样东西：
--
--   ① 多方对话（question_report_messages）—— 0066 是单向的：一条举报 + 一条处理说明，
--      而申诉要的是"和出题人及审题人**沟通**"。
--   ② 可见性扩到三方：申诉人 / 本题出题人 / 本题的**审题人**。
--   ③ 出口接回现有审批链。
--
-- 用户口径（2026-09-30 逐条拍板）：
--   - 判定人 = **作者 + 本题审题人**（学校管理员/系统管理员仍是兜底，沿用 0066 的
--     "作者一离职这条就永远悬着"那条理由）。
--   - accepted = **立刻下线**："对于错题、争议题，学生不应该练到，应该立马下线整改、
--     重新走审批流程改版"。所以受理时会写一条**已决**的下线记录（kind='offline'），
--     让这次下线在 /admin/reviews 与题目历史上与其它下线长得一样、查得到是谁为什么。
--   - 整改入库后**自动恢复上线**：下线的原因就是内容有问题，而新版本刚被两级审过
--     （见本文件最后一节对 review_decide 的改动）。
--
-- **这条设计的全部价值：它没有新增任何一条能改到已发布内容的路径。**
-- 申诉只是"说"；改还是原来那条链（create_edit_draft → 提交 → 两级审批）。
-- 唯一放宽的是 create_edit_draft 对"下线中不能改版"的拦截 —— 不放宽作者就没法整改。
--
-- 学生侧的纠错**照旧**：可见性仍只到作者/学校管理员/系统管理员，处置仍是
-- resolved（已处理）。教师提交的才叫申诉，两者靠 profiles.identity 区分，
-- 不加列（用户口径：教师身份不用加列）。

-- =====================================================================
-- 1) 状态机：open → resolved（学生纠错）/ accepted / rejected / withdrawn
-- =====================================================================
alter table public.question_reports drop constraint question_reports_status_check;
alter table public.question_reports add constraint question_reports_status_check
  check (status in ('open', 'resolved', 'accepted', 'rejected', 'withdrawn'));
comment on column public.question_reports.status is
  'open 待处理；resolved = 学生纠错·作者已处理；accepted = 申诉受理（题已下线，等作者整改）；rejected = 申诉驳回；withdrawn = 提交人自己撤回';

-- =====================================================================
-- 2) 多方对话
-- =====================================================================
create table public.question_report_messages (
  id         uuid primary key default gen_random_uuid(),
  report_id  uuid not null references public.question_reports(id) on delete cascade,
  -- 与 question_reports.reporter_id 同口径：人注销后话还在（这段往来本身就是记录）
  author_id  uuid references auth.users(id) on delete set null,
  body       text not null,
  created_at timestamptz not null default now(),
  -- 对话不像投诉正文那样需要"信息量"，一个字也算回话；上限 1000 防长文粘贴
  constraint question_report_messages_body_len check (char_length(btrim(body)) between 1 and 1000)
);
comment on table public.question_report_messages is
  '反馈/申诉下的往来消息。可见性跟随所属反馈行（申诉人 / 本题作者 / 本题审题人），结案后不可再发言；不可改不可删';

create index question_report_messages_report_idx
  on public.question_report_messages (report_id, created_at);

-- =====================================================================
-- 3) 三个判定（都在 SECURITY DEFINER 里查别的表，必须 definer，
--    否则会被那些表的 RLS 挡成"永远 false"）
-- =====================================================================
-- 本题的审题人 = 在 approvals 上实际拍过板的人（decided_by）。
-- 含组长与市级专家两级，也含下线/恢复的决策人 —— "审过这道题的人"就是这个意思。
create or replace function public.is_question_reviewer(p_question_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from approvals a
    where a.question_id = p_question_id
      and a.decided_by = (select auth.uid())
  );
$$;

-- 教师提交的反馈 = 申诉。用它把"审题人可见"限定在申诉上：
-- 学生纠错（"第 3 题标点错了"）不该灌进组长/专家的待办里。
create or replace function public.is_teacher_appeal(p_report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from question_reports r
    join profiles p on p.user_id = r.reporter_id
    where r.id = p_report_id and p.identity = 'teacher'
  );
$$;

-- 看得见这条反馈的人：提交人本人 / 作者与学校管理员与系统管理员 / 本题审题人（仅申诉）
create or replace function public.can_view_question_report(p_report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from question_reports r
    where r.id = p_report_id
      and (
        r.reporter_id = (select auth.uid())
        or public.can_handle_question_report(r.question_id)
        or (public.is_question_reviewer(r.question_id) and public.is_teacher_appeal(r.id))
      )
  );
$$;

-- 能判定（受理/驳回）的人：与看得见相比少一个"提交人本人"—— 自己的申诉自己不能判，
-- 只能撤回
create or replace function public.can_judge_question_report(p_report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from question_reports r
    where r.id = p_report_id
      and (
        public.can_handle_question_report(r.question_id)
        or (public.is_question_reviewer(r.question_id) and public.is_teacher_appeal(r.id))
      )
  );
$$;

-- 能发言：看得见 + 未结案。结案后关闭对话，终态才有意义。
create or replace function public.can_post_question_report_message(p_report_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from question_reports r
    where r.id = p_report_id
      and r.status = 'open'
      and public.can_view_question_report(r.id)
  );
$$;

-- =====================================================================
-- 4) 策略：反馈行改成按行判定；对话表跟随
-- =====================================================================
drop policy if exists qr_select on public.question_reports;
create policy qr_select on public.question_reports
  for select to authenticated
  using (public.can_view_question_report(id));

-- 原来只放行"能处理的"；现在审题人也要能改（受理/驳回就写在这张表上）
drop policy if exists qr_update on public.question_reports;
create policy qr_update on public.question_reports
  for update to authenticated
  using (public.can_judge_question_report(id))
  with check (public.can_judge_question_report(id));

alter table public.question_report_messages enable row level security;

drop policy if exists qrm_select on public.question_report_messages;
create policy qrm_select on public.question_report_messages
  for select to authenticated
  using (public.can_view_question_report(report_id));

drop policy if exists qrm_insert on public.question_report_messages;
create policy qrm_insert on public.question_report_messages
  for insert to authenticated
  with check (author_id = (select auth.uid()) and public.can_post_question_report_message(report_id));

-- 不建 update/delete 策略：说出去的话是记录的一部分，不可改不可删（与反馈行同口径）

-- =====================================================================
-- 5) 新 RPC
-- =====================================================================
create or replace function public.post_question_report_message(p_report_id uuid, p_body text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_body text := btrim(coalesce(p_body, ''));
  v_id uuid;
begin
  if not public.can_post_question_report_message(p_report_id) then
    raise exception '无权在这条反馈下发言（或它已结案）' using errcode = '42501';
  end if;
  if char_length(v_body) < 1 then
    raise exception '说点什么吧' using errcode = '22023';
  end if;
  if char_length(v_body) > 1000 then
    raise exception '消息过长（最多 1000 字）' using errcode = '22023';
  end if;
  insert into question_report_messages (report_id, author_id, body)
  values (p_report_id, v_uid, v_body)
  returning id into v_id;
  -- 有新回复要浮到列表前面；也当作"这条还在动"的信号
  update question_reports set updated_at = now() where id = p_report_id;
  -- 不写 audit：对话内容本身就是留痕，审计表只记状态变更
  return v_id;
end;
$$;

create or replace function public.list_question_report_messages(p_report_id uuid)
returns table(id uuid, author_id uuid, body text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_uid();
  if not public.can_view_question_report(p_report_id) then
    raise exception '无权查看这条反馈' using errcode = '42501';
  end if;
  return query
  select m.id, m.author_id, m.body, m.created_at
  from question_report_messages m
  where m.report_id = p_report_id
  order by m.created_at;
end;
$$;

-- 判定：受理（→ 立即下线，等作者整改）或驳回。必须写说明。
create or replace function public.judge_question_report(
  p_report_id uuid, p_accept boolean, p_note text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_r question_reports%rowtype;
  v_offlined boolean := false;
begin
  select * into v_r from question_reports where id = p_report_id;
  if not found then
    raise exception '反馈不存在';
  end if;
  if v_r.status <> 'open' then
    raise exception '这条反馈已经结案';
  end if;
  if not public.can_judge_question_report(p_report_id) then
    raise exception '只有本题作者、审题人、学校管理员可以判定' using errcode = '42501';
  end if;
  if v_note is null then
    raise exception '请写一句判定说明，申诉人会看到它' using errcode = '22023';
  end if;

  if p_accept then
    -- 受理即下线（用户口径）：错题、争议题不该继续被学生练到。
    -- 复用现成的下线记录形态（kind='offline' 且已决），/admin/reviews 上查得到。
    update questions set state = 'offline'
     where id = v_r.question_id and state = 'live';
    v_offlined := found;
    if v_offlined then
      insert into approvals
        (kind, version_id, question_id, stage, state, assigned_user_ids, decided_by, decided_at, comment)
      values
        ('offline', null, v_r.question_id, 'group', 'approved', '{}'::uuid[], v_uid, now(), v_note);
    end if;
  end if;

  update question_reports
     set status = case when p_accept then 'accepted' else 'rejected' end,
         resolve_note = v_note,
         resolved_by = v_uid,
         resolved_at = now(),
         updated_at = now()
   where id = p_report_id and status = 'open';
  if not found then
    raise exception '这条反馈已经结案';
  end if;

  perform public.audit(
    case when p_accept then 'accept_report_offline' else 'reject_report' end,
    v_r.question_id, v_r.version_id,
    jsonb_build_object('report_id', p_report_id, 'offlined', v_offlined, 'note', v_note));
end;
$$;

-- 撤回：提交人本人在未结案时收回。顺带补上 0066 的一个死角 ——
-- 部分唯一索引禁止同一人对同一题同时开两条反馈，而此前没有任何撤销入口，
-- 提错了就再也提不了。
create or replace function public.withdraw_question_report(p_report_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_r question_reports%rowtype;
begin
  select * into v_r from question_reports where id = p_report_id;
  if not found then
    raise exception '反馈不存在';
  end if;
  if v_r.reporter_id is distinct from v_uid then
    raise exception '只有提交人本人可以撤回' using errcode = '42501';
  end if;
  if v_r.status <> 'open' then
    raise exception '这条反馈已经结案';
  end if;
  update question_reports
     set status = 'withdrawn', resolved_by = null, resolved_at = now(), updated_at = now()
   where id = p_report_id and status = 'open';
  if not found then
    raise exception '这条反馈已经结案';
  end if;
  perform public.audit('withdraw_question_report', v_r.question_id, v_r.version_id,
    jsonb_build_object('report_id', p_report_id));
end;
$$;

-- =====================================================================
-- 6) 改现有 RPC：把"审题人"接进可见面
-- =====================================================================
-- 处理（resolved）**只服务学生纠错**。教师申诉必须走 judge ——
-- 否则"受理即下线"这条就没意义了（点一下已处理，错题还在线上）。
create or replace function public.resolve_question_report(
  p_report_id uuid, p_status text, p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_qid uuid;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  if p_status not in ('open', 'resolved') then
    raise exception '状态不合法' using errcode = '22023';
  end if;

  select question_id into v_qid from question_reports where id = p_report_id;
  if not found then
    raise exception '反馈不存在';
  end if;
  if not public.can_handle_question_report(v_qid) then
    raise exception '只有本题作者或学校管理员可以处理反馈' using errcode = '42501';
  end if;
  if public.is_teacher_appeal(p_report_id) then
    raise exception '这是教师申诉，请用「受理并下线」或「驳回」处理' using errcode = '22023';
  end if;

  -- 标记为已处理时**必须**留言：作者一句"已修订"或"确认无误"是学生收到的唯一回音，
  -- 不写就等于石沉大海（学生端能看到这句话）。
  if p_status = 'resolved' and v_note is null then
    raise exception '请写一句处理说明，学生会看到它' using errcode = '22023';
  end if;

  update question_reports
     set status = p_status,
         resolve_note = case when p_status = 'resolved' then v_note else null end,
         resolved_by = case when p_status = 'resolved' then v_uid else null end,
         resolved_at = case when p_status = 'resolved' then now() else null end,
         updated_at = now()
   where id = p_report_id;
end;
$$;

-- 某题的反馈列表：从"整题一刀切"改成**按行过滤** —— 审题人只看得见教师申诉，
-- 学生纠错仍然只给作者。门还是要拦：完全无关的人给一句明确报错，不是空列表。
create or replace function public.list_question_reports(p_question_id uuid)
returns table(
  id uuid, version_id uuid, version_no integer, is_current_version boolean,
  reporter_id uuid, category text, content text, status text,
  resolve_note text, resolved_by uuid, resolved_at timestamptz, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_uid();
  if not (public.can_handle_question_report(p_question_id)
          or public.is_question_reviewer(p_question_id)) then
    raise exception '只有本题作者、审题人或学校管理员可以查看反馈' using errcode = '42501';
  end if;

  return query
  select r.id, r.version_id, v.version_no,
         (v.id = q.current_published_version_id) as is_current_version,
         r.reporter_id, r.category, r.content, r.status,
         r.resolve_note, r.resolved_by, r.resolved_at, r.created_at
  from question_reports r
  join question_versions v on v.id = r.version_id
  join questions q on q.id = r.question_id
  where r.question_id = p_question_id
    and public.can_view_question_report(r.id)
  order by (r.status = 'open') desc, r.created_at desc;
end;
$$;

-- 收件箱：作者看得见自己题的**全部**反馈；审题人只看得见自己审过的题上的**教师申诉**
create or replace function public.question_report_inbox(
  p_status text default 'open', p_limit integer default 50, p_offset integer default 0)
returns table(
  id uuid, question_id uuid, version_id uuid, version_no integer,
  is_current_version boolean, question_state text, course_node_id uuid,
  reporter_id uuid, category text, content text, status text,
  resolve_note text, resolved_by uuid, resolved_at timestamptz,
  created_at timestamptz, total_count bigint)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
begin
  perform public.require_uid();

  return query
  select r.id, r.question_id, r.version_id, v.version_no,
         (v.id = q.current_published_version_id) as is_current_version,
         q.state, q.course_node_id,
         r.reporter_id, r.category, r.content, r.status,
         r.resolve_note, r.resolved_by, r.resolved_at, r.created_at,
         count(*) over () as total_count
  from question_reports r
  join questions q on q.id = r.question_id
  join question_versions v on v.id = r.version_id
  where (
      public.can_handle_question_report(r.question_id)
      or (public.is_question_reviewer(r.question_id) and public.is_teacher_appeal(r.id))
    )
    -- p_status 传 'all' 时不加过滤；其余按字面量过滤
    and (p_status = 'all' or r.status = p_status)
  order by (r.status = 'open') desc, r.created_at desc
  limit v_limit offset v_offset;
end;
$$;

-- 侧栏徽标：审题人也该看到"有申诉等我表态"
create or replace function public.count_open_question_reports()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select count(*)
  from question_reports r
  where r.status = 'open'
    and (
      public.can_handle_question_report(r.question_id)
      or (public.is_question_reviewer(r.question_id) and public.is_teacher_appeal(r.id))
    );
$$;

-- =====================================================================
-- 7) 出口接回审批链：让作者能整改，让整改能回到线上
-- =====================================================================
-- 7.1 下线中的题也允许作者改版。
-- 原来拦着（"下线期间请先恢复上线"）—— 但申诉受理会**立即**下线，作者必须能马上整改，
-- 否则流程死在这里。放宽的副作用：普通下线场景也可以直接改版了（改版本来就是全链审批，
-- 且题目上下线由恢复流程掌握，不会因为改版被悄悄拉上线 —— 恢复只发生在下面 7.2 那一种情况）。
create or replace function public.create_edit_draft(
  p_question_id uuid, p_qtype text, p_difficulty smallint,
  p_content jsonb, p_tag_ids uuid[] default '{}'::uuid[])
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_q questions%rowtype;
  v_frozen boolean;
  v_version uuid;
  v_next_no int;
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
  select * into v_q from questions where id = p_question_id;
  if not found then
    raise exception '题目不存在';
  end if;
  if v_q.creator_id <> v_uid then
    raise exception '只有作者本人能为已入库题发起改版';
  end if;
  if v_q.current_published_version_id is null then
    raise exception '题目尚未入库，请直接编辑草稿';
  end if;
  if exists (
    select 1 from question_versions v
    where v.question_id = p_question_id and v.status in ('draft','pending_group','pending_city','returned')
  ) then
    raise exception '该题已有在审/未完成的修改版本，请先处理它';
  end if;
  select is_frozen into v_frozen from subject_nodes where id = v_q.course_node_id;
  if v_frozen then
    raise exception '该课程节点已冻结，不能为该题发起新版本';
  end if;

  perform public.validate_question_content(p_qtype, p_content);
  if p_tag_ids is null then p_tag_ids := '{}'::uuid[]; end if;
  perform public.check_tags_exist(p_tag_ids);

  select coalesce(max(version_no), 0) + 1 into v_next_no from question_versions where question_id = p_question_id;
  insert into question_versions
    (question_id, version_no, change_type, base_version_id, status, qtype, difficulty, content,
     search_text, created_by)
  values
    (p_question_id, v_next_no, 'edit', v_q.current_published_version_id, 'draft',
     p_qtype, p_difficulty, p_content, public.question_search_text(p_content), v_uid)
  returning id into v_version;

  perform public.replace_version_tags(v_version, p_tag_ids);
  perform public.sync_version_media(v_version, p_content);
  perform public.audit('create_edit_draft', p_question_id, v_version,
    jsonb_build_object('version_no', v_next_no, 'base', v_q.current_published_version_id));
  return v_version;
end;
$$;

-- 7.2 整改版本入库 = 自动恢复上线。
-- 唯一与 0058 版不同的就是最后那个 update 多了 state —— 其余逐字未动。
-- 口径：题被下线的原因就是内容有问题，而新版本刚被两级审过，没有理由还压着。
-- 代价（明确记下）：非申诉场景下人工下线、之后又改版的题，也会跟着上线。
create or replace function public.review_decide(
  p_approval_id uuid, p_pass boolean, p_comment text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_approval approvals%rowtype;
  v_version question_versions%rowtype;
  v_q questions%rowtype;
  v_expert uuid[];
begin
  select * into v_approval from approvals where id = p_approval_id;
  if not found then
    raise exception '审批任务不存在';
  end if;
  if v_approval.state <> 'waiting' then
    raise exception '该任务已被处理';
  end if;
  -- 处理人是一组人（岗位池）：池内任一人都有决定权，谁先处理算谁的
  if not (v_uid = any(v_approval.assigned_user_ids)) then
    raise exception '该任务不在你的待办中（可能已转派或已被他人处理）';
  end if;

  if not p_pass then
    if p_comment is null or trim(p_comment) = '' then
      raise exception '退回时必须填写审批意见';
    end if;
    update approvals set state = 'returned', decided_by = v_uid, decided_at = now(), comment = p_comment
    where id = p_approval_id and state = 'waiting';
    if not found then
      raise exception '该任务已被处理';
    end if;
    update approvals set state = 'cancelled'
    where state = 'waiting' and id <> p_approval_id
      and (version_id = v_approval.version_id
           or (v_approval.version_id is null and question_id = v_approval.question_id and kind = v_approval.kind));
    if v_approval.version_id is not null then
      update question_versions set status = 'returned'
      where id = v_approval.version_id and status in ('pending_group', 'pending_city');
    end if;
    perform public.audit('review_return', v_approval.question_id, v_approval.version_id,
      jsonb_build_object('stage', v_approval.stage, 'comment', p_comment));
    return;
  end if;

  select * into v_q from questions where id = v_approval.question_id;

  if v_approval.kind in ('offline', 'restore') then
    update approvals set state = 'approved', decided_by = v_uid, decided_at = now(), comment = p_comment
    where id = p_approval_id and state = 'waiting';
    if not found then
      raise exception '该任务已被处理';
    end if;
    update questions set state = case when v_approval.kind = 'offline' then 'offline' else 'live' end
    where id = v_q.id;
    perform public.audit(case when v_approval.kind = 'offline' then 'approve_offline' else 'approve_restore' end,
      v_q.id, null, jsonb_build_object('comment', p_comment));
    return;
  end if;

  select * into v_version from question_versions where id = v_approval.version_id;
  if v_version.status <> 'pending_' || v_approval.stage then
    raise exception '版本当前状态与任务环节不匹配';
  end if;

  if v_approval.stage = 'group' then
    update approvals set state = 'approved', decided_by = v_uid, decided_at = now(), comment = p_comment
    where id = p_approval_id and state = 'waiting';
    if not found then
      raise exception '该任务已被处理';
    end if;
    update question_versions set status = 'pending_city' where id = v_version.id;
    -- 市级池：优先给「非组长、非作者」的专家；一个都不剩时回归作者本人（0057 的口径）
    v_expert := public.route_city_experts(v_q.school_id, v_q.course_node_id, v_version.created_by, v_uid);
    insert into approvals (kind, version_id, question_id, stage, assigned_user_ids)
    values ('content', v_version.id, v_q.id, 'city', v_expert);
    perform public.audit('approve_group', v_q.id, v_version.id,
      jsonb_build_object('city_experts', v_expert, 'comment', p_comment));
    return;
  end if;

  update approvals set state = 'approved', decided_by = v_uid, decided_at = now(), comment = p_comment
  where id = p_approval_id and state = 'waiting';
  if not found then
    raise exception '该任务已被处理';
  end if;
  update question_versions
  set status = 'published', published_at = now()
  where id = v_version.id and status = 'pending_city';
  if not found then
    raise exception '版本入库状态变更失败，请刷新后重试';
  end if;
  perform set_config('app.allow_supersede', 'on', true);
  update question_versions set status = 'superseded'
  where question_id = v_q.id and status = 'published' and id <> v_version.id;
  perform set_config('app.allow_supersede', 'off', true);
  -- 0084：下线中的题，整改版本入库即恢复上线（见文件头）
  update questions
     set current_published_version_id = v_version.id,
         state = case when state = 'offline' then 'live' else state end
   where id = v_q.id;
  perform public.audit('approve_city_publish', v_q.id, v_version.id,
    jsonb_build_object('comment', p_comment));
end;
$$;

-- =====================================================================
-- 8) 授权收口
-- =====================================================================
-- 被策略引用的函数**必须**给 authenticated EXECUTE：策略表达式以查询者身份求值，
-- 不给就会在运行时 permission denied（0066 记过这条）。
revoke all on function public.is_question_reviewer(uuid) from public, anon;
revoke all on function public.is_teacher_appeal(uuid) from public, anon;
revoke all on function public.can_view_question_report(uuid) from public, anon;
revoke all on function public.can_judge_question_report(uuid) from public, anon;
revoke all on function public.can_post_question_report_message(uuid) from public, anon;
grant execute on function public.is_question_reviewer(uuid) to authenticated;
grant execute on function public.is_teacher_appeal(uuid) to authenticated;
grant execute on function public.can_view_question_report(uuid) to authenticated;
grant execute on function public.can_judge_question_report(uuid) to authenticated;
grant execute on function public.can_post_question_report_message(uuid) to authenticated;

revoke all on function public.post_question_report_message(uuid, text) from public, anon;
revoke all on function public.list_question_report_messages(uuid) from public, anon;
revoke all on function public.judge_question_report(uuid, boolean, text) from public, anon;
revoke all on function public.withdraw_question_report(uuid) from public, anon;
grant execute on function public.post_question_report_message(uuid, text) to authenticated;
grant execute on function public.list_question_report_messages(uuid) to authenticated;
grant execute on function public.judge_question_report(uuid, boolean, text) to authenticated;
grant execute on function public.withdraw_question_report(uuid) to authenticated;

revoke all on public.question_report_messages from anon, authenticated;
grant select, insert on public.question_report_messages to authenticated;

notify pgrst, 'reload schema';
