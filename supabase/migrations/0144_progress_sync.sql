-- 0144: 跨设备同步「还没交的作答」（2026-11-06）
--
-- 用户反馈两条：
--   1. 考试进度在 Windows 与 Android 之间不同步；
--   2. 练习中途退出后，换台设备（或关掉软件再开）看不到刚才答到哪儿。
--
-- 根因是同一个：**交卷之前，作答只存在本机**。
--   · 考试：exam_answers 只在 submit_exam_attempt 那一次写入（0052），
--     考试过程中的作答只在本机 SharedPreferences（客户端 exam_draft_service.dart）。
--     换台设备虽然能看到同一场考试（attempt 在服务端），但一道题都看不见。
--   · 练习：只有「即时练习」每答一题就调 submit_practice_answer；
--     「批量练习」的草稿只存在内存里，「顺序练习」按 0090 一个字节都不回传，
--     退出即丢，跨设备更无从谈起。
--
-- 本迁移加两条**草稿通道**，只装「还没交的作答」，不碰任何统计口径：
--   · exam_attempts.draft_answers     {paper_item_id: answer}
--   · practice_sessions.draft_answers {question_id:    {answer, is_correct, self_mastered}}
--
-- 三条设计纪律：
--   1. **逐题合并，不是整卷覆盖**。两台设备各改各的题，不会互相盖掉；
--      客户端只发改过的那几道。
--   2. **交卷仍然走原路径**（exam_answers / practice_answers），判分、排行榜、
--      错题本、遗忘曲线的口径一个字没变。草稿表不进任何统计。
--   3. 草稿是**辅助**：写失败不挡答题，读不到按"全新作答"处理。

-- =====================================================================
-- 一、考试：交卷前的作答草稿
-- =====================================================================
alter table public.exam_attempts
  add column if not exists draft_answers jsonb not null default '{}'::jsonb;
alter table public.exam_attempts
  add column if not exists draft_updated_at timestamptz;

comment on column public.exam_attempts.draft_answers is
  '交卷前的作答草稿 {paper_item_id: answer}；save_exam_answers 逐题合并（0144）';
comment on column public.exam_attempts.draft_updated_at is
  '草稿最后一次写入时刻；客户端用它判断本机缓存与服务端哪份更新（0144）';

-- 逐题合并作答草稿。返回 {saved, draft_updated_at}。
-- p_answers 形状：{"<paper_item_id>": {answer json}, ...}；值为空对象 = 删掉这道题。
create or replace function public.save_exam_answers(
  p_attempt_id uuid,
  p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a exam_attempts%rowtype;
  v_key text;
  v_val jsonb;
  v_draft jsonb;
  v_n int := 0;
  v_at timestamptz;
begin
  select * into v_a from exam_attempts where id = p_attempt_id for update;
  if not found then raise exception '考试记录不存在'; end if;
  if v_a.user_id is distinct from v_uid then raise exception '这不是你的考试'; end if;

  -- 已经交卷：静默忽略。客户端有 800ms 节流，最后一批请求可能晚于交卷到达；
  -- 报错只会让答题页弹一句用户看不懂的话（答案其实已经写进 exam_answers 了）。
  if v_a.status <> 'in_progress' then
    return jsonb_build_object('saved', 0, 'draft_updated_at', v_a.draft_updated_at);
  end if;

  v_draft := coalesce(v_a.draft_answers, '{}'::jsonb);

  if p_answers is not null and jsonb_typeof(p_answers) = 'object' then
    for v_key, v_val in select e.key, e.value from jsonb_each(p_answers) e loop
      -- 题项 id 必须真属于这场考试。不是 uuid 的直接跳过（不抛，整批其它题还算数）
      if v_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        continue;
      end if;
      if not exists (
        select 1 from paper_items i
        where i.id = v_key::uuid and i.paper_version_id = v_a.paper_version_id
      ) then
        continue;
      end if;

      -- 空作答 = 把这道题从草稿里删掉（学生把填空清空了）
      if v_val is null or jsonb_typeof(v_val) <> 'object' or v_val = '{}'::jsonb then
        v_draft := v_draft - v_key;
      else
        v_draft := v_draft || jsonb_build_object(v_key, v_val);
      end if;
      v_n := v_n + 1;
    end loop;
  end if;

  update exam_attempts
  set draft_answers = v_draft, draft_updated_at = now()
  where id = p_attempt_id
  returning draft_updated_at into v_at;

  return jsonb_build_object('saved', v_n, 'draft_updated_at', v_at);
end;
$$;

-- 取回一场考试的作答草稿。交卷后一律返回空（成绩单读的是 exam_answers）。
create or replace function public.get_exam_drafts(p_attempt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a exam_attempts%rowtype;
begin
  select * into v_a from exam_attempts where id = p_attempt_id;
  if not found then raise exception '考试记录不存在'; end if;
  if v_a.user_id is distinct from v_uid then
    raise exception '这不是你的考试' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'status', v_a.status,
    'draft_answers', case when v_a.status = 'in_progress'
                          then coalesce(v_a.draft_answers, '{}'::jsonb)
                          else '{}'::jsonb end,
    'draft_updated_at', v_a.draft_updated_at);
end;
$$;

revoke all on function public.save_exam_answers(uuid, jsonb) from public, anon;
revoke all on function public.get_exam_drafts(uuid) from public, anon;
grant execute on function public.save_exam_answers(uuid, jsonb) to authenticated;
grant execute on function public.get_exam_drafts(uuid) to authenticated;

-- ---- 考试计时：离开考试页暂停，下次进来接着剩余时间考（2026-11-06 用户口径） ----
--
-- 在此之前 deadline_at 是起考那一刻定死的绝对时刻：退出考试页，
-- 倒计时照走，回来只剩一点点时间。现在改成**可变截止时刻**：
--   · 暂停：把剩余毫秒冻结进 remaining_ms，deadline_at 暂时不动；
--   · 继续：deadline_at = now() + remaining_ms，remaining_ms 清空。
--
-- ⚠ **切后台 / 关掉软件不算离开**（用户 2026-11-06 明确）：时间照走。
-- 客户端只在离开考试页（ExamPage.dispose）时调 pause，lifecycle 回调里不碰计时。
--
-- 恢复挂在**读路径**上而不是单独的 RPC：get_my_exam_attempt / start_exam_attempt
-- 读到 in_progress 就顺手接回去。旧客户端不会调 resume，不这么做它拿到的
-- deadline_at 还停在暂停那一刻，倒计时一进页面就归零，会**当场把卷子交掉**。
--
-- 客户端只读 deadline_at，ExamTimer 一个字都不用改；服务端本来就不校验截止时刻
-- （超时以交卷那一刻为准），这次只是把"提示"改成符合直觉的口径。

alter table public.exam_attempts
  add column if not exists remaining_ms bigint;

comment on column public.exam_attempts.remaining_ms is
  '暂停时冻结的剩余毫秒；NULL = 计时中。resume 用它重算 deadline_at（0144）';

-- 内部助手：暂停过的场次把 deadline_at 抬回"现在 + 剩余"，并清掉 remaining_ms。
-- 没有鉴权、只给下面的 definer 函数调用（执行权对客户端收回）。
--
-- **为什么读路径也要调它**：暂停是把"截止时刻"改成"剩余毫秒"两个字段写的。
-- 只升级了一半的学生（比如 Android 还是旧版）进考试页时不会调 resume，
-- 拿到的 deadline_at 还停在暂停那一刻——旧版倒计时一看已经到点，**立刻把卷子交掉**。
-- 所以 get_my_exam_attempt / start_exam_attempt 读到 in_progress 就顺手恢复一次。
create or replace function public._resume_exam_attempt_if_paused(p_attempt_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rem bigint;
begin
  select remaining_ms into v_rem
  from exam_attempts
  where id = p_attempt_id and status = 'in_progress'
  for update;
  if v_rem is null then return; end if;

  update exam_attempts
  set deadline_at = now() + v_rem * interval '1 millisecond',
      remaining_ms = null
  where id = p_attempt_id;
end;
$$;

revoke all on function public._resume_exam_attempt_if_paused(uuid)
  from public, anon, authenticated;

create or replace function public.pause_exam_attempt(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a exam_attempts%rowtype;
  v_rem bigint;
begin
  select * into v_a from exam_attempts where id = p_attempt_id for update;
  if not found then raise exception '考试记录不存在'; end if;
  if v_a.user_id is distinct from v_uid then
    raise exception '这不是你的考试' using errcode = '42501';
  end if;

  -- 已交卷 / 已作废：没什么可暂停的，照实返回
  if v_a.status <> 'in_progress' or v_a.remaining_ms is not null then
    return jsonb_build_object('status', v_a.status,
                              'remaining_ms', v_a.remaining_ms,
                              'deadline_at', v_a.deadline_at);
  end if;

  -- 截止时刻缺失（脏数据）：不冻结，维持客户端"不限时"的兜底
  if v_a.deadline_at is null then
    return jsonb_build_object('status', v_a.status,
                              'remaining_ms', null, 'deadline_at', null);
  end if;

  -- 最小为 0：已经过点的考试暂停后 resume 就是"立刻到点"，由客户端自动交卷
  v_rem := greatest(0, (extract(epoch from (v_a.deadline_at - now())) * 1000)::bigint);

  update exam_attempts set remaining_ms = v_rem where id = p_attempt_id;

  return jsonb_build_object('status', v_a.status, 'remaining_ms', v_rem,
                            'deadline_at', v_a.deadline_at);
end;
$$;

create or replace function public.resume_exam_attempt(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a exam_attempts%rowtype;
begin
  select * into v_a from exam_attempts where id = p_attempt_id;
  if not found then raise exception '考试记录不存在'; end if;
  if v_a.user_id is distinct from v_uid then
    raise exception '这不是你的考试' using errcode = '42501';
  end if;

  perform public._resume_exam_attempt_if_paused(p_attempt_id);

  select * into v_a from exam_attempts where id = p_attempt_id;
  return jsonb_build_object('status', v_a.status,
                            'remaining_ms', v_a.remaining_ms,
                            'deadline_at', v_a.deadline_at);
end;
$$;

revoke all on function public.pause_exam_attempt(uuid) from public, anon;
revoke all on function public.resume_exam_attempt(uuid) from public, anon;
grant execute on function public.pause_exam_attempt(uuid) to authenticated;
grant execute on function public.resume_exam_attempt(uuid) to authenticated;

-- 两条读路径顺手恢复一次（见 _resume_exam_attempt_if_paused 的说明）：
-- 旧客户端不会调 resume，但它一定会调这两个函数之一。
-- get_my_exam_attempt 因此**不再是 stable**（它会写 deadline_at）。
create or replace function public.get_my_exam_attempt(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a exam_attempts%rowtype;
begin
  select * into v_a from exam_attempts where id = p_attempt_id;
  if not found then
    raise exception '考试记录不存在';
  end if;
  if v_a.user_id is distinct from v_uid then
    raise exception '这不是你的考试' using errcode = '42501';
  end if;

  perform public._resume_exam_attempt_if_paused(p_attempt_id);

  return jsonb_build_object(
    'attempt', (select to_jsonb(a) - 'graded_by' from exam_attempts a where a.id = v_a.id),
    'paper', case
               when v_a.status = 'graded' then public.paper_version_json(v_a.paper_version_id)
               when v_a.status in ('submitted', 'grading')
                 then public.exam_paper_json_for_result(v_a.paper_version_id)
               else public.exam_paper_json(v_a.paper_version_id)
             end,
    'answers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'paper_item_id', aa.paper_item_id, 'seq', aa.seq, 'answer', aa.answer,
               'units', aa.units, 'score', aa.score, 'grading', aa.grading,
               'is_correct', aa.is_correct, 'comment', aa.comment) order by aa.seq)
      from exam_answers aa where aa.attempt_id = v_a.id), '[]'::jsonb));
end;
$$;

create or replace function public.start_exam_attempt(p_paper_version_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_ver paper_versions%rowtype;
  v_paper papers%rowtype;
  v_attempt uuid;
  v_full numeric;
  v_obj_full numeric;
begin
  select * into v_ver from paper_versions where id = p_paper_version_id;
  if not found then raise exception '试卷不存在'; end if;
  if v_ver.status <> 'published' then raise exception '这份试卷还没有入库，不能考试'; end if;
  select * into v_paper from papers where id = v_ver.paper_id;
  if v_paper.state <> 'live' then raise exception '这份试卷已下线'; end if;
  if not exists (select 1 from paper_items where paper_version_id = v_ver.id) then
    raise exception '试卷是空的';
  end if;

  select coalesce(sum(score), 0),
         coalesce(sum(score) filter (where qtype in
           ('single_choice', 'multiple_choice', 'true_false')), 0)
    into v_full, v_obj_full
  from paper_items where paper_version_id = v_ver.id;

  begin
    insert into exam_attempts (paper_id, paper_version_id, user_id, status,
                               deadline_at, full_score, objective_full_score)
    values (v_paper.id, v_ver.id, v_uid, 'in_progress',
            now() + make_interval(mins => v_ver.duration_minutes), v_full, v_obj_full)
    returning id into v_attempt;
  exception when unique_violation then
    select id into v_attempt from exam_attempts
    where paper_version_id = v_ver.id and user_id = v_uid and status = 'in_progress';
    if v_attempt is null then raise exception '已经开始过这场考试了，请刷新'; end if;
  end;

  -- 续考（上一场暂停过）：把截止时刻抬回来，客户端拿到的就是"还剩多少"
  perform public._resume_exam_attempt_if_paused(v_attempt);

  return jsonb_build_object(
    'attempt', (select to_jsonb(a) - 'graded_by' from exam_attempts a where a.id = v_attempt),
    'paper', public.exam_paper_json(v_ver.id),
    'answers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'paper_item_id', aa.paper_item_id, 'answer', aa.answer, 'seq', aa.seq))
      from exam_answers aa where aa.attempt_id = v_attempt), '[]'::jsonb));
end;
$$;

-- =====================================================================
-- 二、练习：批量 / 顺序练习的作答草稿
-- =====================================================================
alter table public.practice_sessions
  add column if not exists draft_answers jsonb not null default '{}'::jsonb;
alter table public.practice_sessions
  add column if not exists draft_updated_at timestamptz;
-- 练习方式。原先只存在客户端（组卷页选了 batch，服务端不知道），
-- 于是「继续练习」永远按即时练习重开：批量练习会被逐题提交，
-- 顺序讲练更要命（0090 一个答案都不许提交）。0144 起记在会话上。
alter table public.practice_sessions
  add column if not exists mode text not null default 'instant';

-- 存量会话回填：scored = false 的一定是课堂顺序练习（0090）。
update public.practice_sessions
set mode = 'sequential'
where scored = false and mode <> 'sequential';

alter table public.practice_sessions drop constraint if exists practice_sessions_mode_check;
alter table public.practice_sessions
  add constraint practice_sessions_mode_check
  check (mode in ('instant', 'batch', 'sequential'));

comment on column public.practice_sessions.draft_answers is
  '未提交的作答草稿 {question_id: {answer, is_correct, self_mastered}}（0144）';
comment on column public.practice_sessions.mode is
  '练习方式 instant/batch/sequential；续练必须按它重开（0144）';

-- 记一条进度：可同时登记练习方式与若干道题的草稿。
--
-- p_mode 只在合法时生效；p_answers 形状 {"<question_id>": {answer, is_correct, self_mastered}}，
-- 值为空对象 = 删掉这道题（学生清空了作答）。
create or replace function public.save_practice_progress(
  p_session_id uuid,
  p_mode text default null,
  p_answers jsonb default '{}'::jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_s practice_sessions%rowtype;
  v_key text;
  v_val jsonb;
  v_draft jsonb;
  v_n int := 0;
  v_md text;
  v_at timestamptz;
begin
  select * into v_s from practice_sessions
  where id = p_session_id and user_id = v_uid
  for update;
  if not found then raise exception '练习会话不存在或不属于你'; end if;

  v_md := case when p_mode in ('instant', 'batch', 'sequential') then p_mode else v_s.mode end;

  -- 已交卷 / 已作废：不再收草稿，静默返回。节流窗口里的最后一批请求可能晚于交卷。
  if v_s.status <> 'active' then
    return jsonb_build_object('saved', 0, 'mode', v_s.mode, 'status', v_s.status,
                              'draft_updated_at', v_s.draft_updated_at);
  end if;

  v_draft := coalesce(v_s.draft_answers, '{}'::jsonb);

  if p_answers is not null and jsonb_typeof(p_answers) = 'object' then
    for v_key, v_val in select e.key, e.value from jsonb_each(p_answers) e loop
      if v_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        continue;
      end if;
      -- 只能写进这场会话的题
      if not exists (
        select 1 from practice_session_items i
        where i.session_id = v_s.id and i.question_id = v_key::uuid
      ) then
        continue;
      end if;

      if v_val is null or jsonb_typeof(v_val) <> 'object' or v_val = '{}'::jsonb then
        v_draft := v_draft - v_key;
      else
        v_draft := v_draft || jsonb_build_object(v_key, v_val);
      end if;
      v_n := v_n + 1;
    end loop;
  end if;

  -- answered_count 只对「作答中不提交」的模式按草稿数对齐（首页「继续练习」卡读它）。
  -- 即时练习的作答会由 submit_practice_answer 写 practice_answers 并维护这个计数，
  -- 这里覆盖会把已经提交的题数清零。
  -- ⚠ 不要用 jsonb_object_length：PostgreSQL **没有**这个函数（只有
  -- jsonb_array_length）。数对象的键只能 jsonb_object_keys 再 count。
  update practice_sessions
  set draft_answers = v_draft,
      draft_updated_at = now(),
      mode = v_md,
      answered_count = case when v_md <> 'instant'
                            then (select count(*)::int from jsonb_object_keys(v_draft))
                            else answered_count end
  where id = v_s.id
  returning draft_updated_at into v_at;

  return jsonb_build_object('saved', v_n, 'mode', v_md, 'status', 'active',
                            'draft_updated_at', v_at);
end;
$$;

revoke all on function public.save_practice_progress(uuid, text, jsonb) from public, anon;
grant execute on function public.save_practice_progress(uuid, text, jsonb) to authenticated;

-- get_practice_session 增加三个键：mode / drafts / draft_updated_at。
-- 其余字段与线上定义逐字一致（0029 + 0095 的 scored）。
create or replace function public.get_practice_session(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_s practice_sessions%rowtype;
begin
  select * into v_s from practice_sessions where id = p_session_id and user_id = v_uid;
  if not found then
    raise exception '练习会话不存在或不属于你';
  end if;
  return jsonb_build_object(
    'session_id', v_s.id,
    'source', v_s.source,
    'status', v_s.status,
    'started_at', v_s.started_at,
    'submitted_at', v_s.submitted_at,
    'duration_ms', v_s.duration_ms,
    'total_count', v_s.total_count,
    'answered_count', v_s.answered_count,
    'correct_count', v_s.correct_count,
    -- 续练时必须知道这个：scored=false 的会话要按"课堂讲练"重开，
    -- 否则会把作答提交到服务端，静默污染学生的统计（见 0090 的文件头）。
    'scored', v_s.scored,
    -- 0144：练习方式与作答草稿。旧会话没有 mode 时按 instant 兜底，
    -- 客户端仍会用 scored 兜住课堂讲练。
    'mode', v_s.mode,
    'draft_updated_at', v_s.draft_updated_at,
    'drafts', case when v_s.status = 'active'
                   then coalesce(v_s.draft_answers, '{}'::jsonb)
                   else '{}'::jsonb end,
    'items', public.practice_session_items_json(v_s.id),
    'answers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'question_id', a.question_id,
        'answer', a.answer,
        'grading', a.grading,
        'is_correct', a.is_correct,
        'self_mastered', a.self_mastered,
        'duration_ms', a.duration_ms,
        'answered_at', a.answered_at))
      from practice_answers a where a.session_id = v_s.id), '[]'::jsonb));
end;
$$;

-- 交卷 / 放弃之后草稿就作废了。留着不占多少空间，但会让"同一份卷再练一次"
-- 在读不到时留下误导性的旧数据，顺手清掉。
create or replace function public.abandon_practice_session(p_session_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  update practice_sessions
  set status = 'abandoned', draft_answers = '{}'::jsonb
  where id = p_session_id and user_id = v_uid and status = 'active';
end;
$$;

create or replace function public.finish_practice_session(
  p_session_id uuid,
  p_duration_ms bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_session practice_sessions%rowtype;
  v_answered int;
  v_correct int;
  v_dur bigint;
begin
  -- for update：并发交卷串行（见 0068 的文件头「二」）。锁的是本会话这一行，粒度最小。
  select * into v_session from practice_sessions
  where id = p_session_id and user_id = v_uid
  for update;
  if not found then
    raise exception '练习会话不存在或不属于你';
  end if;

  -- 已交卷：幂等返回上一次的结算，不报错。
  if v_session.status = 'submitted' then
    return jsonb_build_object(
      'total', v_session.total_count,
      'answered', v_session.answered_count,
      'correct', v_session.correct_count,
      'wrong', v_session.answered_count - v_session.correct_count,
      'omitted', v_session.total_count - v_session.answered_count,
      'accuracy', case when v_session.total_count > 0
                       then round(v_session.correct_count::numeric / v_session.total_count, 4)
                       else 0 end,
      'duration_ms', v_session.duration_ms);
  end if;

  -- 走到这里只剩已作废（status 的 check 约束保证只有三种取值）
  if v_session.status <> 'active' then
    raise exception '本次练习已作废，无法交卷';
  end if;

  select count(*), count(*) filter (where is_correct)
    into v_answered, v_correct
  from practice_answers where session_id = p_session_id;

  v_dur := greatest(coalesce(
    p_duration_ms,
    (extract(epoch from (now() - v_session.started_at)) * 1000)::bigint), 0);

  update practice_sessions
  set status = 'submitted',
      submitted_at = now(),
      duration_ms = v_dur,
      answered_count = v_answered,
      correct_count = v_correct,
      draft_answers = '{}'::jsonb
  where id = p_session_id;

  return jsonb_build_object(
    'total', v_session.total_count,
    'answered', v_answered,
    'correct', v_correct,
    'wrong', v_answered - v_correct,
    'omitted', v_session.total_count - v_answered,
    'accuracy', case when v_session.total_count > 0
                     then round(v_correct::numeric / v_session.total_count, 4) else 0 end,
    'duration_ms', v_dur);
end;
$$;

-- PostgREST 需要重新读一次函数签名（新函数不刷新会报 PGRST202）
notify pgrst, 'reload schema';
