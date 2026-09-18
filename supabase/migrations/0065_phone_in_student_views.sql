-- 0065: 手机号登录（续）—— 学生列表 / 学生详情 / 删除审计带上手机号。
--
-- 0064 解决的是「能注册、能落库」；这一版补的是**展示层的数据源**。
-- 没有这一步，前端就算想显示手机号也拿不到 —— list_my_students / my_student_detail
-- 只返回 email，教师看到的就是 13800138000@phone.myquiz.cn 那个合成地址（见 lib/phone.js）。

-- ---------------------------------------------------------------------------
-- 1) list_my_students：返回列加 phone，关键词也搜手机号
-- ---------------------------------------------------------------------------
-- 返回列变了，**必须 DROP 重建**（CREATE OR REPLACE 改不了 RETURNS TABLE 的列定义）。
-- DROP 会连授权一起丢掉，所以下面重建后要手工补回 —— 这正是 0064/迁移时踩过的坑：
-- 新项目自带的默认权限会在 CREATE 时自动把 EXECUTE 授给 anon，必须显式收回。
drop function if exists public.list_my_students(uuid, boolean, text, integer, integer);

create function public.list_my_students(
  p_class_id uuid default null,
  p_only_unassigned boolean default false,
  p_keyword text default null,
  p_limit integer default 100,
  p_offset integer default 0)
returns table(
  user_id uuid, name text, email text, phone text, avatar_url text,
  school_id uuid, class_id uuid, class_name text, class_is_active boolean,
  enroll_year smallint, major_category text, major text,
  session_count bigint, answered_count bigint, correct_count bigint, graded_count bigint,
  last_practiced_at timestamp with time zone, total_count bigint)
language plpgsql
stable security definer
set search_path = public
as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 100), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_kw text := nullif(btrim(coalesce(p_keyword, '')), '');
begin
  perform public.require_uid();
  -- 注意：plpgsql 的 OUT 参数名与列名同名，**下面所有列引用都必须带表别名**，
  -- 否则会静默取到 OUT 参数（NULL）而不是表里的列。
  return query
  with page as materialized (
    select pr.user_id as uid, pr.name as pname, pr.email as pemail, pr.phone as pphone,
           pr.avatar_url as pavatar,
           pr.school_id as pschool, pr.class_id as pclass,
           coalesce(c.name, pr.class_name) as cname,
           c.is_active as cactive,
           pr.enroll_year as pyear, pr.major_category as pcat, pr.major as pmajor,
           count(*) over () as tcount
    from profiles pr
    left join classes c on c.id = pr.class_id
    where pr.identity = 'student'
      and public.can_view_student(pr.user_id)
      and (case when p_only_unassigned then pr.class_id is null
                when p_class_id is not null then pr.class_id = p_class_id
                else true end)
      and (v_kw is null
           or pr.name ilike '%' || v_kw || '%'
           or pr.email ilike '%' || v_kw || '%'
           -- 教师经常直接拿手机号找学生，搜索必须认它
           or pr.phone ilike '%' || v_kw || '%')
    order by pr.name nulls last, pr.user_id
    limit v_limit offset v_offset
  )
  -- materialized 不能省：否则 LIMIT 会在下面两个 lateral 聚合**之后**才生效。
  select g.uid, g.pname, g.pemail, g.pphone, g.pavatar, g.pschool, g.pclass, g.cname, g.cactive,
         g.pyear, g.pcat, g.pmajor,
         coalesce(s.scount, 0), coalesce(a.acount, 0), coalesce(a.ccount, 0), coalesce(a.gcount, 0),
         greatest(s.slast, a.alast), g.tcount
  from page g
  left join lateral (
    select count(*) as scount, max(ps.started_at) as slast
    from practice_sessions ps
    where ps.user_id = g.uid and ps.status <> 'abandoned'
  ) s on true
  left join lateral (
    -- graded_count 只数客观题（grading='auto'）—— 与 question_accuracy 同口径。
    select count(*) as acount,
           count(*) filter (where pa.is_correct) as ccount,
           count(*) filter (where pa.grading = 'auto') as gcount,
           max(pa.answered_at) as alast
    from practice_answers pa
    where pa.user_id = g.uid
  ) a on true
  order by g.pname nulls last, g.uid;
end;
$$;

-- 补回授权：DROP 把它们一起删了。顺序要紧 —— 先 revoke 掉默认继承来的 anon，
-- 再按原样授给 authenticated / service_role / postgres（与 DROP 前的 ACL 一致）。
revoke all on function public.list_my_students(uuid, boolean, text, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_my_students(uuid, boolean, text, integer, integer)
  to authenticated;
grant execute on function public.list_my_students(uuid, boolean, text, integer, integer)
  to service_role;
grant execute on function public.list_my_students(uuid, boolean, text, integer, integer)
  to postgres;

-- ---------------------------------------------------------------------------
-- 2) my_student_detail：返回的 student 对象加 phone
-- ---------------------------------------------------------------------------
-- 签名没变，用 CREATE OR REPLACE，ACL 不会被重置。
create or replace function public.my_student_detail(p_student_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path = public
as $$
declare
  v_s profiles%rowtype;
  v_sessions jsonb;
  v_wrong jsonb;
  v_nodes jsonb;
  v_exams jsonb;
begin
  perform public.require_uid();
  if not public.can_view_student(p_student_id) then
    raise exception '你只能查看本校且专业匹配的学生' using errcode = '42501';
  end if;

  select * into v_s from profiles where user_id = p_student_id;
  if not found then
    raise exception '学生不存在';
  end if;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.started_at desc), '[]'::jsonb) into v_sessions
  from (
    select ps.id, ps.source, ps.subject_node_id, ps.total_count, ps.answered_count,
           ps.correct_count, ps.status, ps.started_at, ps.submitted_at, ps.duration_ms
    from practice_sessions ps
    where ps.user_id = p_student_id and ps.status <> 'abandoned'
    order by ps.started_at desc
    limit 30
  ) x;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.answered_at desc), '[]'::jsonb) into v_wrong
  from (
    select l.question_id,
           coalesce(cv.id, l.version_id) as version_id,
           coalesce(cv.qtype, lv.qtype) as qtype,
           coalesce(cv.difficulty, lv.difficulty) as difficulty,
           l.answered_at,
           (select count(*) from practice_answers a
             where a.user_id = p_student_id and a.question_id = l.question_id
               and a.is_correct is not true) as wrong_count,
           case when cv.id is not null then left(coalesce(cv.search_text, ''), 120) end as stem_text,
           (cv.id is not null) as available
    from (
      select distinct on (a.question_id) a.question_id, a.version_id, a.is_correct, a.answered_at
      from practice_answers a
      where a.user_id = p_student_id
      order by a.question_id, a.answered_at desc
    ) l
    join question_versions lv on lv.id = l.version_id
    left join questions q on q.id = l.question_id
      and q.state = 'live' and q.current_published_version_id is not null
    left join question_versions cv on cv.id = q.current_published_version_id and cv.status = 'published'
    where l.is_correct is not true
    order by l.answered_at desc
    limit 50
  ) x;

  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into v_nodes
  from (
    select q.course_node_id as node_id,
           count(*) as attempts,
           count(*) filter (where pa.is_correct) as correct
    from practice_answers pa
    join questions q on q.id = pa.question_id
    where pa.user_id = p_student_id and pa.grading = 'auto'
    group by q.course_node_id
  ) x;

  select coalesce(jsonb_agg(to_jsonb(x) order by x.sort_key desc), '[]'::jsonb) into v_exams
  from (
    select a.id, pv.title as paper_title, a.status, a.total_score, a.full_score,
           a.objective_score, a.subjective_score, a.submitted_at, a.graded_at,
           a.pending_review_count, a.duration_ms,
           coalesce(a.submitted_at, a.started_at) as sort_key
    from exam_attempts a
    join paper_versions pv on pv.id = a.paper_version_id
    where a.user_id = p_student_id
      and a.status in ('submitted', 'grading', 'graded')
    order by sort_key desc
    limit 30
  ) x;

  return jsonb_build_object(
    'student', jsonb_build_object(
      'user_id', v_s.user_id, 'name', v_s.name, 'email', v_s.email, 'phone', v_s.phone,
      'avatar_url', v_s.avatar_url, 'school_id', v_s.school_id,
      'class_id', v_s.class_id, 'class_name', v_s.class_name,
      'enroll_year', v_s.enroll_year, 'major_category', v_s.major_category,
      'major', v_s.major, 'major_node_id', v_s.major_node_id,
      'created_at', v_s.created_at),
    'sessions', v_sessions,
    'wrong_questions', v_wrong,
    'node_accuracy', v_nodes,
    'exams', v_exams);
end;
$$;

-- ---------------------------------------------------------------------------
-- 3) admin_delete_user：删除审计带上手机号
-- ---------------------------------------------------------------------------
-- 这里不重抄整个函数（82 行，抄错一个字就是事故），改成**读线上定义 + 定点替换 + 校验**。
-- 如果线上函数的形态和预期不符，替换不会生效，下面的 raise exception 会让整个迁移失败 ——
-- 宁可失败也不要静默留下一个没改到的函数。
do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'admin_delete_user';

  if v_def is null then
    raise exception '找不到 admin_delete_user';
  end if;

  v_new := replace(
    v_def,
    '''email'', v_target.email,',
    '''email'', v_target.email, ''phone'', v_target.phone,');

  if v_new = v_def then
    raise exception 'admin_delete_user 的审计元数据形态与预期不符，替换未生效 —— 请手工核对';
  end if;

  execute v_new;
end $$;
