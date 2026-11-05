-- 0115: 试卷改版入库时，旧交卷按**新版答案**重算并迁到新版
--
-- ⚠ **2026-11-02 产品口径反转，本文件的「发布时迁移/重算」已停用（见 0118）。**
-- 发布新版不再影响旧版成绩：旧场次留在原版本，成绩榜跨版本取每人最新一次。
-- 下面的函数保留仅备手工修复；**不要把触发器重新启用**。
--
-- 用户 2026-10-29 报：组卷库的「四川省2024年高职教育单招」（计算机类试题）
-- 发布第三版后，之前 119 名学生的成绩在成绩榜上"不在了"。
--
-- 线上实况（本次核对）：
--   v1 superseded    5 场（2 场官方，0 出分）
--   v2 superseded  130 场，**119 场官方已出分**   ← 成绩全在这里
--   v3 current       0 场（2026-10-29 发布）
--   v3 与 v2 只差第 36 题的一次编辑：59 道题里 58 道的 question_version_id 完全相同，
--   满分同为 200 —— 这就是同一场考试改了个错。
--
-- 产品口径（用户 2026-10-29 原话）：
--   **"改一版都是小范围题目的改，所以成绩请按照改版后的答案重新计算分数排名即可"**
--   → 不分成两张榜：把旧交卷**迁到新版**，用**新版答案**重算分数，在原榜上排名。
--
-- 为什么这么做（改之前先读）：
--   1) 所有读路径天然一致。排行榜（0077）、试题分析（0078）、班级学情（0087）、
--      班级 AI 分析（0088）都只看 current_published_version_id —— 迁移后它们
--      **一行都不用改**，也不会出现"排行有数据、试题分析是空的"这种半截状态；
--   2) 学生填的答案原样保留，只是换了判分依据：成绩单里看到的是
--      "我当时的答案 + 按新版答案判的分"。
--
-- 映射规则：**按 question_id，不按 seq**。
--   同一道题改内容（换 question_version）仍然是同一道题；整道题被换掉时 question_id 会变，
--   旧答案就不会被错安到新题上。线上核过：没有任何一份卷面里同一道题出现两次。
--
-- 判分规则（与 submit_exam_attempt / finish_exam_grading 完全同源，别在这里另写一套）：
--   · 题**没改**（同 question_version_id、同 score、同 score_units）→ **原样搬**，
--     人工判分的结果（manual_score / comment / scored_by）也一起搬，不重新判；
--   · 题**改过**或新版**新增** → 用 grade_exam_units(新版 content) 重判：
--     自动判分的直接落分；人工判分的回到 pending（教师必须重判，榜单只收 graded）；
--   · 旧版有、新版没有的题 → 它的答案不再计入（这道题在新版卷面上不存在）。
--   重算后：objective_score = sum(score) where grading='auto'，
--           subjective_score = sum(score) where grading='manual'，
--           total_score = 两者之和；还有 pending 就退回 status='submitted'。
--
-- 同一个学生在新旧两版都交过卷时**只保留最新版本上的那一条官方成绩**，其余降为自主练习：
-- uq_exam_official 是 (paper_version_id, user_id) 唯一，搬到同一版会直接撞索引。
-- 选"最新版本"而不是"最早一次"：合并前他看到的就是最新那一版上的成绩，
-- 保住它才不会有"改版前榜上有分、改版后变成待阅卷"的倒退。
--
-- **进行中的考试一律作废**（status='abandoned'）：卷面已经不是他打开时那一份了，
-- 让他交上来只会得到一份按新卷判的、半截的答案。
--
-- ⚠ 入库时自动跑（papers.current_published_version_id 的 AFTER UPDATE 触发器）。补跑 / 手工修：
--     select public.rescore_attempts_for_version('<paper_id>', '<version_id>');
--   它是幂等的：已经在目标版本上的场次不会被再处理一次。
--
-- ⚠ 0115 草稿期建过一个 resolve_paper_version（按版本分榜的方案），已废弃，这里删掉。

drop function if exists public.resolve_paper_version(uuid, uuid);

-- =====================================================================
-- 0) 判分点聚合：与 submit_exam_attempt（0103）同一段逻辑，抽出来共用。
--    ⚠ 0103 是已应用的交卷主链路，本轮不重写它；新路径（0115）先接这个 helper。
--    将来改判分口径只改这里，别再抄第二份。
-- =====================================================================
create or replace function public.score_exam_units(p_raw jsonb, p_score_units jsonb)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_build_object(
    'units', coalesce(jsonb_agg(jsonb_build_object(
               'ok', (t.u)::boolean,
               'score', case when (t.u)::boolean
                             then coalesce((p_score_units ->> (t.ord - 1)::int)::numeric, 0)
                             else 0 end) order by t.ord), '[]'::jsonb),
    'score', coalesce(sum(case when (t.u)::boolean
                               then coalesce((p_score_units ->> (t.ord - 1)::int)::numeric, 0)
                               else 0 end), 0))
  from jsonb_array_elements(coalesce(p_raw, '[]'::jsonb)) with ordinality as t(u, ord);
$$;

-- 0115 的逐场重算按 paper_item_id 查旧答题行；0051 只有 (attempt_id, seq)。
create index if not exists idx_exam_answers_paper_item
  on public.exam_answers (paper_item_id);

-- 0051 的注释说 full_score 起考时冻结；0115 起改版会把旧交卷迁到新版并按新版
-- 卷面重算，分母也随新版更新。同步注释，避免下一个人按旧口径推理。
comment on column public.exam_attempts.full_score is
  '满分快照；起考时冻结，0115 起试卷改版入库时按新版卷面重算（rescore_attempts_for_version）';

-- =====================================================================
-- 1) 核心：把旧版本的交卷搬到目标版本，并按目标版本的答案重算
-- =====================================================================
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
              values (v_id, v_item.id, v_item.seq, v_old.answer, v_old.units,
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
            values (v_id, v_item.id, v_item.seq, v_given, v_raw, 0, 0, 'pending', null,
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

-- 内部函数：只由下面的触发器调用（definer 身份），不对任何角色开放
revoke execute on function public.rescore_attempts_for_version(uuid, uuid)
  from public, anon, authenticated;

-- =====================================================================
-- 2) 挂到"入库"这件事上：AFTER UPDATE OF current_published_version_id
-- =====================================================================
-- 为什么用触发器而不是在 review_decide_paper 里加一行：那是 100 行审批逻辑
-- （退回 / 组长 / 市级 / 上线 / 下线），重抄一遍只为加一行调用不划算，
-- 抄错一个分支就是审批故障。用触发器还顺带覆盖了"别处直接改 current_published_version_id"
-- 的路径。WHEN 子句保证只有版本真的换了才跑（首次入库空跑，没有旧场次）。
create or replace function public.trg_papers_rescore_on_publish()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_res jsonb;
begin
  v_res := public.rescore_attempts_for_version(new.id, new.current_published_version_id);
  -- 留痕：改版时迁了多少场、作废了多少场、哪几场失败过
  perform public.paper_audit('rescore_attempts', new.id, new.current_published_version_id, v_res);
  return null;
end;
$$;

-- 触发器函数不能被直接调用（返回 trigger 类型），不需要 revoke；
-- 它自己是 security definer，所以有权调被 revoke 的 rescore_attempts_for_version。

drop trigger if exists trg_papers_rescore_on_publish on public.papers;
create trigger trg_papers_rescore_on_publish
  after update of current_published_version_id on public.papers
  for each row
  when (old.current_published_version_id is distinct from new.current_published_version_id
        and new.current_published_version_id is not null)
  execute function public.trg_papers_rescore_on_publish();

-- 2026-11-02 口径反转：默认停用，避免新环境一跑就迁旧场次（0118 也会再停一次）。
alter table public.papers disable trigger trg_papers_rescore_on_publish;

-- =====================================================================
-- 3) 回填：**2026-11-02 起不再自动执行**
--    旧口径是「把落在旧版本上的成绩迁到当前版本」；新口径是「旧版成绩不迁移、
--    不重算，成绩榜跨版本取每人最新一次」。确需手工修复时，先备份，再显式调用
--    public.rescore_attempts_for_version(paper_id, version_id)。
-- =====================================================================

notify pgrst, 'reload schema';
