-- 0118: 成绩榜跨版本合并（每人取最新一次官方成绩）
--
-- 产品口径变更（2026-11-02，用户原话）：
--   **"试卷发布新版后，不应该影响旧版的考试成绩。因为发布新版大多是某道题有问题。"**
--   → 发布新版不再迁移/重算旧场次（0115 的触发器已停用）；
--   → 成绩榜不再只看 current_published_version_id，而是**跨版本**取
--     每个学生**最新一次官方场次**：旧版成绩保留，新版考了就以新版为准。
--
-- 与旧 0115 的口径相反，所以：
--   · 触发器 trg_papers_rescore_on_publish 停用（保留函数以备手工修复）；
--   · paper_leaderboard 的 ranked CTE 改为「先取每人最新一次官方场次，再只收 graded」；
--   · class_exam_results 的 parts CTE 同样改为「每人每卷最新一次官方场次」；
--   · paper_question_stats 仍只看当前入库版本（逐题分析必须绑定一份卷面），
--     页面上的 other_version_skipped 只属于试题分析页签。
--
-- 做法沿用 0112：读线上定义 + 定点替换 + 逐一断言，不重抄 11KB 函数。

alter table public.papers disable trigger trg_papers_rescore_on_publish;

do $$
declare
  v_def text;
  v_new text;
begin
  ------------------------------------------------------------------
  -- 1) paper_leaderboard：跨版本，每人取最新一次官方成绩
  ------------------------------------------------------------------
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = 'paper_leaderboard';
  if v_def is null then raise exception '找不到 paper_leaderboard'; end if;

  -- 1.1 我在这场卷子上的状态：从「当前版本」改成「整份卷的最新一次官方场次」
  v_new := replace(
    v_def,
    E'  where x.paper_version_id = v_ver.id and x.user_id = v_uid\n  order by x.is_official desc, coalesce(x.submitted_at, x.started_at) desc',
    E'  where x.paper_id = p_paper_id and x.user_id = v_uid\n  order by x.is_official desc, (select v.version_no from paper_versions v where v.id = x.paper_version_id) desc, coalesce(x.submitted_at, x.started_at) desc');
  if v_new = v_def then raise exception 'paper_leaderboard viewer 查询与预期不符'; end if;
  v_def := v_new;

  -- 1.2 未出分计数：按每人最新一次官方场次算（不是按版本）
  v_new := replace(
    v_def,
    E'  from exam_attempts a join profiles p on p.user_id = a.user_id\n  left join schools s on s.id = p.school_id\n  where a.paper_version_id = v_ver.id and a.is_official\n    and a.status in (''submitted'', ''grading'')',
    E'  from (\n    select distinct on (a.user_id) a.*\n    from exam_attempts a\n    join paper_versions v on v.id = a.paper_version_id\n    where a.paper_id = p_paper_id and a.is_official\n    order by a.user_id, v.version_no desc,\n             coalesce(a.submitted_at, a.started_at) desc, a.id desc\n  ) a join profiles p on p.user_id = a.user_id\n  left join schools s on s.id = p.school_id\n  where a.is_official\n    and a.status in (''submitted'', ''grading'')');
  if v_new = v_def then raise exception 'paper_leaderboard 未出分计数与预期不符'; end if;
  v_def := v_new;

  -- 1.3 旧版场次不再“跳过”，合并计数归零
  v_new := replace(
    v_def,
    E'  select count(*)::int into v_other\n  from exam_attempts a\n  where a.paper_id = p_paper_id and a.paper_version_id <> v_ver.id and a.is_official\n    and a.status in (''submitted'', ''grading'', ''graded'');',
    E'  v_other := 0; -- 0118 起跨版本合并，旧版不再跳过');
  if v_new = v_def then raise exception 'paper_leaderboard old-version 计数与预期不符'; end if;
  v_def := v_new;

  -- 1.4 ranked：先取每人最新一次官方场次，再只收 graded
  v_new := replace(
    v_def,
    E'      from exam_attempts a\n      join profiles p on p.user_id = a.user_id\n      left join classes c on c.id = p.class_id\n      left join schools s on s.id = p.school_id\n      left join cities ci on ci.id = s.city_id\n      where a.paper_version_id = v_ver.id and a.is_official and a.status = ''graded''',
    E'      from (\n        select distinct on (a.user_id) a.*\n        from exam_attempts a\n        join paper_versions v on v.id = a.paper_version_id\n        where a.paper_id = p_paper_id and a.is_official\n        order by a.user_id, v.version_no desc,\n                 coalesce(a.submitted_at, a.started_at) desc, a.id desc\n      ) a\n      join profiles p on p.user_id = a.user_id\n      left join classes c on c.id = p.class_id\n      left join schools s on s.id = p.school_id\n      left join cities ci on ci.id = s.city_id\n      where a.status = ''graded''');
  if v_new = v_def then raise exception 'paper_leaderboard ranked 来源与预期不符'; end if;

  execute v_new;
end $$;

do $$
declare
  v_def text;
  v_new text;
begin
  ------------------------------------------------------------------
  -- 2) class_exam_results：每人每卷取最新一次官方场次（跨版本）
  ------------------------------------------------------------------
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = 'class_exam_results';
  if v_def is null then raise exception '找不到 class_exam_results'; end if;

  v_new := replace(
    v_def,
    E'  with parts as (\n    select a.id as attempt_id, a.user_id, p.name,\n           a.paper_id, a.total_score, a.full_score, a.status,\n           a.duration_ms, coalesce(a.submitted_at, a.started_at) as at\n    from exam_attempts a\n    join profiles p on p.user_id = a.user_id\n    join papers pa on pa.id = a.paper_id\n      and pa.current_published_version_id = a.paper_version_id\n    where p.class_id = p_class_id\n      and public.can_view_student(a.user_id)\n      and a.is_official\n      and a.status in (''submitted'', ''grading'', ''graded'')\n  ),',
    E'  with parts as (\n    select distinct on (a.paper_id, a.user_id)\n           a.id as attempt_id, a.user_id, p.name,\n           a.paper_id, a.total_score, a.full_score, a.status,\n           a.duration_ms, coalesce(a.submitted_at, a.started_at) as at\n    from exam_attempts a\n    join profiles p on p.user_id = a.user_id\n    join paper_versions v on v.id = a.paper_version_id\n    where p.class_id = p_class_id\n      and public.can_view_student(a.user_id)\n      and a.is_official\n      and a.status in (''submitted'', ''grading'', ''graded'')\n    order by a.paper_id, a.user_id, v.version_no desc,\n             coalesce(a.submitted_at, a.started_at) desc, a.id desc\n  ),');
  if v_new = v_def then raise exception 'class_exam_results parts 与预期不符'; end if;

  execute v_new;
end $$;

do $$
declare
  v_def text;
  v_new text;
begin
  ------------------------------------------------------------------
  -- 3) resolve_paper_scope：系统管理员的「全校/全市」以试卷所属学校为准
  --    （否则平台管理员看到的是自己所在的「市级题库平台」，不是出卷学校）
  ------------------------------------------------------------------
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = 'resolve_paper_scope';
  if v_def is null then raise exception '找不到 resolve_paper_scope'; end if;

  v_new := replace(
    v_def,
    E'      v_school := coalesce(v_school, v_me.school_id,\n                           (select school_id from papers where id = p_paper_id));',
    E'      if public.is_admin() then\n        v_school := coalesce(v_school, (select school_id from papers where id = p_paper_id));\n      else\n        v_school := coalesce(v_school, v_me.school_id,\n                             (select school_id from papers where id = p_paper_id));\n      end if;');
  if v_new = v_def then raise exception 'resolve_paper_scope school 与预期不符'; end if;
  v_def := v_new;

  v_new := replace(
    v_def,
    E'      v_city := coalesce(v_city,\n                         (select s.city_id from schools s where s.id = v_me.school_id),\n                         (select s.city_id from papers pp join schools s on s.id = pp.school_id\n                           where pp.id = p_paper_id));',
    E'      if public.is_admin() then\n        v_city := coalesce(v_city,\n                           (select s.city_id from papers pp join schools s on s.id = pp.school_id\n                             where pp.id = p_paper_id),\n                           (select s.city_id from schools s where s.id = v_me.school_id));\n      else\n        v_city := coalesce(v_city,\n                           (select s.city_id from schools s where s.id = v_me.school_id),\n                           (select s.city_id from papers pp join schools s on s.id = pp.school_id\n                             where pp.id = p_paper_id));\n      end if;');
  if v_new = v_def then raise exception 'resolve_paper_scope city 与预期不符'; end if;

  execute v_new;
end $$;

notify pgrst, 'reload schema';
