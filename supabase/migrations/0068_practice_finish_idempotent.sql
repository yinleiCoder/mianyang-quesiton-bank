-- 0068: 交卷幂等 + 并发串行 —— 消灭「本次练习已交卷或已作废」这个假报错。
--
-- 线上实测（24 小时窗口，edge_logs）：finish_practice_session 307 次调用里 106 次返回 400
-- （35%），而全部 106 次的报错点都是同一个守卫：「本次练习已交卷或已作废」。
-- submit_practice_answer 5924 次里 140 次 400，报错点也全是「本次练习已结束，无法继续作答」。
--
-- 两种成因，本迁移治的是第二种，第一种由客户端负责（见下）：
--
--  一、会话早就不在 active 了，用户还在往里做题。**根因在客户端**：练习页不认识会话状态，
--      已作废/已交卷的会话照样能打开并作答，本地判分还会照常显示对错，于是白答一整场，
--      直到交卷才被告知"已交卷或已作废"。客户端改为进入结束态、不再放行作答（同批修改）。
--
--  二、**交卷请求被重发**。用户在慢网络下单次交卷会连点上十次（实测有同一个人 350ms 内
--      发出 22 次交卷请求，也有 200 之后紧跟 400 的：第一次已经成功结算，后面几次全报错）。
--      客户端只把报错抛给用户，于是"交卷成功"和"交卷失败"同时出现在屏幕上。修两处：
--        · 本函数改为**幂等**：已交卷的会话再次交卷，返回上次的结算而不是报错。
--        · 取会话行加 `for update`，把并发交卷串起来。没有它时两个事务会同时读到 active、
--          双双通过守卫、**双双返回 200**（线上抓到 13:46:43.635 与 .636 两次 200 同属一场练习），
--          submitted_at 与 duration_ms 也会被后到的覆盖。
--
--  已作废（abandoned）仍然报错，不幂等：那次练习本就不该结算，交卷是客户端的错。
--  文案随之细化——原来的「本次练习已交卷或已作废」是在一个守卫里混着两种状态，
--  现在能走到这里的只剩已作废。
--
-- submit_practice_answer 同样加 `for update`：它的进度计数是「重新数一遍 practice_answers」，
-- 两个并发事务各自数的时候看不到对方未提交的那一行，后写的那次会把计数写少
-- （首页「已完成 N/M 题」会少一题）。加锁后同一会话的作答串行，计数恒等于真实行数。
-- 两把锁都在同一行、同一顺序上取，不存在交叉等待。
--
-- 只改这两个函数，不动表结构与授权。注：客户端仓储里的「已交卷报错」文案注释要同步更新。

-- ============ 交卷：幂等 + 串行 ============
create or replace function public.finish_practice_session(p_session_id uuid, p_duration_ms bigint default null)
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
  -- for update：并发交卷串行（见文件头「二」）。锁的是本会话这一行，粒度最小。
  select * into v_session from practice_sessions
  where id = p_session_id and user_id = v_uid
  for update;
  if not found then
    raise exception '练习会话不存在或不属于你';
  end if;

  -- 已交卷：幂等返回上一次的结算。客户端重发（弱网重试、用户连点）不该看到失败——
  -- 成绩早就结算好了，报错只会让人以为白考一场。
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
      correct_count = v_correct
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

-- ============ 单题作答：进度计数串行 ============
create or replace function public.submit_practice_answer(
  p_session_id uuid,
  p_question_id uuid,
  p_answer jsonb,
  p_duration_ms bigint default 0,
  p_self_mastered boolean default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_session practice_sessions%rowtype;
  v_item practice_session_items%rowtype;
  v_qtype text;
  v_content jsonb;
  v_grading text := 'auto';
  v_correct boolean;
begin
  -- for update：同一会话的并发作答串行，末尾那次计数才不会数漏（见文件头）。
  select * into v_session from practice_sessions
  where id = p_session_id and user_id = v_uid
  for update;
  if not found then
    raise exception '练习会话不存在或不属于你';
  end if;
  if v_session.status <> 'active' then
    raise exception '本次练习已结束，无法继续作答';
  end if;
  select * into v_item from practice_session_items
  where session_id = p_session_id and question_id = p_question_id;
  if not found then
    raise exception '题目不在本次练习中';
  end if;
  select qtype, content into v_qtype, v_content
  from question_versions where id = v_item.version_id;

  if v_qtype = 'short_answer' then
    if p_self_mastered is null then
      raise exception '主观题请先自评是否掌握';
    end if;
    v_grading := 'self';
    v_correct := p_self_mastered;
  elsif coalesce(p_answer ->> 'type', '') = 'unknown' then
    v_correct := false;  -- 不会：计一次作答并判错
  else
    v_correct := public.grade_answer(v_qtype, v_content, coalesce(p_answer, '{}'::jsonb));
  end if;

  insert into practice_answers (session_id, user_id, question_id, version_id, answer,
                                grading, is_correct, self_mastered, duration_ms, answered_at)
  values (p_session_id, v_uid, p_question_id, v_item.version_id, coalesce(p_answer, '{}'::jsonb),
          v_grading, v_correct, p_self_mastered, greatest(coalesce(p_duration_ms, 0), 0), now())
  on conflict (session_id, question_id) do update
  set answer = excluded.answer,
      grading = excluded.grading,
      is_correct = excluded.is_correct,
      self_mastered = excluded.self_mastered,
      duration_ms = excluded.duration_ms,
      answered_at = excluded.answered_at;

  update practice_sessions s
  set answered_count = (select count(*) from practice_answers a where a.session_id = s.id),
      correct_count = (select count(*) from practice_answers a where a.session_id = s.id and a.is_correct)
  where s.id = p_session_id;

  return jsonb_build_object(
    'is_correct', v_correct,
    'grading', v_grading,
    'correct_answer', v_content -> 'answer');
end;
$$;
