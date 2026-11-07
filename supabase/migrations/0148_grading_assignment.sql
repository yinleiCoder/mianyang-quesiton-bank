-- 0148: 阅卷分摊（学校 + 专业公共池认领）
--
-- 背景（2026-11-07）：0124 起填空/综合题全部人工判分，一份全市卷的待批场次
-- 全压在试卷作者一个人身上。这里把阅卷资格从「纸级管理员」扩展到：
--   · 试卷作者 / 系统管理员 / 试卷归属学校管理员（沿用 is_paper_grader）
--   · 考生所在学校的同专业教师（任教专业相同或是考生专业的祖先）
--   · 该科目（papers.course_node_id 子树）的教研组长 / 市级专家
-- 默认是公共池认领（不强制分配）；管理员仍可按场次分派或一键平均分配。
--
-- 三条边界：
--   1) 不把新分支塞进 is_paper_grader —— 它同时是成绩榜/试题分析/质量诊断的
--      纸级权限开关（0063 明写）。新口径只在 can_user_grade_attempt 里。
--   2) 一份答卷同时只由一位老师批（claimed_by 独占）；管理员可改派/释放。
--   3) 认领不自动过期；教师调岗后已认领的场次仍可批完（claimed_by 分支）。
--
-- 上线顺序：先执行本迁移，再部署网页端（新代码会调用 can_grade_paper 等新函数）。

-- =====================================================================
-- 1) 表结构
-- =====================================================================
alter table public.exam_attempts
  add column if not exists claimed_by uuid references auth.users(id) on delete set null,
  add column if not exists claimed_at timestamptz;

comment on column public.exam_attempts.claimed_by is
  '认领这份答卷的阅卷人；NULL = 公共池待认领。管理员可改派/释放。';
comment on column public.exam_attempts.claimed_at is '认领时间。';

create index if not exists idx_exam_attempts_claim
  on public.exam_attempts (paper_id, claimed_by)
  where status in ('submitted', 'grading');

-- 跨试卷的待批统计（侧栏角标 / 阅卷队列）
create index if not exists idx_exam_attempts_open_grading
  on public.exam_attempts (status, paper_id)
  where status in ('submitted', 'grading');

-- 按学校/专业找人
create index if not exists idx_profiles_school_identity
  on public.profiles (school_id, identity);
create index if not exists idx_approver_assignments_user_active
  on public.approver_assignments (user_id) where is_active;

-- =====================================================================
-- 2) 科目树辅助：p_node 是否等于 / 位于 p_ancestor 子树下
-- =====================================================================
create or replace function public.is_subject_under(p_node uuid, p_ancestor uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with recursive chain(id, parent_id) as (
    select id, parent_id from subject_nodes where id = p_node
    union all
    select sn.id, sn.parent_id
    from chain c
    join subject_nodes sn on sn.id = c.parent_id
  )
  select exists (select 1 from chain where id = p_ancestor);
$$;

comment on function public.is_subject_under(uuid, uuid) is
  'p_node 是否等于 p_ancestor 或位于其子树下（科目树任意深度）。';

-- =====================================================================
-- 3) 纸级管理员：参数化版本 + 原函数改为包装
-- =====================================================================
create or replace function public.is_user_paper_grader(p_user uuid, p_paper_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from papers p
    -- left join：作者账号即使 profile 异常缺失，也仍然保留作者权限（与 0051 一致）
    left join profiles me on me.user_id = p_user
    where p.id = p_paper_id
      and (
        p.creator_id = p_user
        or coalesce(me.is_admin, false)
        or (me.school_id = p.school_id
            and exists (
              select 1 from user_roles ur
              where ur.user_id = p_user and ur.role = 'school_admin'
            ))
      )
  );
$$;

comment on function public.is_user_paper_grader(uuid, uuid) is
  'is_paper_grader 的参数化版本：作者 / 系统管理员 / 试卷归属学校管理员。';

-- 语义与 0051 逐字一致，只换成参数化调用；不要在这里加阅卷分摊的 OR 分支。
create or replace function public.is_paper_grader(p_paper_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_user_paper_grader((select auth.uid()), p_paper_id);
$$;

-- =====================================================================
-- 4) 场次级阅卷资格
-- =====================================================================
create or replace function public.can_user_grade_attempt(p_user uuid, p_attempt_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from exam_attempts a
    join papers p on p.id = a.paper_id
    left join profiles stu on stu.user_id = a.user_id
    -- left join：作者/管理员的 profile 异常缺失时，纸级权限仍然生效
    left join profiles me on me.user_id = p_user
    where a.id = p_attempt_id
      and (
        -- ① 纸级管理员（作者 / 系统管理员 / 试卷归属学校管理员）
        public.is_user_paper_grader(p_user, p.id)
        -- ② 已认领人：调岗/专业变更后仍能把已认领的场次批完
        or (a.claimed_by = p_user and me.identity = 'teacher')
        -- ③ 考生所在学校的同专业教师（未设置任教专业的按本校通用阅卷人）
        or (
          me.identity = 'teacher'
          and stu.school_id is not null
          and me.school_id = stu.school_id
          and (
            me.major_node_id is null
            or stu.major_node_id is null
            or me.major_node_id = stu.major_node_id
            or public.is_subject_under(stu.major_node_id, me.major_node_id)
          )
        )
        -- ④ 考生学校的教研组长（任命节点覆盖试卷科目）
        or exists (
          select 1
          from approver_assignments aa
          where aa.user_id = p_user
            and aa.is_active
            and aa.role = 'group_leader'
            and aa.school_id = stu.school_id
            and public.is_subject_under(p.course_node_id, aa.node_id)
        )
        -- ⑤ 与考生学校同市的市级专家（任命节点覆盖试卷科目；学校无市时退回全部专家）
        or exists (
          select 1
          from approver_assignments aa
          join profiles mp on mp.user_id = aa.user_id
          join schools ms on ms.id = mp.school_id
          join schools ss on ss.id = stu.school_id
          where aa.user_id = p_user
            and aa.is_active
            and aa.role = 'city_expert'
            and public.is_subject_under(p.course_node_id, aa.node_id)
            and (ss.city_id is null or ms.city_id = ss.city_id)
        )
      )
  );
$$;

comment on function public.can_user_grade_attempt(uuid, uuid) is
  '某用户能否批某一场：纸级管理员 / 已认领人 / 同校同专业教师 / 该科目组长或同市市级专家。';

create or replace function public.can_grade_attempt(p_attempt_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- 不用 require_uid()：RLS 策略里遇到异常会话时应当返回 false，而不是让整条查询报错。
  select case
    when (select auth.uid()) is null then false
    else public.can_user_grade_attempt((select auth.uid()), p_attempt_id)
  end;
$$;

comment on function public.can_grade_attempt(uuid) is
  '当前登录用户能否批这一场（RLS 与 RPC 共用）。';

create or replace function public.can_grade_paper(p_paper_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  -- 先看纸级管理员；学生/非教师直接 false，不去扫该卷的全部场次
  select case
    when public.is_paper_grader(p_paper_id) then true
    when not exists (
      select 1 from profiles
      where user_id = (select auth.uid()) and identity = 'teacher'
    ) then false
    else exists (
      select 1
      from exam_attempts a
      where a.paper_id = p_paper_id
        and public.can_user_grade_attempt((select auth.uid()), a.id)
    )
  end;
$$;

comment on function public.can_grade_paper(uuid) is
  '当前用户是否有这份卷的阅卷入口（管理员或存在任一可批场次）。';

-- =====================================================================
-- 5) RLS：阅卷人也要能读别人的场次与作答
-- =====================================================================
drop policy if exists select_exam_attempt on public.exam_attempts;
create policy select_exam_attempt on public.exam_attempts for select to authenticated using (
  user_id = (select auth.uid())
  or (select public.is_paper_grader(paper_id))
  or (select public.can_grade_attempt(id))
);

drop policy if exists select_exam_answer on public.exam_answers;
create policy select_exam_answer on public.exam_answers for select to authenticated using (
  exists (
    select 1
    from public.exam_attempts a
    where a.id = exam_answers.attempt_id
      and (
        a.user_id = (select auth.uid())
        or (select public.is_paper_grader(a.paper_id))
        or (select public.can_grade_attempt(a.id))
      )
  )
);

-- =====================================================================
-- 6) 修改现有 RPC
-- =====================================================================

-- 6.1 阅卷队列：按「我能批」聚合，并拆出待认领 / 我认领
create or replace function public.list_my_grading_queue()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'paper_id', g.paper_id,
             'title', g.title,
             'version_no', g.version_no,
             'pending_attempts', g.pending_attempts,
             'in_grading', g.in_grading,
             'unclaimed_attempts', g.unclaimed_attempts,
             'my_attempts', g.my_attempts,
             'last_submitted_at', g.last_submitted_at)
           order by g.last_submitted_at desc nulls last)
    from (
      select p.id as paper_id,
             coalesce(cv.title, max(av.title)) as title,
             coalesce(cv.version_no, max(av.version_no)) as version_no,
             count(*)::int as pending_attempts,
             count(*) filter (where a.status = 'grading')::int as in_grading,
             count(*) filter (where a.claimed_by is null)::int as unclaimed_attempts,
             count(*) filter (where a.claimed_by = v_uid)::int as my_attempts,
             max(a.submitted_at) as last_submitted_at
      from exam_attempts a
      join papers p on p.id = a.paper_id
      join paper_versions av on av.id = a.paper_version_id
      left join paper_versions cv on cv.id = p.current_published_version_id
      where a.status in ('submitted', 'grading')
        and public.can_user_grade_attempt(v_uid, a.id)
        -- 公共池教师只看「未认领 + 我认领」；纸级管理员看全部（便于分派）
        and (public.is_paper_grader(p.id)
             or a.claimed_by is null
             or a.claimed_by = v_uid)
      group by p.id, cv.title, cv.version_no
    ) g
  ), '[]'::jsonb);
end;
$$;

-- 6.2 卷内队列：管理员看全部；公共池教师只看「未认领 + 我认领」
create or replace function public.list_exam_attempts_for_paper(
  p_paper_id uuid, p_only_pending boolean default true, p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_is_manager boolean := public.is_paper_grader(p_paper_id);
  v_rows jsonb;
begin
  if not v_is_manager and not exists (
    select 1 from exam_attempts a
    where a.paper_id = p_paper_id
      and public.can_user_grade_attempt(v_uid, a.id)
  ) then
    raise exception '只有试卷作者、本校管理员、系统管理员，以及本校同专业教师/该科目组长或市级专家可以阅卷'
      using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(x.payload order by x.sort_key desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'attempt_id', a.id, 'user_id', a.user_id, 'user_name', coalesce(p.name, '（已注销）'),
               'status', a.status, 'submitted_at', a.submitted_at, 'graded_at', a.graded_at,
               'total_score', a.total_score, 'full_score', a.full_score,
               'objective_score', a.objective_score, 'subjective_score', a.subjective_score,
               'pending_review_count', a.pending_review_count,
               'duration_ms', a.duration_ms,
               'claimed_by', a.claimed_by,
               'claimed_by_name', case when a.claimed_by is null then null
                 else coalesce((select name from profiles where user_id = a.claimed_by), '（已注销）') end,
               'claimed_at', a.claimed_at,
               'user_school_name', sch.name,
               'user_major_name', mn.name
             ) as payload,
             coalesce(a.submitted_at, a.started_at) as sort_key
      from exam_attempts a
      left join profiles p on p.user_id = a.user_id
      left join schools sch on sch.id = p.school_id
      left join subject_nodes mn on mn.id = p.major_node_id
      where a.paper_id = p_paper_id
        and a.status in ('submitted', 'grading', 'graded')
        and (not p_only_pending or a.pending_review_count > 0)
        and public.can_user_grade_attempt(v_uid, a.id)
        and (v_is_manager or a.claimed_by is null or a.claimed_by = v_uid)
      order by sort_key desc
      limit v_limit offset greatest(coalesce(p_offset, 0), 0)
    ) x;

  return jsonb_build_object('attempts', v_rows, 'can_manage', v_is_manager);
end;
$$;

-- 6.3 阅卷详情：非管理员不能打开别人已认领的场次
create or replace function public.get_exam_attempt_for_review(p_attempt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a exam_attempts%rowtype;
  v_snap jsonb;
  v_is_manager boolean;
begin
  select * into v_a from exam_attempts where id = p_attempt_id;
  if not found then raise exception '考试记录不存在'; end if;
  if not public.can_user_grade_attempt(v_uid, p_attempt_id) then
    raise exception '只有试卷作者、本校管理员、系统管理员，以及本校同专业教师/该科目组长或市级专家可以阅卷'
      using errcode = '42501';
  end if;

  v_is_manager := public.is_paper_grader(v_a.paper_id);
  if not v_is_manager and v_a.claimed_by is not null and v_a.claimed_by <> v_uid then
    raise exception '这场已被 % 认领',
      coalesce((select name from profiles where user_id = v_a.claimed_by), '其他老师')
      using errcode = '42501';
  end if;

  -- 阅卷人要看到**带答案**的卷面（不然没法判），所以这里是 paper_version_json 而不是 exam_paper_json
  v_snap := public.paper_version_json(v_a.paper_version_id);

  return jsonb_build_object(
    'attempt', jsonb_build_object(
      'id', v_a.id, 'user_id', v_a.user_id,
      'user_name', coalesce((select name from profiles where user_id = v_a.user_id), '（已注销）'),
      'status', v_a.status, 'submitted_at', v_a.submitted_at, 'graded_at', v_a.graded_at,
      'total_score', v_a.total_score, 'full_score', v_a.full_score,
      'objective_score', v_a.objective_score, 'subjective_score', v_a.subjective_score,
      'pending_review_count', v_a.pending_review_count,
      'claimed_by', v_a.claimed_by,
      'claimed_by_name', case when v_a.claimed_by is null then null
        else coalesce((select name from profiles where user_id = v_a.claimed_by), '（已注销）') end,
      'claimed_at', v_a.claimed_at,
      'user_school_name', (
        select s.name from profiles pr join schools s on s.id = pr.school_id
        where pr.user_id = v_a.user_id),
      'user_major_name', (
        select n.name from profiles pr join subject_nodes n on n.id = pr.major_node_id
        where pr.user_id = v_a.user_id)),
    'paper', v_snap,
    'answers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'paper_item_id', aa.paper_item_id, 'seq', aa.seq, 'answer', aa.answer,
               'units', aa.units, 'auto_score', aa.auto_score, 'manual_score', aa.manual_score,
               'score', aa.score, 'grading', aa.grading, 'is_correct', aa.is_correct,
               'comment', aa.comment) order by aa.seq)
      from exam_answers aa where aa.attempt_id = v_a.id), '[]'::jsonb));
end;
$$;

-- 6.4 逐计分点给分：加行锁 + 自动认领（管理员不占用池子）
create or replace function public.grade_exam_answer(
  p_attempt_id uuid,
  p_paper_item_id uuid,
  p_units jsonb,
  p_comment text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a exam_attempts%rowtype;
  v_item paper_items%rowtype;
  v_score numeric;
  v_n int;
  v_is_manager boolean;
begin
  -- 行锁：认领/改派/另一位老师同时给分时，以先拿到锁的人为准
  select * into v_a from exam_attempts where id = p_attempt_id for update;
  if not found then raise exception '考试记录不存在'; end if;
  if not public.can_user_grade_attempt(v_uid, p_attempt_id) then
    raise exception '只有试卷作者、本校管理员、系统管理员，以及本校同专业教师/该科目组长或市级专家可以阅卷'
      using errcode = '42501';
  end if;

  -- 已出分的场次也允许改分（阅卷人反悔），见 0141 头注
  if v_a.status not in ('submitted', 'grading', 'graded') then
    raise exception '这场考试不在阅卷中';
  end if;

  v_is_manager := public.is_paper_grader(v_a.paper_id);
  if not v_is_manager then
    if v_a.claimed_by is null then
      -- 公共池：第一次给分即认领，保证一份答卷只由一位老师批
      update exam_attempts
      set claimed_by = v_uid, claimed_at = now()
      where id = p_attempt_id;
      v_a.claimed_by := v_uid;
      v_a.claimed_at := now();
    elsif v_a.claimed_by <> v_uid then
      raise exception '这场已被 % 认领',
        coalesce((select name from profiles where user_id = v_a.claimed_by), '其他老师')
        using errcode = '42501';
    end if;
  end if;

  select * into v_item from paper_items
  where id = p_paper_item_id and paper_version_id = v_a.paper_version_id;
  if not found then raise exception '这道题不属于这场考试'; end if;

  if p_units is null or jsonb_typeof(p_units) <> 'array' then
    raise exception '给分格式错误（应为数组）';
  end if;
  v_n := jsonb_array_length(p_units);
  if v_n <> jsonb_array_length(v_item.score_units) then
    raise exception '给分点数量不对：这题有 % 个给分点，收到 % 个',
      jsonb_array_length(v_item.score_units), v_n;
  end if;
  if exists (
    select 1 from jsonb_array_elements_text(p_units) with ordinality as t(v, ord)
    where (t.v)::numeric < 0
       or (t.v)::numeric > (v_item.score_units ->> (t.ord - 1)::int)::numeric
  ) then
    raise exception '给分超出了一道题的分值上限';
  end if;

  select coalesce(sum(x::numeric), 0) into v_score from jsonb_array_elements_text(p_units) x;

  update exam_answers
  set units = coalesce((
        select jsonb_agg(jsonb_build_object(
                 'ok', (t.v)::numeric >= (v_item.score_units ->> (t.ord - 1)::int)::numeric,
                 'score', (t.v)::numeric) order by t.ord)
        from jsonb_array_elements_text(p_units) with ordinality as t(v, ord)), '[]'::jsonb),
      manual_score = v_score,
      score = v_score,
      grading = 'manual',
      is_correct = v_score >= v_item.score,
      comment = p_comment,
      scored_by = v_uid,
      scored_at = now()
  where attempt_id = p_attempt_id and paper_item_id = p_paper_item_id;

  update exam_attempts
  set pending_review_count = (
        select count(*) from exam_answers
        where attempt_id = p_attempt_id and grading = 'pending'),
      -- 每次给分都重算这场次的三个分：已出分的场次改分后总分必须跟着变
      objective_score = coalesce((select sum(score) from exam_answers
                                  where attempt_id = p_attempt_id and grading = 'auto'), 0),
      subjective_score = coalesce((select sum(score) from exam_answers
                                   where attempt_id = p_attempt_id and grading = 'manual'), 0),
      total_score = coalesce((select sum(score) from exam_answers
                              where attempt_id = p_attempt_id), 0),
      status = case when v_a.status = 'graded' then 'graded' else 'grading' end,
      graded_at = case when v_a.status = 'graded' then now() else graded_at end,
      graded_by = case when v_a.status = 'graded' then v_uid else graded_by end
  where id = p_attempt_id;

  return jsonb_build_object('score', v_score, 'grading', 'manual');
end;
$$;

-- 6.5 结算：同样加行锁与认领检查
create or replace function public.finish_exam_grading(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a exam_attempts%rowtype;
  v_obj numeric;
  v_subj numeric;
  v_left int;
  v_is_manager boolean;
begin
  select * into v_a from exam_attempts where id = p_attempt_id for update;
  if not found then raise exception '考试记录不存在'; end if;
  if not public.can_user_grade_attempt(v_uid, p_attempt_id) then
    raise exception '只有试卷作者、本校管理员、系统管理员，以及本校同专业教师/该科目组长或市级专家可以阅卷'
      using errcode = '42501';
  end if;

  v_is_manager := public.is_paper_grader(v_a.paper_id);
  if not v_is_manager and v_a.claimed_by is not null and v_a.claimed_by <> v_uid then
    raise exception '这场已被 % 认领',
      coalesce((select name from profiles where user_id = v_a.claimed_by), '其他老师')
      using errcode = '42501';
  end if;

  select count(*) into v_left
  from exam_answers where attempt_id = p_attempt_id and grading = 'pending';
  if v_left > 0 then
    raise exception '还有 % 道题没判分，判完才能出成绩', v_left;
  end if;

  select coalesce(sum(score) filter (where grading = 'auto'), 0),
         coalesce(sum(score) filter (where grading = 'manual'), 0)
    into v_obj, v_subj
  from exam_answers where attempt_id = p_attempt_id;

  update exam_attempts
  set status = 'graded', graded_at = now(), graded_by = v_uid,
      objective_score = v_obj, subjective_score = v_subj, total_score = v_obj + v_subj,
      pending_review_count = 0
  where id = p_attempt_id;

  return jsonb_build_object(
    'total_score', v_obj + v_subj, 'objective_score', v_obj, 'subjective_score', v_subj,
    'full_score', v_a.full_score);
end;
$$;

-- =====================================================================
-- 7) 新增 RPC：认领 / 释放 / 分派 / 平均分配 / 候选人 / 角标
-- =====================================================================

-- 7.1 认领（幂等；别人已认领则报错带姓名）
create or replace function public.claim_exam_grading(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a exam_attempts%rowtype;
  v_name text;
  v_at timestamptz;
begin
  select * into v_a from exam_attempts where id = p_attempt_id for update;
  if not found then raise exception '考试记录不存在'; end if;
  if not public.can_user_grade_attempt(v_uid, p_attempt_id) then
    raise exception '你不能批这一场（不在本校同专业范围，也不是该科目的组长/专家）'
      using errcode = '42501';
  end if;
  if v_a.status not in ('submitted', 'grading') then
    raise exception '这场考试不在待阅卷状态';
  end if;
  if v_a.claimed_by is not null and v_a.claimed_by <> v_uid then
    select name into v_name from profiles where user_id = v_a.claimed_by;
    raise exception '这场已被 % 认领', coalesce(v_name, '其他老师');
  end if;

  update exam_attempts
  set claimed_by = v_uid, claimed_at = coalesce(claimed_at, now())
  where id = p_attempt_id
  returning claimed_at into v_at;

  return jsonb_build_object('attempt_id', p_attempt_id, 'claimed_by', v_uid, 'claimed_at', v_at);
end;
$$;

-- 7.2 释放（认领人本人或纸级管理员）
create or replace function public.release_exam_grading(p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a exam_attempts%rowtype;
begin
  select * into v_a from exam_attempts where id = p_attempt_id for update;
  if not found then raise exception '考试记录不存在'; end if;
  if not (v_a.claimed_by = v_uid or public.is_paper_grader(v_a.paper_id)) then
    raise exception '只有认领人本人或试卷管理员可以释放' using errcode = '42501';
  end if;

  update exam_attempts set claimed_by = null, claimed_at = null where id = p_attempt_id;
  return jsonb_build_object('attempt_id', p_attempt_id, 'released', true);
end;
$$;

-- 7.3 分派（纸级管理员；目标必须真的能批这一场）
create or replace function public.assign_exam_grading(p_attempt_id uuid, p_grader_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a exam_attempts%rowtype;
  v_target profiles%rowtype;
begin
  select * into v_a from exam_attempts where id = p_attempt_id for update;
  if not found then raise exception '考试记录不存在'; end if;
  if not public.is_paper_grader(v_a.paper_id) then
    raise exception '只有试卷作者、本校管理员或系统管理员可以分派阅卷'
      using errcode = '42501';
  end if;
  if v_a.status not in ('submitted', 'grading') then
    raise exception '这场考试不在待阅卷状态';
  end if;

  select * into v_target from profiles where user_id = p_grader_id;
  if not found or v_target.identity <> 'teacher' then
    raise exception '只能分派给在职教师';
  end if;
  if not public.can_user_grade_attempt(p_grader_id, p_attempt_id) then
    raise exception '这位老师不在本场的阅卷范围内（学校/专业/科目不符）';
  end if;

  update exam_attempts
  set claimed_by = p_grader_id, claimed_at = now()
  where id = p_attempt_id;

  return jsonb_build_object(
    'attempt_id', p_attempt_id, 'grader_id', p_grader_id, 'grader_name', v_target.name);
end;
$$;

-- 7.4 一键平均分配：未认领场次按提交时间轮转给「能批这一场」的老师。
--     排除试卷作者与当前操作人，避免又把活分回同一个人；无人可批的留在池里。
create or replace function public.auto_assign_exam_grading(p_paper_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_creator uuid;
  v_graders uuid[];
  v_attempt record;
  v_counts jsonb := '{}'::jsonb;
  v_assigned int := 0;
  v_skipped int := 0;
  v_idx int := 0;
  v_n int;
  v_i int;
  v_pick uuid;
begin
  if not public.is_paper_grader(p_paper_id) then
    raise exception '只有试卷作者、本校管理员或系统管理员可以分派阅卷'
      using errcode = '42501';
  end if;

  select creator_id into v_creator from papers where id = p_paper_id;

  with scopes as (
    select distinct stu.school_id, stu.major_node_id
    from exam_attempts a
    join profiles stu on stu.user_id = a.user_id
    where a.paper_id = p_paper_id
      and a.status in ('submitted', 'grading')
      and stu.school_id is not null
  ),
  school_teachers as (
    select distinct p.user_id
    from scopes s
    join profiles p on p.identity = 'teacher' and p.school_id = s.school_id
    where p.major_node_id is null
       or s.major_node_id is null
       or p.major_node_id = s.major_node_id
       or public.is_subject_under(s.major_node_id, p.major_node_id)
  ),
  experts as (
    select distinct aa.user_id
    from papers p
    join approver_assignments aa
      on aa.is_active
     and public.is_subject_under(p.course_node_id, aa.node_id)
    where p.id = p_paper_id
      and (
        (aa.role = 'group_leader'
         and exists (
           select 1 from exam_attempts a
           join profiles stu on stu.user_id = a.user_id
           where a.paper_id = p_paper_id and stu.school_id = aa.school_id))
        or
        (aa.role = 'city_expert'
         and exists (
           select 1 from exam_attempts a
           join profiles stu on stu.user_id = a.user_id
           join schools ss on ss.id = stu.school_id
           join profiles mp on mp.user_id = aa.user_id
           join schools ms on ms.id = mp.school_id
           where a.paper_id = p_paper_id
             and (ss.city_id is null or ms.city_id = ss.city_id)))
      )
  ),
  candidates as (
    select user_id from school_teachers
    union
    select user_id from experts
  )
  select coalesce(array_agg(user_id order by user_id), '{}'::uuid[])
    into v_graders
  from candidates
  where user_id is distinct from v_creator
    and user_id is distinct from v_uid;

  v_n := coalesce(array_length(v_graders, 1), 0);
  if v_n = 0 then
    return jsonb_build_object(
      'assigned', 0, 'skipped', 0, 'by_grader', '[]'::jsonb,
      'message', '没有可用的其他阅卷老师（试卷作者/当前操作人已排除）');
  end if;

  for v_attempt in
    select id from exam_attempts
    where paper_id = p_paper_id
      and status in ('submitted', 'grading')
      and claimed_by is null
    order by coalesce(submitted_at, started_at)
  loop
    v_pick := null;
    for v_i in 1..v_n loop
      v_idx := (v_idx % v_n) + 1;
      v_pick := v_graders[v_idx];
      if public.can_user_grade_attempt(v_pick, v_attempt.id) then
        exit;
      end if;
      v_pick := null;
    end loop;

    if v_pick is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    update exam_attempts
    set claimed_by = v_pick, claimed_at = now()
    where id = v_attempt.id and claimed_by is null;

    if found then
      v_assigned := v_assigned + 1;
      v_counts := jsonb_set(
        v_counts,
        array[v_pick::text],
        to_jsonb(coalesce((v_counts ->> v_pick::text)::int, 0) + 1),
        true);
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'assigned', v_assigned,
    'skipped', v_skipped,
    'by_grader', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', e.k, 'name', coalesce(p.name, ''), 'count', e.v::int))
      from jsonb_each_text(v_counts) e(k, v)
      left join profiles p on p.user_id = e.k::uuid
    ), '[]'::jsonb));
end;
$$;

-- 7.5 某一场的候选人（改派下拉框用）
create or replace function public.list_attempt_grading_candidates(p_attempt_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_a exam_attempts%rowtype;
  v_paper papers%rowtype;
  v_stu profiles%rowtype;
begin
  select * into v_a from exam_attempts where id = p_attempt_id;
  if not found then raise exception '考试记录不存在'; end if;
  if not public.is_paper_grader(v_a.paper_id) then
    raise exception '只有试卷作者、本校管理员或系统管理员可以查看阅卷人候选'
      using errcode = '42501';
  end if;

  select * into v_paper from papers where id = v_a.paper_id;
  select * into v_stu from profiles where user_id = v_a.user_id;

  return coalesce((
    with candidates as (
      -- 考生所在学校的同专业教师（未设置任教专业的按本校通用阅卷人）
      select p.user_id, p.name, p.school_id, p.major_node_id, null::text as expert_role
      from profiles p
      where p.identity = 'teacher'
        and p.school_id = v_stu.school_id
        and (
          p.major_node_id is null
          or v_stu.major_node_id is null
          or p.major_node_id = v_stu.major_node_id
          or public.is_subject_under(v_stu.major_node_id, p.major_node_id)
        )
      union
      -- 考生学校的教研组长（覆盖试卷科目）
      select p.user_id, p.name, p.school_id, p.major_node_id, 'group_leader'::text
      from approver_assignments aa
      join profiles p on p.user_id = aa.user_id
      where aa.is_active
        and aa.role = 'group_leader'
        and aa.school_id = v_stu.school_id
        and public.is_subject_under(v_paper.course_node_id, aa.node_id)
      union
      -- 与考生学校同市的市级专家（覆盖试卷科目）
      select p.user_id, p.name, p.school_id, p.major_node_id, 'city_expert'::text
      from approver_assignments aa
      join profiles p on p.user_id = aa.user_id
      join schools ms on ms.id = p.school_id
      join schools ss on ss.id = v_stu.school_id
      where aa.is_active
        and aa.role = 'city_expert'
        and public.is_subject_under(v_paper.course_node_id, aa.node_id)
        and (ss.city_id is null or ms.city_id = ss.city_id)
      union
      -- 纸级管理员本人（教师身份），方便管理员把场次分给自己
      select p.user_id, p.name, p.school_id, p.major_node_id, 'paper_manager'::text
      from profiles p
      where p.identity = 'teacher'
        and public.is_user_paper_grader(p.user_id, v_paper.id)
    )
    select jsonb_agg(jsonb_build_object(
             'user_id', c.user_id, 'name', c.name,
             'school_name', s.name, 'major_name', n.name,
             'expert_role', c.expert_role,
             'claimed_pending', (
               select count(*)::int from exam_attempts a2
               where a2.paper_id = v_a.paper_id
                 and a2.status in ('submitted', 'grading')
                 and a2.claimed_by = c.user_id))
           order by c.name, c.user_id)
    from (
      -- 一个老师可能同时命中「同校同专业」和「组长/专家」两条分支；取一条即可。
      -- 不用 max(uuid)：PostgreSQL 没有 uuid 的 max 聚合。distinct on 同时保证
      -- 优先保留非空的 expert_role（nulls last）。
      select distinct on (user_id)
             user_id, name, school_id, major_node_id, expert_role
      from candidates
      order by user_id, expert_role nulls last
    ) c
    left join schools s on s.id = c.school_id
    left join subject_nodes n on n.id = c.major_node_id
  ), '[]'::jsonb);
end;
$$;

-- 7.6 侧栏角标：我认领的待批 + 我能认领的未认领
create or replace function public.count_my_grading_pool()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_mine int;
  v_pool int;
begin
  select count(*) filter (where a.claimed_by = v_uid),
         count(*) filter (where a.claimed_by is null)
    into v_mine, v_pool
  from exam_attempts a
  where a.status in ('submitted', 'grading')
    and public.can_user_grade_attempt(v_uid, a.id);

  return jsonb_build_object('mine', coalesce(v_mine, 0), 'pool', coalesce(v_pool, 0));
end;
$$;

-- =====================================================================
-- 8) 授权
-- =====================================================================
revoke execute on function public.is_subject_under(uuid, uuid) from public, anon;
grant execute on function public.is_subject_under(uuid, uuid) to authenticated;

revoke execute on function public.is_user_paper_grader(uuid, uuid) from public, anon;
grant execute on function public.is_user_paper_grader(uuid, uuid) to authenticated;

revoke execute on function public.is_paper_grader(uuid) from public, anon;
grant execute on function public.is_paper_grader(uuid) to authenticated;

revoke execute on function public.can_user_grade_attempt(uuid, uuid) from public, anon;
grant execute on function public.can_user_grade_attempt(uuid, uuid) to authenticated;

revoke execute on function public.can_grade_attempt(uuid) from public, anon;
grant execute on function public.can_grade_attempt(uuid) to authenticated;

revoke execute on function public.can_grade_paper(uuid) from public, anon;
grant execute on function public.can_grade_paper(uuid) to authenticated;

revoke execute on function public.claim_exam_grading(uuid) from public, anon;
grant execute on function public.claim_exam_grading(uuid) to authenticated;

revoke execute on function public.release_exam_grading(uuid) from public, anon;
grant execute on function public.release_exam_grading(uuid) to authenticated;

revoke execute on function public.assign_exam_grading(uuid, uuid) from public, anon;
grant execute on function public.assign_exam_grading(uuid, uuid) to authenticated;

revoke execute on function public.auto_assign_exam_grading(uuid) from public, anon;
grant execute on function public.auto_assign_exam_grading(uuid) to authenticated;

revoke execute on function public.list_attempt_grading_candidates(uuid) from public, anon;
grant execute on function public.list_attempt_grading_candidates(uuid) to authenticated;

revoke execute on function public.count_my_grading_pool() from public, anon;
grant execute on function public.count_my_grading_pool() to authenticated;
