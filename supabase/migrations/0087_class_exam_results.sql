-- 0087: 班级考试结果 —— 「这个班考过的每份卷：谁最高、谁最低、谁进步最大、分数怎么分布」。
--
-- 背景（docs/class-analytics-ai-design.md 第 2 步）：班级学情页此前**只有练习侧**
-- （0079 的参与度/趋势/知识点/高危题/预警，它的头注就写着"考试那一侧由 0077/0078 的榜与分析负责"），
-- 而用户要的是"尤其是考试卷结果：最高分是谁、最低分是谁"。这一条 RPC 补的就是那一层。
--
-- 口径（2026-10-05 用户逐条拍板）：
--   · **每份卷一张卡片**：窗口内考过的卷各出一份结果，不是"只做最近一场"；
--   · **进步最大 = 同一个学生在本班最近两份卷上的得分率之差**（百分点），两场都必须已出分；
--     中间那场缺考的人不参与这一档 —— 拿"上次之前那次"去比，教师问起来没法解释；
--   · **列的卷跟随页面的 7/30/90 天窗口**（与同一页其它面板一个口径）。
--
-- 与 0076/0077 同源的硬规矩（改这个文件前先读）：
--   · 只算**官方成绩**（`is_official`：同一份卷面只有第一次交卷计入）且**已出分**（`status='graded'`）——
--     和榜单一条线，总分没判完不能比高低；
--   · 只看**当前入库版本**：改版后满分与题都变了，混排不公平。旧版场次这里**直接不显示**
--     （不像榜单那样有个 other_version_skipped 的计数位：这里是列表，空卡片比一行说明更难看）；
--   · 学生名单**逐行过 can_view_student**（0079 的规矩：宁可少报，也不多露一个名字）。
--     代价：理论上可能与班级榜（0077 只按 `class_id`）差一两个人（学生转过专业时）。
--     这里刻意选**同一页的参与度面板**那一套 —— "班级人数 12"和"参加 5/12"就在同一屏上，
--     两个数字打架比少报一个人更难解释。
--
-- 窗口按**卷**判定：只要这份卷有一次交卷落在窗口内，整卷（该班全部有效场次）都计入 ——
-- 一场考试跨两天时，不该因为窗口边界只算半个班。
--
-- 权限：can_view_class（系统管理员 / 本校管理员 / 本校本专业教师），与 0079 同。
-- 该函数已 revoke from authenticated，只能在 definer 内部调用。

create or replace function public.class_exam_results(
  p_class_id uuid,
  p_days int default 30,
  p_max_papers int default 12)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_class classes%rowtype;
  v_days int := least(greatest(coalesce(p_days, 30), 7), 180);
  v_max int := least(greatest(coalesce(p_max_papers, 12), 1), 30);
  v_to date;
  v_from date;
  v_from_ts timestamptz;
  v_students int;
  v_papers jsonb;
  v_truncated boolean;
begin
  if not public.can_view_class(p_class_id) then
    raise exception '你不能查看这个班级的考试结果' using errcode = '42501';
  end if;
  select * into v_class from classes where id = p_class_id;
  if not found then raise exception '班级不存在'; end if;

  -- 日界与 0079 一致：库时区是 UTC，"今天"从北京时间早上 8 点起算
  v_to := (public.practice_day_start())::date;
  v_from := v_to - (v_days - 1);
  v_from_ts := (v_from::timestamp at time zone 'Asia/Shanghai');

  -- 分母：这个班**我能看到的学生**数（与参与度面板的"班级人数"同一个数）
  select count(*)::int into v_students
  from profiles p
  where p.class_id = p_class_id and public.can_view_student(p.user_id);

  with parts as (
    -- 本班可见学生在这份卷上的全部官方场次（待阅卷的也算：教师要知道"还有几人没判完"）。
    -- 只取当前入库版本 —— 见头注。
    select a.id as attempt_id, a.user_id, p.name,
           a.paper_id, a.total_score, a.full_score, a.status,
           a.duration_ms, coalesce(a.submitted_at, a.started_at) as at
    from exam_attempts a
    join profiles p on p.user_id = a.user_id
    join papers pa on pa.id = a.paper_id
      and pa.current_published_version_id = a.paper_version_id
    where p.class_id = p_class_id
      and public.can_view_student(a.user_id)
      and a.is_official
      and a.status in ('submitted', 'grading', 'graded')
  ),
  ver as (
    select pa.id as paper_id, v.id as version_id, v.title, v.exam_name,
           v.subject_label, v.version_no, v.total_score as full_score
    from papers pa
    join paper_versions v on v.id = pa.current_published_version_id
    where pa.current_published_version_id is not null
  ),
  -- 这场考试被"考过"了：窗口内至少有一次交卷（跨天的卷整卷计入）
  exam_all as (
    select c.paper_id, count(*) filter (where c.status = 'graded') as graded_count,
           count(*) filter (where c.status in ('submitted', 'grading')) as ungraded_count,
           min(c.at) as first_at, max(c.at) as last_at
    from parts c
    group by c.paper_id
    having count(*) filter (where c.at >= v_from_ts) > 0
  ),
  exam as (
    select * from exam_all
    order by last_at desc, paper_id
    limit v_max
  ),
  -- 卷序：**1 = 最近考的那份**，往过去数。所以"上一场"是 ord + 1（不是 ord - 1 —— 这里写反过一次，
  -- 结果把进步榜算成了"这份卷比下一份（更早的）那份"）。进步榜按这个序找上一场，不是按学生自己的上一场。
  ordered as (
    select e.*, row_number() over (order by e.last_at desc, e.paper_id) as ord
    from exam e
  ),
  scored as (
    select c.user_id, c.name, c.paper_id, o.ord, c.total_score, c.duration_ms, c.at,
           round(c.total_score / nullif(c.full_score, 0), 4) as percent
    from parts c
    join ordered o on o.paper_id = c.paper_id
    where c.status = 'graded'
  ),
  -- 卷内名次：与榜单同一条排序（同分看用时，再看交卷时间，最后姓名），
  -- 所以"最高分是谁"与点进榜单看到的第 1 名永远是同一个人
  ranked as (
    select s.*,
           row_number() over (partition by s.paper_id
                              order by s.total_score desc, s.duration_ms asc nulls last,
                                       s.at asc, s.name) as ord_in_paper
    from scored s
  ),
  improved as (
    select r.paper_id, r.user_id, r.name, r.total_score, r.percent,
           pv.paper_id as prev_paper_id, pv.total_score as prev_score, pv.percent as prev_percent,
           round(r.percent - pv.percent, 4) as delta
    from scored r
    join scored pv on pv.user_id = r.user_id and pv.ord = r.ord + 1
    where r.percent > pv.percent
  ),
  best_improved as (
    select distinct on (paper_id) *
    from improved
    order by paper_id, delta desc, name
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'paper_id', o.paper_id,
           'version_id', ve.version_id,
           'title', ve.title,
           'exam_name', ve.exam_name,
           'subject_label', ve.subject_label,
           'version_no', ve.version_no,
           'full_score', ve.full_score,
           'first_submitted_at', o.first_at,
           'last_submitted_at', o.last_at,
           'participants', o.graded_count,
           'ungraded', o.ungraded_count,
           'stats', (
             select jsonb_build_object(
                      'avg_score', round(avg(t.total_score), 2),
                      'avg_percent', round(avg(t.percent), 4),
                      'max_score', max(t.total_score),
                      'min_score', min(t.total_score))
             from scored t where t.paper_id = o.paper_id),
           'top', (
             select jsonb_build_object('user_id', t.user_id, 'name', t.name,
                                       'score', t.total_score, 'percent', t.percent,
                                       'duration_ms', t.duration_ms)
             from ranked t where t.paper_id = o.paper_id
             order by t.ord_in_paper limit 1),
           'bottom', (
             select jsonb_build_object('user_id', t.user_id, 'name', t.name,
                                       'score', t.total_score, 'percent', t.percent,
                                       'duration_ms', t.duration_ms)
             from ranked t where t.paper_id = o.paper_id
             order by t.ord_in_paper desc limit 1),
           -- 没有"上一场"（这是本窗口最早的一份卷）或全员退步时是 null，不是空对象
           'most_improved', (
             select jsonb_build_object('user_id', b.user_id, 'name', b.name,
                                       'score', b.total_score, 'percent', b.percent,
                                       'prev_score', b.prev_score, 'prev_percent', b.prev_percent,
                                       'prev_paper_id', b.prev_paper_id, 'delta', b.delta)
             from best_improved b where b.paper_id = o.paper_id),
           -- 分数段（按得分率，五档；不同卷满分不同，原始分不能横向比）。
           -- 档位与文案一起下发，页面直接用 —— 别在前端另写一套阈值（0079 的 alerts 同规矩）
           'distribution', (
             select jsonb_build_array(
                      jsonb_build_object('key', 'lt60', 'label', '60% 以下',
                                         'count', count(*) filter (where t.percent < 0.6)),
                      jsonb_build_object('key', 'p60', 'label', '60~69%',
                                         'count', count(*) filter (where t.percent >= 0.6 and t.percent < 0.7)),
                      jsonb_build_object('key', 'p70', 'label', '70~79%',
                                         'count', count(*) filter (where t.percent >= 0.7 and t.percent < 0.8)),
                      jsonb_build_object('key', 'p80', 'label', '80~89%',
                                         'count', count(*) filter (where t.percent >= 0.8 and t.percent < 0.9)),
                      jsonb_build_object('key', 'p90', 'label', '90% 以上',
                                         'count', count(*) filter (where t.percent >= 0.9)))
             from scored t where t.paper_id = o.paper_id))
         order by o.ord), '[]'::jsonb),
           -- 窗口内考过的卷比 v_max 还多：页面据此说一句"只显示最近 N 场"
           (select count(*) from exam_all) > v_max
      into v_papers, v_truncated
    from ordered o
    join ver ve on ve.paper_id = o.paper_id;

  return jsonb_build_object(
    'class', jsonb_build_object(
      'id', v_class.id, 'name', v_class.name, 'school_id', v_class.school_id,
      'major_node_id', v_class.major_node_id, 'enroll_year', v_class.enroll_year),
    'window', jsonb_build_object('days', v_days, 'from', v_from::text, 'to', v_to::text,
                                 'day_boundary', 'Asia/Shanghai'),
    'student_count', v_students,
    'max_papers', v_max,
    'truncated', v_truncated,
    'papers', v_papers);
end;
$$;

revoke execute on function public.class_exam_results(uuid, int, int) from public, anon;
grant execute on function public.class_exam_results(uuid, int, int) to authenticated;

notify pgrst, 'reload schema';
