-- 0139: 人工判分题的 units 统一成对象形状（修「交卷后成绩单报操作失败」）
--
-- 现象（2026-11-05 14:30 前后的考试）：学生交卷成功（submit_exam_attempt 全部 200），
-- 跳转成绩单页却只显示「操作失败，请稍后重试」；同一学生 45 秒内反复点重试，
-- 服务端日志里是连续 20+ 次 get_my_exam_attempt（每次都 200）。
--
-- 根因是**两种 units 形状混在一张表里**：
--   · 自动判分题（选择/判断）：submit_exam_attempt 把 grade_exam_units 返回的
--     布尔数组转成了 [{ok, score}]，客户端按 ScoreUnit.fromJson 解析没问题；
--   · 人工判分题（简答/复合题）：待阅卷分支**原样落库**了布尔数组 [false,false,…]。
-- 客户端 ExamAnswerRecord.units 是 List<ScoreUnit>，生成代码里是
-- `e as Map<String, dynamic>` —— 遇到 false 抛 CheckedFromJsonException，整份答卷
-- 解析失败，成绩单只剩一句 UnknownException 的兜底文案「操作失败，请稍后重试」。
-- **只要卷子里有一道要老师阅卷的题就必现。**
--
-- ⚠ 这只改**数据形状**，不改判分口径：主观题照旧 grading='pending'、is_correct=null、
--   score=0（占位）、整场 status='submitted'，成绩单页照旧显示「待阅卷」。
--   详见 0124（复合题/填空题一律交教师阅卷）。
--
-- 三件事：
--   1. 抽一个 exam_units_jsonb() 做形状归一；
--   2. submit_exam_attempt 的待阅卷分支改用它（rescoring 的同一处也改掉，
--      否则将来手工重算会再灌一批坏数据）；
--   3. 修已有数据：把今天已落库的布尔形状就地转成对象形状。

-- 1) 形状归一：布尔数组 → [{ok, score}]；已经是对象就原样返回。
create or replace function public.exam_units_jsonb(p_units jsonb)
returns jsonb
language sql
immutable
set search_path to 'public'
as $$
  select case
    when p_units is null or jsonb_typeof(p_units) <> 'array' then '[]'::jsonb
    when jsonb_typeof(p_units -> 0) = 'boolean' then coalesce((
      select jsonb_agg(jsonb_build_object('ok', u.value::boolean, 'score', 0) order by u.ord)
      from jsonb_array_elements(p_units) with ordinality as u(value, ord)
    ), '[]'::jsonb)
    else p_units
  end;
$$;

-- 内部辅助函数，与 exam_norm_text / grade_exam_units 同口径：不对客户端开放。
revoke all on function public.exam_units_jsonb(jsonb) from public, anon, authenticated;
grant execute on function public.exam_units_jsonb(jsonb) to service_role;

-- 2) 交卷：待阅卷分支也写 [{ok, score}]
create or replace function public.submit_exam_attempt(
  p_attempt_id uuid,
  p_answers jsonb,
  p_duration_ms bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a exam_attempts%rowtype;
  v_item record;
  v_given jsonb;
  v_res jsonb;
  v_units jsonb;
  v_n int;
  v_pending int := 0;
  v_obj numeric := 0;
begin
  select * into v_a from exam_attempts where id = p_attempt_id for update;
  if not found then raise exception '考试记录不存在'; end if;
  if v_a.user_id is distinct from v_uid then raise exception '这不是你的考试'; end if;

  if v_a.status in ('submitted', 'graded') then
    return jsonb_build_object(
      'total', v_a.total_score, 'full_score', v_a.full_score,
      'pending_review_count', v_a.pending_review_count,
      'objective_score', v_a.objective_score,
      'objective_full_score', v_a.objective_full_score);
  end if;
  if v_a.status <> 'in_progress' then raise exception '这场考试已经交卷了'; end if;

  for v_item in
    select i.id, i.seq, i.qtype, i.score, i.score_units, qv.content
    from paper_items i
    join question_versions qv on qv.id = i.question_version_id
    where i.paper_version_id = v_a.paper_version_id
    order by i.seq
  loop
    v_given := coalesce(
      (select x from jsonb_array_elements(coalesce(p_answers, '[]'::jsonb)) x
       where x ->> 'paper_item_id' = v_item.id::text limit 1) -> 'answer',
      '{}'::jsonb);
    v_n := greatest(jsonb_array_length(v_item.score_units), 1);
    v_res := public.grade_exam_units(v_item.qtype, v_item.content, v_given, v_n);
    v_units := v_res -> 'units';

    if v_res ->> 'grading' = 'manual' then
      v_pending := v_pending + 1;
      -- 统一形状（0139）：grade_exam_units 给的是布尔数组，**别再原样落库**——
      -- 客户端按对象解析，布尔会让整份答卷解析失败、成绩单只显示"操作失败"。
      v_units := public.exam_units_jsonb(v_units);
      insert into exam_answers (attempt_id, paper_item_id, seq, answer, units, auto_score, score,
                                grading, is_correct, answered_at)
      values (v_a.id, v_item.id, v_item.seq, v_given, v_units, 0, 0, 'pending', null, now())
      on conflict (attempt_id, paper_item_id) do update
        set answer = excluded.answer, units = excluded.units, grading = 'pending',
            auto_score = 0, score = 0, is_correct = null, answered_at = now();
    else
      declare
        v_score numeric;
        v_scored jsonb;
      begin
        select coalesce(jsonb_agg(jsonb_build_object(
                 'ok', (t.u)::boolean,
                 'score', case when (t.u)::boolean
                               then coalesce((v_item.score_units ->> (t.ord - 1)::int)::numeric, 0)
                               else 0 end) order by t.ord), '[]'::jsonb),
               coalesce(sum(case when (t.u)::boolean
                                 then coalesce((v_item.score_units ->> (t.ord - 1)::int)::numeric, 0)
                                 else 0 end), 0)
          into v_scored, v_score
          from jsonb_array_elements(v_units) with ordinality as t(u, ord);
        v_units := v_scored;
        v_obj := v_obj + v_score;

        insert into exam_answers (attempt_id, paper_item_id, seq, answer, units, auto_score, score,
                                  grading, is_correct, answered_at)
        values (v_a.id, v_item.id, v_item.seq, v_given, v_units, v_score, v_score,
                'auto', (v_res ->> 'is_correct')::boolean, now())
        on conflict (attempt_id, paper_item_id) do update
          set answer = excluded.answer, units = excluded.units, grading = 'auto',
              auto_score = excluded.auto_score, score = excluded.score,
              is_correct = excluded.is_correct, answered_at = now();
      end;
    end if;
  end loop;

  update exam_attempts
  set status = case when v_pending > 0 then 'submitted' else 'graded' end,
      submitted_at = now(),
      graded_at = case when v_pending = 0 then now() else null end,
      objective_score = v_obj, total_score = v_obj,
      pending_review_count = v_pending,
      duration_ms = coalesce(p_duration_ms, 0)
  where id = v_a.id;

  begin
    update exam_attempts set is_official = true
    where id = v_a.id
      and not exists (
        select 1 from exam_attempts x
        where x.paper_version_id = v_a.paper_version_id
          and x.user_id = v_a.user_id
          and x.id <> v_a.id
          and x.is_official);
  exception when unique_violation then
    update exam_attempts set is_official = false where id = v_a.id;
  end;

  return jsonb_build_object(
    'total', v_obj, 'full_score', v_a.full_score,
    'pending_review_count', v_pending,
    'objective_score', v_obj, 'objective_full_score', v_a.objective_full_score);
end;
$$;

-- 3) 手工重算（发布触发器已停用，留着备查）：同一处形状也要转。
--    只改两处 units 的写法，其余逻辑与 0115/0124 逐字一致。
create or replace function public.rescore_attempts_for_version(
  p_paper_id uuid,
  p_target_version_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target paper_versions%rowtype;
  v_full numeric;
  v_obj_full numeric;
  v_ids uuid[];
  v_id uuid;
  v_a exam_attempts%rowtype;
  v_item record;
  v_old record;
  v_had_old boolean;
  v_res jsonb;
  v_raw jsonb;
  v_units jsonb;
  v_given jsonb;
  v_answered timestamptz;
  v_n int;
  v_score numeric;
  v_obj numeric;
  v_subj numeric;
  v_pending int;
  v_matched int;
  v_old_filled int;
  v_new_filled int;
  v_scored jsonb;
  v_moved int := 0;
  v_abandoned int := 0;
  v_errors jsonb := '[]'::jsonb;
begin
  -- 发布事务内同步重算：锁等待超过 5 秒就失败，不把"发布入库"拖死。
  -- 失败会被下面的子事务 exception 接住，记进 errors，不挡入库。
  perform set_config('lock_timeout', '5s', true);

  select * into v_target from paper_versions
  where id = p_target_version_id and paper_id = p_paper_id;
  if not found then
    raise exception '目标版本不属于这份试卷';
  end if;

  -- 满分口径与 start_exam_attempt 一致：短答以外的题都算客观分（0105 起综合题也是自动判分）
  select coalesce(sum(score), 0),
         coalesce(sum(score) filter (where qtype <> 'short_answer'), 0)
    into v_full, v_obj_full
  from paper_items where paper_version_id = p_target_version_id;

  -- ---- 1) 官方成绩去重：每人只留**最新版本**上的那一次 ----
  -- 必须在搬家之前做：两个版本各有一条官方成绩的学生，搬到同一版会撞 uq_exam_official。
  --
  -- 为什么是"最新版本"而不是"最早一次"：合并前他看到的就是最新那一版上的成绩
  -- （旧规则下每个版本各算各的），所以合并后必须保住那条，否则会出现"改版前榜上 6 分、
  -- 改版后变成待阅卷"这种倒退 —— 线上 唐涛 就是这种（v1 待阅卷 0 分 + v2 已出分 6 分）。
  -- 保留最早一次会把已出分的那条降级，学生直接从榜上消失。
  with offs as (
    select a.id,
           row_number() over (
             partition by a.user_id
             order by v.version_no desc,
                      coalesce(a.submitted_at, a.started_at, a.created_at),
                      a.created_at, a.id) as rn
    from exam_attempts a
    join paper_versions v on v.id = a.paper_version_id
    where a.paper_id = p_paper_id and a.is_official
  )
  update exam_attempts a set is_official = false
  from offs o
  where o.id = a.id and o.rn > 1;

  -- ---- 2) 进行中的考试作废 ----
  update exam_attempts
  set status = 'abandoned'
  where paper_id = p_paper_id
    and paper_version_id <> p_target_version_id
    and status = 'in_progress';
  get diagnostics v_abandoned = row_count;

  -- ---- 3) 逐场搬家 + 重算 ----
  -- 先把 id 物化出来：下面会 update 这些行，边扫边改会让游标行为不可预测
  select array_agg(a.id order by a.submitted_at, a.created_at, a.id)
    into v_ids
  from exam_attempts a
  where a.paper_id = p_paper_id
    and a.paper_version_id <> p_target_version_id
    and a.status in ('submitted', 'grading', 'graded');

  if v_ids is not null then
    foreach v_id in array v_ids loop
      -- 每场一个子事务：某一场出问题只回滚这一场（delete + insert 都在里面），
      -- 不会把整场的答案留在半截状态，也不会让整次入库失败
      begin
        -- id 是上面物化出来的，这一行一定还在（这中间没有别的地方会改状态）
        -- FOR UPDATE：与 0103 的交卷串行化，避免重算读到半截答案。
        select * into v_a from exam_attempts where id = v_id for update;

        -- ⚠ 旧答案要在**删之前**读（这里曾经把 delete 放在循环前面，结果每道题都匹配不到
        -- 旧答案、全按空白重判，分数归零还覆盖了学生的作答）。删旧行放到最后，按
        -- "旧版本的题项 id"精确删。
        select count(*) filter (where aa.answer <> '{}'::jsonb)
          into v_old_filled
        from exam_answers aa where aa.attempt_id = v_id;

        v_obj := 0;
        v_subj := 0;
        v_pending := 0;
        v_matched := 0;

        for v_item in
          select i.id, i.seq, i.qtype, i.score, i.score_units,
                 i.question_id, i.question_version_id, qv.content
          from paper_items i
          join question_versions qv on qv.id = i.question_version_id
          where i.paper_version_id = p_target_version_id
          order by i.seq
        loop
          select oi.question_version_id as qv_id, oi.score as item_score,
                 oi.score_units as item_units,
                 pa.answer, pa.units, pa.auto_score, pa.score, pa.manual_score,
                 pa.grading, pa.is_correct, pa.comment, pa.scored_by, pa.scored_at,
                 pa.answered_at
            into v_old
          from paper_items oi
          join exam_answers pa on pa.paper_item_id = oi.id and pa.attempt_id = v_id
          where oi.paper_version_id = v_a.paper_version_id
            and oi.question_id = v_item.question_id
          limit 1;
          v_had_old := found;
          if v_had_old then
            v_matched := v_matched + 1;
          end if;

          if v_had_old then
            -- 题没改（同题版本、同分值、同给分点）：原样搬，人工判分也一起搬
            if v_old.qv_id = v_item.question_version_id
               and v_old.item_score = v_item.score
               and v_old.item_units = v_item.score_units then
              insert into exam_answers (attempt_id, paper_item_id, seq, answer, units,
                                        auto_score, manual_score, score, grading, is_correct,
                                        comment, scored_by, scored_at, answered_at)
              values (v_id, v_item.id, v_item.seq, v_old.answer,
                      -- 搬过来的旧行可能是 0139 之前的布尔形状，顺手归一
                      public.exam_units_jsonb(v_old.units),
                      v_old.auto_score, v_old.manual_score, v_old.score, v_old.grading,
                      v_old.is_correct, v_old.comment, v_old.scored_by, v_old.scored_at,
                      v_old.answered_at);

              if v_old.grading = 'pending' then
                v_pending := v_pending + 1;
              elsif v_old.grading = 'manual' then
                v_subj := v_subj + coalesce(v_old.score, 0);
              else
                v_obj := v_obj + coalesce(v_old.score, 0);
              end if;
              continue;
            end if;

            v_given := coalesce(v_old.answer, '{}'::jsonb);
            v_answered := v_old.answered_at;
          else
            -- 新版新增的题：没答过，按空白判
            v_given := '{}'::jsonb;
            v_answered := null;
          end if;

          -- 题改过 / 新版新增：用新版答案重判
          v_n := greatest(jsonb_array_length(v_item.score_units), 1);
          v_res := public.grade_exam_units(v_item.qtype, v_item.content, v_given, v_n);
          v_raw := v_res -> 'units';

          if v_res ->> 'grading' = 'manual' then
            v_pending := v_pending + 1;
            insert into exam_answers (attempt_id, paper_item_id, seq, answer, units,
                                      auto_score, score, grading, is_correct, answered_at)
            values (v_id, v_item.id, v_item.seq, v_given,
                    -- 与 submit_exam_attempt 同一口径（0139）
                    public.exam_units_jsonb(v_raw),
                    0, 0, 'pending', null,
                    coalesce(v_answered, v_a.submitted_at, now()));
          else
            -- 计分点逐个算分：与 submit_exam_attempt 同一段逻辑，抽成 score_exam_units
            v_scored := public.score_exam_units(v_raw, v_item.score_units);
            v_units := v_scored -> 'units';
            v_score := (v_scored ->> 'score')::numeric;

            v_obj := v_obj + v_score;
            insert into exam_answers (attempt_id, paper_item_id, seq, answer, units,
                                      auto_score, score, grading, is_correct, answered_at)
            values (v_id, v_item.id, v_item.seq, v_given, v_units, v_score, v_score,
                    'auto', (v_res ->> 'is_correct')::boolean,
                    coalesce(v_answered, v_a.submitted_at, now()));
          end if;
        end loop;

        -- 防御：这场本来有作答（非空答案），重算后却一条非空都没有 —— 说明映射坏了。
        -- 宁可这一场不动（子事务回滚），也不能把学生的答案写成空白。
        select count(*) filter (where aa.answer <> '{}'::jsonb)
          into v_new_filled
        from exam_answers aa
        join paper_items i on i.id = aa.paper_item_id
        where aa.attempt_id = v_id and i.paper_version_id = p_target_version_id;

        if v_old_filled > 0 and (v_matched = 0 or v_new_filled = 0) then
          raise exception '这场考试有 % 条非空作答，却一条都没映射到新版（匹配 % 条），已跳过',
            v_old_filled, v_matched;
        end if;

        -- 防御二：原来有分、重算后归零 —— 小范围改题不可能把整场打成 0 分。
        -- 这条能挡住"读不到旧答案就按空白重判"那类故障（0115 第一版就是这么翻车的）。
        -- ⚠ 但 v_pending > 0 是例外：人工题改版后回 pending 是正常态（等教师重判），
        -- 总分暂时为 0 不代表映射坏了；把它跳过反而会让整场留在旧版本、榜上消失。
        if v_a.total_score > 0 and (v_obj + v_subj) = 0 and v_pending = 0 then
          raise exception '这场考试原来 % 分、重算后 0 分，已跳过', v_a.total_score;
        end if;

        update exam_attempts
        set paper_version_id = p_target_version_id,
            full_score = v_full,
            objective_full_score = v_obj_full,
            objective_score = v_obj,
            subjective_score = v_subj,
            total_score = v_obj + v_subj,
            pending_review_count = v_pending,
            status = case when v_pending > 0 then 'submitted' else 'graded' end,
            graded_at = case when v_pending > 0 then null
                             else coalesce(v_a.graded_at, now()) end,
            graded_by = case when v_pending > 0 then null else v_a.graded_by end
        where id = v_id;

        -- 最后才删旧版本的答题行：按"旧版本的题项 id"删，新的行已经挂在目标版本的题项上了
        delete from exam_answers aa
        using paper_items i
        where aa.paper_item_id = i.id
          and aa.attempt_id = v_id
          and i.paper_version_id = v_a.paper_version_id;

        v_moved := v_moved + 1;
      exception when others then
        -- 单场失败不挡入库：记下来，由调用方写进审计
        v_errors := v_errors || jsonb_build_object('attempt_id', v_id, 'error', sqlerrm);
      end;
    end loop;
  end if;

  -- 不把 5 秒的锁超时泄漏给调用方（发布事务后续语句）
  perform set_config('lock_timeout', '0', true);

  return jsonb_build_object(
    'paper_id', p_paper_id, 'version_id', p_target_version_id,
    'moved', v_moved, 'abandoned', v_abandoned,
    'errors', v_errors);
end;
$$;

-- 4) 修已落库的旧形状（2026-11-05 当天交的 23 场，69 行）。
--    判据用「首元素是布尔」而不是只判 grading='pending'：已经阅卷过的行本来就是对象，
--    重写一遍没有意义。**只动 units，不碰 grading / score / is_correct / 状态。**
update public.exam_answers ea
set units = public.exam_units_jsonb(ea.units)
where ea.grading = 'pending'
  and jsonb_typeof(ea.units) = 'array'
  and jsonb_typeof(ea.units -> 0) = 'boolean';
