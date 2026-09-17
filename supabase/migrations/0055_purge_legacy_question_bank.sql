-- 0055: 一次性清空旧题库（2026-09-16 那批导入），为重新解析让路。
--
-- 背景：2026-09-16 06:01 的导入任务 ad505cdb 从一份真题里入库了 94 道题，
-- 全部走到 questions=live / question_versions=published / approvals=approved。
-- 那份解析质量不达标——正文里一个答案都没有，提示词当时又写着「抽不出答案
-- 不要编造」，结果 109 条解析只入库 94 条（0054 就是为此把提示词改成
-- 「AI 负责推导答案，教师复核」）。产品决定整批重来。
--
-- 为什么需要一个"关触发器"的迁移：题库**按设计**没有删除入口。
--   · delete_question_draft 只允许删「从未提交过的纯草稿」
--   · guard_version_immutable  —— 非 draft 版本不可删
--   · guard_approval_immutable —— 已决（approved/returned/cancelled）审批不可删
-- 这两道守卫是 BEFORE DELETE 触发器，而级联删除正是以 BEFORE DELETE 的形式
-- 作用在子表上的，所以删主档必然撞上它们。这里显式关掉、做完删除再开回来。
--
-- 刻意不引入长期逃生舱：guard_version_immutable 里已有的 app.allow_supersede
-- 是**有产品语义**的事务开关（换版流程专用），不是通用后门。清库是运维动作，
-- 一次性做完即可，不给守卫留一条常驻的绕过路径。
--
-- 级联带走：question_versions / approvals / version_tags / version_media /
--          practice_session_items / practice_answers / question_favorites
-- 置空保留：audit_log.question_id、import_job_items.question_id|version_id
--          （audit_log 是操作留痕，本就该保留；见下面对 import_job_items 的处理）
--
-- 顺带修一类既有脏数据：锚点复位那一句的条件是「status=imported 但
-- question_id 为空」——本次删除会造出 94 条，同时也会清掉 49058d37 那个任务里
-- 早就存在的一条孤儿锚点（它的题目早没了，但 status 还写着 imported，
-- 重跑该任务会空回 id）。
--
-- 环境相关：job id 是硬编码的，所以在全新库上找不到目标、直接跳过（no-op）。

do $$
declare
  v_job    constant uuid := 'ad505cdb-2f02-45bf-9425-3efe6e221f50';
  v_qids   uuid[];
  v_q      int;
  v_v      int;
  v_a      int;
  v_tags   int;
  v_psi    int;
  v_pa     int;
  v_anchor int;
  v_sess   int;
begin
  -- 目标集合必须在关闭守卫**之前**定格：删除时 import_job_items.question_id
  -- 会被级联置空，之后再想靠它反查就找不回来了。
  select array_agg(q.id) into v_qids
  from public.questions q
  join public.import_job_items i on i.question_id = q.id
  where i.job_id = v_job;

  if v_qids is null then
    raise notice '0055: 未找到任务 % 入库的题目，跳过（全新环境属正常）', v_job;
    return;
  end if;

  -- 先关守卫，再碰这两张表，避免同会话内「表正被活动查询使用」的 DDL 冲突
  execute 'alter table public.question_versions disable trigger trg_versions_guard';
  execute 'alter table public.approvals        disable trigger trg_approvals_guard';

  -- 行数要在删之前数：删完就查不出来了
  select count(*) into v_v    from public.question_versions where question_id = any(v_qids);
  select count(*) into v_a    from public.approvals         where question_id = any(v_qids);
  select count(*) into v_tags from public.version_tags
    where version_id in (select id from public.question_versions where question_id = any(v_qids));
  select count(*) into v_psi  from public.practice_session_items where question_id = any(v_qids);
  select count(*) into v_pa   from public.practice_answers       where question_id = any(v_qids);

  -- 动态 SQL：确保这次删除用的是执行时刻的触发器状态，而不是缓存的计划
  execute 'delete from public.questions where id = any($1)' using v_qids;
  get diagnostics v_q = row_count;

  execute 'alter table public.question_versions enable trigger trg_versions_guard';
  execute 'alter table public.approvals        enable trigger trg_approvals_guard';

  -- 幂等锚点复位：import_commit_items 见到 status='imported' 就直接回传
  -- question_id/version_id，而这两个字段刚被级联置空了。不复位的话该任务
  -- 一旦重跑，每一题都会"成功"返回 null id。条件写成通用形式，顺手清掉
  -- 历史上同类的孤儿锚点。
  update public.import_job_items
  set status = 'pending', question_id = null, version_id = null
  where status = 'imported' and question_id is null;
  get diagnostics v_anchor = row_count;

  -- 练习会话的**表头**不会被上面那句级联带走：practice_sessions 只是会话元数据
  -- （total_count/正确率/耗时），题目挂在 practice_session_items 上，而后者已经
  -- 被清空了。留着就成了一排"共 7 题"但点进去逐题回顾为空的空壳——
  -- 客户端 fetchHistory 是直查 practice_sessions、不 join 明细的，看不出异常。
  -- 判据用"没有明细行"而不是列 id：这就是被掏空的那批，也是唯一该清的一批。
  delete from public.practice_sessions ps
  where not exists (
    select 1 from public.practice_session_items i where i.session_id = ps.id);
  get diagnostics v_sess = row_count;

  raise notice '0055: 删除 questions=% versions=% approvals=% version_tags=% practice_items=% practice_answers=% / 复位锚点=% / 清空壳会话=%',
    v_q, v_v, v_a, v_tags, v_psi, v_pa, v_anchor, v_sess;
end $$;

-- 本迁移不删任何对象存储里的文件：version_media 为空（这批题没有引用媒体），
-- 因此不会产生待 GC 的孤儿媒体；4 行 media_objects 是头像等，与本题库无关。
