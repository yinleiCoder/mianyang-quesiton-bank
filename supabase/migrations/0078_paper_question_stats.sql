-- 0078: 试卷的逐题分析（每题正确率 + 选项分布 + 错答名单）。
--
-- 用户口径（2026-09-24）：师生都能看到"谁选了什么"——**含姓名**，不脱敏。
-- 只有一条硬门禁：**学生必须自己已经出分**才能看这份分析（见下面的权限段）。
-- 理由：选项分布 + 标准答案合起来就是答案本身，没考完的人拿到它等于提前泄题；
-- 这与 0056 里 `status='graded' ? 带答案 : 剥答案` 的那条分叉同口径。
--
-- 参与统计的场次与排行榜**刻意不同**：这里收「官方 + 已交卷」（含待阅卷）。
-- 总分没判完不能比高低，但客观题在交卷那一刻就定稿了，而讲评往往在最后一题判完之前就要开。
--
-- 泄漏面（改之前先读）：返回体只包含**选项 key/文本、标准答案、计数、姓名**。
-- 选择题的"谁选了什么"是产品明确要的；**填空题只给文本频次、不给姓名**
-- （自由文本可能被敲进手机号之类，那是另一个量级的暴露）。这条是刻意的收窄。
--
-- 复用：resolve_paper_scope（0077，范围与权限口径只有一份）、is_paper_grader（0051）、
-- exam_norm_text（0067 的填空归一化）。
-- 选项文本**不用** v_blocks_text：它遇到未知块类型会 raise（那是给 content 校验用的），
-- 而这里只是取一段展示文字，宁可少取也不能让整页 500。

create or replace function public.paper_question_stats(
  p_paper_id uuid,
  p_scope text default 'class',
  p_class_id uuid default null,
  p_max_students_per_option int default 50)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_scope jsonb;
  v_scope_key text;
  v_class_id uuid;
  v_school_id uuid;
  v_paper papers%rowtype;
  v_ver paper_versions%rowtype;
  v_limit int := least(greatest(coalesce(p_max_students_per_option, 50), 1), 200);
  v_items jsonb;
  v_attempts int;
  v_ungraded int;
  v_other int;
begin
  select * into v_paper from papers where id = p_paper_id;
  if not found then raise exception '试卷不存在'; end if;
  if v_paper.current_published_version_id is null then
    raise exception '这份试卷还没有入库的版本，没有分析可言';
  end if;
  select * into v_ver from paper_versions where id = v_paper.current_published_version_id;
  if not found then raise exception '这份试卷还没有入库的版本，没有分析可言'; end if;

  -- 权限：教师/管理员恒可看；学生必须在本版本上有一场**已出分**的考试
  if not public.is_paper_grader(p_paper_id) then
    if not exists (
      select 1 from exam_attempts a
      where a.paper_version_id = v_ver.id and a.user_id = v_uid and a.status = 'graded'
    ) then
      raise exception '出分后才能看这份卷子的试题分析' using errcode = '42501';
    end if;
  end if;

  v_scope := public.resolve_paper_scope(p_paper_id, p_scope, p_class_id);
  v_scope_key := v_scope ->> 'scope';
  v_class_id := nullif(v_scope ->> 'class_id', '')::uuid;
  v_school_id := nullif(v_scope ->> 'school_id', '')::uuid;

  -- 三个计数：参与统计的、待阅卷的、考旧版卷面的（后两者页面各要说一句）
  select count(*)::int into v_attempts
  from exam_attempts a join profiles p on p.user_id = a.user_id
  where a.paper_version_id = v_ver.id and a.is_official
    and a.status in ('submitted', 'grading', 'graded')
    and case v_scope_key
          when 'class' then v_class_id is not null and p.class_id = v_class_id
          when 'school' then v_school_id is not null and p.school_id = v_school_id
          else true end;

  select count(*)::int into v_ungraded
  from exam_attempts a join profiles p on p.user_id = a.user_id
  where a.paper_version_id = v_ver.id and a.is_official
    and a.status in ('submitted', 'grading')
    and case v_scope_key
          when 'class' then v_class_id is not null and p.class_id = v_class_id
          when 'school' then v_school_id is not null and p.school_id = v_school_id
          else true end;

  select count(*)::int into v_other
  from exam_attempts a
  where a.paper_id = p_paper_id and a.paper_version_id <> v_ver.id and a.is_official
    and a.status in ('submitted', 'grading', 'graded');

  with parts as (
    select a.id as attempt_id, a.user_id, p.name, p.class_id, c.name as class_name
    from exam_attempts a
    join profiles p on p.user_id = a.user_id
    left join classes c on c.id = p.class_id
    where a.paper_version_id = v_ver.id and a.is_official
      and a.status in ('submitted', 'grading', 'graded')
      and case v_scope_key
            when 'class' then v_class_id is not null and p.class_id = v_class_id
            when 'school' then v_school_id is not null and p.school_id = v_school_id
            else true end
  ),
  ans as (
    select aa.paper_item_id, aa.answer, aa.is_correct, aa.grading,
           pa.user_id, pa.name, pa.class_name
    from exam_answers aa
    join parts pa on pa.attempt_id = aa.attempt_id
  ),
  -- 选项被选情况：选择题展开 keys、判断题把 value 变成伪 key（'true'/'false'）。
  -- 多选一人计多个选项——口径是"多少人选了它"，所以计数之和会大于人数。
  picks as (
    select a.paper_item_id, x.opt_key, a.user_id, a.name, a.class_name
    from ans a
    cross join lateral (
      select jsonb_array_elements_text(a.answer -> 'keys') as opt_key
      union all
      select (a.answer ->> 'value')::boolean::text
      where a.answer ? 'value'
    ) x
    where x.opt_key is not null
  ),
  opt_rows as (
    select paper_item_id, opt_key, count(*) as cnt,
           jsonb_agg(jsonb_build_object('user_id', user_id, 'name', name,
                                        'class_name', class_name) order by name) as students
    from picks group by paper_item_id, opt_key
  ),
  -- 填空的文本频次：**只给文本与次数，不给姓名**（自由文本可能含隐私）
  fill_rows as (
    select f.paper_item_id,
           jsonb_agg(jsonb_build_object('text', f.sample, 'count', f.cnt)
                     order by f.cnt desc, f.sample) as rows
    from (
      select a.paper_item_id, public.exam_norm_text(t.val) as norm,
             min(t.val) as sample, count(*) as cnt
      from ans a
      cross join lateral jsonb_array_elements_text(
        coalesce(a.answer -> 'values', '[]'::jsonb)) as t(val)
      where public.exam_norm_text(t.val) <> ''
      group by a.paper_item_id, public.exam_norm_text(t.val)
    ) f
    group by f.paper_item_id
  ),
  agg as (
    select i.id as item_id,
           count(a.paper_item_id) as total,
           count(a.paper_item_id) filter (where a.answer = '{}'::jsonb) as blank,
           count(a.paper_item_id) filter (where a.grading <> 'pending') as graded,
           count(a.paper_item_id) filter (where a.is_correct) as correct,
           count(a.paper_item_id) filter (where a.grading = 'pending') as pending,
           count(a.paper_item_id) filter (where a.is_correct is false) as wrong
    from paper_items i
    left join ans a on a.paper_item_id = i.id
    where i.paper_version_id = v_ver.id
    group by i.id
  ),
  wrongs as (
    select a.paper_item_id,
           jsonb_agg(jsonb_build_object(
             'user_id', a.user_id, 'name', a.name, 'class_name', a.class_name,
             -- 错的"答案"只对选择题与判断题给出；填空/主观留空——
             -- 那两类要把学生写的原文贴出来，与"不暴露自由文本"那条口径冲突
             'label', case
               when a.answer ? 'keys' then (
                 select string_agg(upper(k), '' order by upper(k))
                 from jsonb_array_elements_text(a.answer -> 'keys') k)
               when a.answer ? 'value' then
                 case when (a.answer ->> 'value')::boolean then '正确' else '错误' end
               else null end
           ) order by a.name) as rows
    from ans a
    where a.is_correct is false
    group by a.paper_item_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'item_id', i.id, 'seq', i.seq, 'qtype', i.qtype, 'score', i.score,
           'answer', case i.qtype
                       when 'true_false' then jsonb_build_object('value', qv.content -> 'answer' -> 'value')
                       when 'fill_blank' then jsonb_build_object('values', qv.content -> 'answer' -> 'values')
                       when 'short_answer' then jsonb_build_object('samples', qv.content -> 'answer' -> 'samples')
                       else jsonb_build_object('keys', qv.content -> 'answer' -> 'keys') end,
           'total', coalesce(g.total, 0),
           'blank', coalesce(g.blank, 0),
           'graded', coalesce(g.graded, 0),
           'correct', coalesce(g.correct, 0),
           'pending', coalesce(g.pending, 0),
           -- 没有已判分的作答时是 null 而不是 0：0 次作答 ≠ 全错（与 lib/accuracy.js 同一条规矩）
           'correct_rate', case when coalesce(g.graded, 0) > 0
                                then round(g.correct::numeric / g.graded, 4) else null end,
           'options', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'key', d.opt_key, 'text', d.opt_text,
                      'is_answer', case
                        when i.qtype = 'true_false' then
                          coalesce((qv.content -> 'answer' ->> 'value')::boolean::text = d.opt_key, false)
                        else coalesce((qv.content -> 'answer' -> 'keys') ? d.opt_key, false) end,
                      'count', coalesce(o.cnt, 0),
                      'students', coalesce((
                        select jsonb_agg(s) from (
                          select jsonb_array_elements(o.students) as s limit v_limit) t), '[]'::jsonb),
                      'students_truncated', coalesce(o.cnt, 0) > v_limit)
                    order by d.opt_key)
             from (
               -- as o(elem)：jsonb_array_elements 的列默认叫 value，不给列名就只能用 o.value，
               -- 写 o.key 会被当成"表的列"直接报 42703
               select elem ->> 'key' as opt_key,
                      left(coalesce((
                        select string_agg(b ->> 'text', ' ')
                        from jsonb_array_elements(elem -> 'label') b
                        where b ->> 't' = 'text'), ''), 60) as opt_text
               from jsonb_array_elements(coalesce(qv.content -> 'options', '[]'::jsonb)) as o(elem)
               union all
               select v.key, v.label from (values ('true', '正确'), ('false', '错误')) v(key, label)
               where i.qtype = 'true_false'
             ) d
             left join opt_rows o on o.paper_item_id = i.id and o.opt_key = d.opt_key
           ), '[]'::jsonb),
           -- 填空题的文本频次（无姓名）；其它题型恒为空数组
           'text_counts', coalesce((select f.rows from fill_rows f where f.paper_item_id = i.id), '[]'::jsonb),
           'wrong_students', coalesce((select jsonb_agg(s) from (
             select jsonb_array_elements(w.rows) as s limit 100) t), '[]'::jsonb),
           'wrong_total', coalesce(g.wrong, 0)
         ) order by i.seq), '[]'::jsonb)
    into v_items
    from paper_items i
    join question_versions qv on qv.id = i.question_version_id
    left join agg g on g.item_id = i.id
    left join wrongs w on w.paper_item_id = i.id
    where i.paper_version_id = v_ver.id;

  return jsonb_build_object(
    'paper', jsonb_build_object(
      'id', v_paper.id, 'title', v_ver.title, 'exam_name', v_ver.exam_name,
      'subject_label', v_ver.subject_label, 'version_id', v_ver.id,
      'version_no', v_ver.version_no, 'full_score', v_ver.total_score,
      'published_at', v_ver.published_at,
      'school_id', v_paper.school_id,
      'school_name', (select name from schools where id = v_paper.school_id)),
    'scope', jsonb_build_object(
      'key', v_scope_key, 'label', v_scope ->> 'label',
      'class_id', v_scope -> 'class_id', 'school_id', v_scope -> 'school_id',
      'is_staff', v_scope -> 'is_staff', 'note', v_scope -> 'note'),
    'stats', jsonb_build_object(
      'attempts', v_attempts, 'ungraded', v_ungraded, 'other_version_skipped', v_other),
    'items', v_items,
    'student_limit', v_limit);
end;
$$;

revoke execute on function public.paper_question_stats(uuid, text, uuid, int) from public, anon;
grant execute on function public.paper_question_stats(uuid, text, uuid, int) to authenticated;

notify pgrst, 'reload schema';
