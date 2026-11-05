-- 0142: 班级 AI 分析页「页面加载失败」——_class_ai_data 的权限判断改成一次性求值
--
-- 现象（2026-11-05 17:08、18:08 两次）：打开「AI 分析 · 计算机 2 班 · 2025 单招卷」
-- 只看到错误边界的「页面加载失败」。数据库日志里是 class_ai_report 的
-- **57014 statement_timeout** —— authenticated 角色的 statement_timeout 是 8s。
-- pg_stat_statements：31 次调用，平均 2321ms、最慢 6389ms，离 8s 只差一点，
-- 稍有负载就超时；同一条链路上的 class_lesson_plan 也超时过两次。
--
-- 根因不是数据量，而是**逐行调用权限函数**：
--   _class_ai_data 在 practice_answers（整班 30 天的练习）和 exam_attempts 上
--   对每一行调 public.can_view_student(user_id)，而它内部还有 is_admin /
--   is_school_admin / is_teacher 和递归的 major_subtree_ids()。
--   一张几万行的练习表就是几万次递归查询。
--
-- 改法：可见学生 id **只算一次**，后面一律 `= any(uuid[])`。
--   改后实测：class_ai_report 2321ms→124ms，class_ai_payload→122ms，
--   class_lesson_plan→229ms；输出 JSON 与改前**逐字节一致**（md5 相同）。
--
-- 这里用"改写函数体"而不是整段重写：函数 14KB，手抄只会引入新错。
-- 每条替换都有数量断言：将来若有人改过这段文本，迁移会**报错**而不是静默放过。

do $$
declare
  src text;
begin
  select prosrc into src
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = '_class_ai_data';

  if src is null then
    raise exception '_class_ai_data 不存在，0142 无从改写';
  end if;
  if src ilike '%v_uids uuid[]%' then
    return;  -- 已应用过，幂等
  end if;

  if (select count(*) from regexp_matches(src, 'public\.can_view_student\(p\.user_id\)', 'g')) <> 2
     or (select count(*) from regexp_matches(src, 'public\.can_view_student\(a\.user_id\)', 'g')) <> 1
     or (select count(*) from regexp_matches(src, 'select count\(\*\)::int into v_students', 'g')) <> 1 then
    raise exception '函数体与 0142 预期不一致（权限调用点数量对不上）——请人工重写 _class_ai_data，不要自动改写';
  end if;

  -- 1) 两处逐行调用先统一成数组匹配（表头那句也在内，下一步整句重建）
  src := regexp_replace(src, 'public\.can_view_student\(p\.user_id\)', 'p.user_id = any(v_uids)', 'g');
  src := regexp_replace(src, 'public\.can_view_student\(a\.user_id\)', 'a.user_id = any(v_uids)', 'g');

  -- 2) 重建"可见学生"：用真正的权限函数**只算一次** id 数组
  src := regexp_replace(
    src,
    'select count\(\*\)::int into v_students\s+from profiles p where p\.class_id = p_class_id and p\.user_id = any\(v_uids\);',
    $re$select coalesce(array_agg(p2.user_id), '{}'::uuid[]) into v_uids
  from profiles p2 where p2.class_id = p_class_id and public.can_view_student(p2.user_id);
  v_students := coalesce(array_length(v_uids, 1), 0);$re$,
    'g');

  -- 3) 声明（PL/pgSQL 每条声明单独结尾，不能用逗号合并）
  src := replace(src, 'v_p_from timestamptz;',
                 'v_p_from timestamptz;' || chr(10) || '  v_uids uuid[];');

  execute 'create or replace function public._class_ai_data(p_paper_id uuid, p_class_id uuid) '
       || 'returns jsonb language plpgsql stable security definer set search_path = public as $fn$'
       || src || '$fn$';
end
$$;
