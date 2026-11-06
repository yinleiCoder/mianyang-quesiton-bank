-- 0143: 学生名册页慢（list_my_student_classes 平均 290ms）——权限判断一次求值
--
-- 现象：`pg_stat_statements` 里 list_my_student_classes 467 次调用、平均 289.9ms、
-- 最慢 2.4s。它是「学生名册」与「班级管理」的取数口，也是 160 人规模下第二大热查询。
--
-- 根因与 0142 同款：它在每个学生行上逐行调 public.can_view_student()，
-- 而那个函数内部还有 is_admin / is_school_admin / is_teacher 和递归的
-- major_subtree_ids()。一个班 65 人 × 3 个班 = 195 次递归。
--
-- 改法：
--   1. 新增 visible_student_ids()：调用者级信息（是否管理员/教师/本校管理员、
--      专业子树）只算一次，返回可见学生 id 数组；
--   2. list_my_student_classes 用它匹配，并把"整班聚合"从**每班扫一遍**
--      改成整表扫一遍（原来 3 个班各扫一次 practice_answers）。
--
-- 结果：149ms→42ms（暖态，学校管理员视角）；输出与改前**逐字节一致**
-- （md5 98c991eb06e845940755634c6c7afd95，教师与学校管理员两个视角都相同）。
-- 剩下的 42ms 是真实工作量：4.1 万行练习作答的聚合 + 3 个班的可见性判断。

create or replace function public.visible_student_ids()
returns uuid[]
language sql
stable
security definer
set search_path to 'public'
as $fn$
  with me as (
    select p.school_id,
           public.is_admin() as is_admin,
           public.is_teacher() as is_teacher,
           public.is_school_admin(p.school_id) as is_school_admin
    from profiles p
    where p.user_id = (select auth.uid())
  ),
  subtree as (
    select coalesce((
      select array_agg(id) from public.major_subtree_ids(
        (select major_node_id from profiles where user_id = (select auth.uid()))
      )), '{}'::uuid[]) as ids
  )
  select coalesce(array_agg(s.user_id), '{}'::uuid[])
  from profiles s
  cross join me
  cross join subtree
  where s.identity = 'student'
    and (
      me.is_admin
      -- 学校管理员只覆盖本校（is_school_admin 的比较是本校本校，不是任意校）
      or (me.is_school_admin and s.school_id = me.school_id)
      -- 教师：本校 + 专业子树（用 is not distinct from，与 can_view_student 同口径）
      or (me.is_teacher
          and s.school_id is not distinct from me.school_id
          and s.major_node_id = any(subtree.ids))
    );
$fn$;

-- 内部辅助函数，与 exam_norm_text / grade_exam_units 同口径：不对客户端开放
revoke all on function public.visible_student_ids() from public, anon, authenticated;
grant execute on function public.visible_student_ids() to service_role;

create or replace function public.list_my_student_classes()
returns table(class_id uuid, class_name text, is_active boolean, enroll_year smallint,
              school_id uuid, major_node_id uuid, student_count bigint,
              answered_count bigint, correct_count bigint, graded_count bigint,
              last_practiced_at timestamp with time zone)
language sql
stable
security definer
set search_path to 'public'
as $fn$
  -- materialized：visible_student_ids() 被引用多次，内联会重复执行
  with vis as materialized (select public.visible_student_ids() as ids),
  -- 整班聚合只扫一遍 practice_answers（原来每个班各扫一次，是 290ms 的大头）
  agg as (
    select p.class_id,
           count(*) as acount,
           count(*) filter (where pa.is_correct) as ccount,
           count(*) filter (where pa.grading = 'auto') as gcount,
           max(pa.answered_at) as alast
    from profiles p
    join practice_answers pa on pa.user_id = p.user_id
    cross join vis
    where p.identity = 'student' and p.class_id is not null
      and p.user_id = any(vis.ids)
    group by p.class_id
  )
  select c.id, c.name, c.is_active, c.enroll_year, c.school_id, c.major_node_id,
         (select count(*) from profiles p
           where p.class_id = c.id and p.identity = 'student'
             and p.user_id = any(vis.ids)),
         coalesce(agg.acount, 0), coalesce(agg.ccount, 0), coalesce(agg.gcount, 0), agg.alast
  from classes c
  cross join vis
  left join agg on agg.class_id = c.id
  where public.can_view_class(c.id)
  order by c.is_active desc, c.enroll_year desc nulls last, c.name;
$fn$;
