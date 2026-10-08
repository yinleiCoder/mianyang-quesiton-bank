-- 0088: 班级 AI 分析报告的缓存表与取数（docs/class-analytics-ai-design.md 第 3 步）。
--
-- 口径（2026-10-05/08 用户拍板）：
--   · **按「卷 + 班」生成一次、缓存**：结果存库、全班（同科教师）共用；数据不变就不重算
--     （按"卷面 + 该班成绩"的**指纹**判断，指纹对不上就提示重新生成）；
--   · **喂给模型的数据不带学生姓名**：错答名单只给"学生N"这种编号（N 在本班内稳定，
--     由姓名序生成，不对模型透露姓名）；题目带**知识点名**，否则"重点/易错知识点"无从谈起；
--   · AI 调用**在浏览器里发生**（教师自带 DeepSeek 密钥，见 lib/deepseek.js 的头注：
--     没有服务端调用路径）。所以这里只负责"给数据"与"存结果"两件事，**不碰密钥、不代调上游**。
--
-- 为什么表是**只给 definer 用**（没有 RLS 策略、authenticated 一点权限都没有）：
--   读权限的判据是 can_view_class，而它**已经 revoke from authenticated**（0079 的规矩），
--   RLS 策略里根本调不到它。全站读法一致：权限判断只有一份，且只在 definer 里。
--
-- 泄漏面（改之前先读）：这张表里躺着的是**某班某卷的完整学情**（含逐题正确率与错答编号）。
-- 它只经两条 RPC 出去，两条都先过 can_view_class；返回体里**没有标准答案之外的额外东西** ——
-- 注意题目本身带答案（is_answer）是**故意的**：这份报告是给教师看的，不是给学生。

-- =====================================================================
-- 1) 缓存表
-- =====================================================================
create table public.class_ai_reports (
  id uuid primary key default gen_random_uuid(),
  paper_id uuid not null references public.papers(id) on delete cascade,
  paper_version_id uuid not null references public.paper_versions(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  -- 生成时所依据数据的指纹（= md5(喂给模型的那份 jsonb)）。数据一变就对不上，
  -- 页面据此提示"成绩有更新，建议重新生成"，而不是把旧结论当新的用。
  fingerprint text not null,
  -- 模型返回的结构化报告（分段 json）。存 jsonb 而不是纯文本：
  -- 页面按段落渲染，将来要改版式不用重新生成。
  content jsonb not null,
  model text,
  -- 谁生成的。**刻意不挂外键**（全库没有一张表挂 profiles 外键，注销用户由
  -- admin_delete_user 统一清理语义）——这里留 uuid，显示时 join 不到就当"已注销"。
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 一份卷面 + 一个班只有一条：重新生成 = 覆盖（历史版本没有价值，且报告是"当前学情的结论"）
  unique (paper_version_id, class_id)
);

comment on table public.class_ai_reports is
  '班级 AI 分析报告的缓存：按「卷面 + 班」唯一，指纹对不上表示数据已变、建议重算；只经 SECURITY DEFINER 的 RPC 读写';

create trigger trg_class_ai_reports_touch before update on public.class_ai_reports
  for each row execute function public.touch_updated_at();

alter table public.class_ai_reports enable row level security;
-- 刻意**不建任何策略**：这张表只给 definer 函数用（见头注的权限论证）。
-- 默认权限会给 anon/authenticated 自动授权，所以必须显式收回。
revoke all on public.class_ai_reports from public, anon, authenticated;

-- =====================================================================
-- 2) 内部：喂给模型的那份数据（唯一真源）
-- =====================================================================
-- 指纹、页面概览、真正发给上游的 payload 全部由它产出 —— 三处必须永远一致，
-- 所以只有这一个函数。（和 resolve_paper_scope 同档：谁都不给 EXECUTE）
create or replace function public._class_ai_data(p_paper_id uuid, p_class_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_paper papers%rowtype;
  v_ver paper_versions%rowtype;
  v_class classes%rowtype;
  v_students int;
  v_summary jsonb;
  v_questions jsonb;
  v_practice jsonb;
  v_p_from timestamptz;
begin
  select * into v_paper from papers where id = p_paper_id;
  if not found then raise exception '试卷不存在'; end if;
  if v_paper.current_published_version_id is null then
    raise exception '这份试卷还没有入库的版本，没有可分析的成绩';
  end if;
  select * into v_ver from paper_versions where id = v_paper.current_published_version_id;
  select * into v_class from classes where id = p_class_id;
  if not found then raise exception '班级不存在'; end if;

  select count(*)::int into v_students
  from profiles p where p.class_id = p_class_id and public.can_view_student(p.user_id);

  -- 本班最近 30 天的**练习**情况，最弱的知识点排前面（口径 E 的另一半，2026-10-08 补）：
  -- 教师没填"复习进度"时，这是"复习到哪了"唯一的客观痕迹 —— 练到的知识点说明在教，
  -- 没练过的说明还没到。粒度与 0079 的 node_accuracy 一致：课程层原始节点 +
  -- **至少 3 次作答**才算数（样本更小时一个知识点错 2 次就是"掌握度 0%"，只会误导模型）。
  -- 只给最弱的 8 个：给全量会把 payload 撑大，而"复习到哪"看最弱的几个就够。
  v_p_from := ((public.practice_day_start())::date - 29)::timestamp at time zone 'Asia/Shanghai';
  select coalesce(jsonb_agg(jsonb_build_object(
           'node', t.node_name, 'attempts', t.attempts,
           'correct', t.correct, 'accuracy', t.accuracy)
         order by t.accuracy asc, t.attempts desc), '[]'::jsonb)
    into v_practice
    from (
      select n.name as node_name, count(*) as attempts,
             count(*) filter (where a.is_correct) as correct,
             round((count(*) filter (where a.is_correct))::numeric / count(*), 4) as accuracy
      from practice_answers a
      join profiles p on p.user_id = a.user_id
      join questions q on q.id = a.question_id
      join subject_nodes n on n.id = q.course_node_id
      where p.class_id = p_class_id and public.can_view_student(a.user_id)
        and a.grading = 'auto' and a.answered_at >= v_p_from
      group by n.name
      having count(*) >= 3
      order by accuracy asc, count(*) desc
      limit 8
    ) t;

  with att as (
    -- 本班可见学生在这份卷**当前版本**上的官方场次（与 0087 的考试结果同一条线）
    select a.id as attempt_id, a.user_id, p.name as sname, a.status,
           a.total_score, a.full_score, coalesce(a.submitted_at, a.started_at) as at,
           row_number() over (order by p.name, a.user_id) as sno
    from exam_attempts a
    join profiles p on p.user_id = a.user_id
    where a.paper_id = p_paper_id
      and a.paper_version_id = v_ver.id
      and p.class_id = p_class_id
      and public.can_view_student(a.user_id)
      and a.is_official
      and a.status in ('submitted', 'grading', 'graded')
  ),
  graded as (select * from att where status = 'graded'),
  -- "学生N"：按**姓名序**给本班参与者编号，稳定、且不把姓名交给模型。
  -- 教师若想知道是哪个学生，去「试题分析」页看实名名单（那里本来就实名）。
  per as (
    select g.*, '学生' || g.sno as label,
           round(g.total_score / nullif(g.full_score, 0), 4) as percent
    from graded g
  ),
  ans as (
    select aa.paper_item_id, aa.answer, aa.is_correct, aa.grading, pe.label
    from exam_answers aa join per pe on pe.attempt_id = aa.attempt_id
  ),
  -- 每题一行的聚合
  agg as (
    select i.id as item_id, i.seq, i.qtype, i.score,
           coalesce(cv.search_text, '') as stem,
           n.name as node_name,
           count(a.paper_item_id) as total,
           count(a.paper_item_id) filter (where a.grading <> 'pending') as graded_cnt,
           count(a.paper_item_id) filter (where a.is_correct) as correct_cnt,
           count(a.paper_item_id) filter (where a.answer = '{}'::jsonb) as blank_cnt,
           count(a.paper_item_id) filter (where a.grading = 'pending') as pending_cnt
    from paper_items i
    left join question_versions cv on cv.id = i.question_version_id
    left join questions q on q.id = cv.question_id
    left join subject_nodes n on n.id = q.course_node_id
    left join ans a on a.paper_item_id = i.id
    where i.paper_version_id = v_ver.id
    group by i.id, i.seq, i.qtype, i.score, coalesce(cv.search_text, ''), n.name
  ),
  -- 选项被选情况（含"谁选了"——但要的是编号，不是姓名）
  picks as (
    select a.paper_item_id, x.opt_key, a.label
    from ans a
    cross join lateral (
      select jsonb_array_elements_text(a.answer -> 'keys') as opt_key
      union all
      select (a.answer ->> 'value')::boolean::text where a.answer ? 'value'
    ) x
    where x.opt_key is not null
  ),
  opt_rows as (
    select paper_item_id, opt_key, count(*) as cnt,
           jsonb_agg(label order by label) as labels
    from picks group by paper_item_id, opt_key
  ),
  -- 填空的文本频次（自由文本可能被敲进手机号之类，只给文本与次数，连编号都不给）
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
  wrong_rows as (
    select paper_item_id, jsonb_agg(label order by label) as labels
    from ans a where a.is_correct is false group by a.paper_item_id
  )
  select coalesce((select jsonb_agg(jsonb_build_object(
           'seq', g.seq, 'qtype', g.qtype, 'score', g.score,
           'node', g.node_name,
           -- 题干截断到 200 字：模型只需要知道"这题考什么"，不需要整篇材料
           'stem', left(regexp_replace(g.stem, '\s+', ' ', 'g'), 200),
           'graded', g.graded_cnt, 'correct', g.correct_cnt,
           -- 没有已判分的作答时是 null 而不是 0（与 lib/accuracy.js 同一条规矩）
           'correct_rate', case when g.graded_cnt > 0
                                then round(g.correct_cnt::numeric / g.graded_cnt, 4) else null end,
           'blank', g.blank_cnt, 'pending', g.pending_cnt,
           'options', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'key', d.opt_key, 'is_answer', d.is_answer,
                      'count', coalesce(o.cnt, 0),
                      -- 每条最多 10 个编号：再多对"有没有人集体选错"这个判断也没有增量
                      'students', coalesce((select jsonb_agg(s) from (
                        select jsonb_array_elements(o.labels) as s limit 10) t), '[]'::jsonb))
                    order by d.opt_key)
             from (
               -- as o(elem)：jsonb_array_elements 的列默认叫 value（0078 的坑）
               select elem ->> 'key' as opt_key,
                      coalesce((qv.content -> 'answer' -> 'keys') ? (elem ->> 'key'), false) as is_answer
               from jsonb_array_elements(coalesce(qv.content -> 'options', '[]'::jsonb)) as o(elem)
               union all
               select v.key, coalesce((qv.content -> 'answer' ->> 'value')::boolean::text = v.key, false)
               from (values ('true'), ('false')) v(key)
               where g.qtype = 'true_false'
             ) d
             left join opt_rows o on o.paper_item_id = g.item_id and o.opt_key = d.opt_key
           ), '[]'::jsonb),
           'fill_texts', coalesce((select f.rows from fill_rows f where f.paper_item_id = g.item_id), '[]'::jsonb),
           'wrong', coalesce((select jsonb_agg(s) from (
             select jsonb_array_elements(w.labels) as s
             from wrong_rows w where w.paper_item_id = g.item_id
             limit 10) t), '[]'::jsonb))
         order by g.seq)
       from agg g
       join paper_items pi on pi.id = g.item_id
       join question_versions qv on qv.id = pi.question_version_id), '[]'::jsonb),
    -- 概览数字：页面直接显示，也进 payload（模型要先知道"这个班考得怎么样"）。
    -- **必须和上面那个聚合在同一条语句里**：CTE 只在单条语句内可见。
    (select jsonb_build_object(
           'participants', count(*) filter (where status = 'graded'),
           'ungraded', count(*) filter (where status in ('submitted', 'grading')),
           'avg_percent', round(avg(percent) filter (where status = 'graded'), 4),
           'max_percent', max(percent) filter (where status = 'graded'),
           'min_percent', min(percent) filter (where status = 'graded'),
           'median_percent', round((percentile_cont(0.5) within group (order by percent)
                                    filter (where status = 'graded'))::numeric, 4),
           'distribution', jsonb_build_array(
             jsonb_build_object('key', 'lt60', 'label', '60% 以下',
                                'count', count(*) filter (where status = 'graded' and percent < 0.6)),
             jsonb_build_object('key', 'p60', 'label', '60~69%',
                                'count', count(*) filter (where status = 'graded' and percent >= 0.6 and percent < 0.7)),
             jsonb_build_object('key', 'p70', 'label', '70~79%',
                                'count', count(*) filter (where status = 'graded' and percent >= 0.7 and percent < 0.8)),
             jsonb_build_object('key', 'p80', 'label', '80~89%',
                                'count', count(*) filter (where status = 'graded' and percent >= 0.8 and percent < 0.9)),
             jsonb_build_object('key', 'p90', 'label', '90% 以上',
                                'count', count(*) filter (where status = 'graded' and percent >= 0.9))))
       from per)
    into v_questions, v_summary;

  return jsonb_build_object(
    'paper', jsonb_build_object(
      'id', v_paper.id, 'version_id', v_ver.id, 'version_no', v_ver.version_no,
      'title', v_ver.title, 'exam_name', v_ver.exam_name, 'subject_label', v_ver.subject_label,
      'full_score', v_ver.total_score),
    'class', jsonb_build_object(
      'id', v_class.id, 'name', v_class.name, 'student_count', v_students),
    'summary', v_summary,
    'payload', jsonb_build_object(
      'paper', jsonb_build_object(
        'title', v_ver.title, 'exam_name', v_ver.exam_name,
        'subject_label', v_ver.subject_label, 'full_score', v_ver.total_score,
        'question_count', jsonb_array_length(v_questions)),
      'class', jsonb_build_object(
        'student_count', v_students,
        'participants', v_summary -> 'participants',
        'ungraded', v_summary -> 'ungraded'),
      'score', v_summary,
      'practice', jsonb_build_object('days', 30, 'weak_nodes', v_practice),
      'questions', v_questions));
end;
$$;

revoke execute on function public._class_ai_data(uuid, uuid) from public, anon, authenticated;

-- =====================================================================
-- 3) 报告 + 当前指纹（页面加载用，不含 payload）
-- =====================================================================
create or replace function public.class_ai_report(p_paper_id uuid, p_class_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_data jsonb;
  v_payload jsonb;
  v_fp text;
  v_row class_ai_reports%rowtype;
  v_has boolean;
  v_author text;
begin
  if not public.can_view_class(p_class_id) then
    raise exception '你不能查看这个班级的 AI 分析' using errcode = '42501';
  end if;
  v_data := public._class_ai_data(p_paper_id, p_class_id);
  v_payload := v_data -> 'payload';
  v_fp := md5(v_payload::text);

  select * into v_row from class_ai_reports
  where paper_version_id = (v_data -> 'paper' ->> 'version_id')::uuid
    and class_id = p_class_id;
  -- 必须立刻把它记下来：下面那句 select ... into v_author 会把 FOUND 冲掉
  v_has := found;
  if v_has then
    select name into v_author from profiles where user_id = v_row.created_by;
  end if;

  return jsonb_build_object(
    'paper', v_data -> 'paper',
    'class', v_data -> 'class',
    'summary', v_data -> 'summary',
    'fingerprint', v_fp,
    'report', case when not v_has then null else jsonb_build_object(
      'content', v_row.content,
      'model', v_row.model,
      'created_at', v_row.created_at,
      'created_by_name', v_author,
      'author_left', v_row.created_by is not null and v_author is null,
      'fingerprint', v_row.fingerprint) end,
    -- 数据变了（又有人交卷/判分）→ 旧结论不再是"当前学情的结论"，页面要提示重新生成
    'stale', v_has and v_row.fingerprint <> v_fp);
end;
$$;

revoke execute on function public.class_ai_report(uuid, uuid) from public, anon;
grant execute on function public.class_ai_report(uuid, uuid) to authenticated;

-- =====================================================================
-- 4) 喂给模型的数据（点"生成"时才取，比报告重得多）
-- =====================================================================
create or replace function public.class_ai_payload(p_paper_id uuid, p_class_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_data jsonb;
begin
  if not public.can_view_class(p_class_id) then
    raise exception '你不能查看这个班级的 AI 分析' using errcode = '42501';
  end if;
  v_data := public._class_ai_data(p_paper_id, p_class_id);
  return jsonb_build_object(
    'fingerprint', md5((v_data -> 'payload')::text),
    'payload', v_data -> 'payload');
end;
$$;

revoke execute on function public.class_ai_payload(uuid, uuid) from public, anon;
grant execute on function public.class_ai_payload(uuid, uuid) to authenticated;

-- =====================================================================
-- 5) 存结果（浏览器调完 DeepSeek 之后回写）
-- =====================================================================
create or replace function public.save_class_ai_report(
  p_paper_id uuid,
  p_class_id uuid,
  p_fingerprint text,
  p_content jsonb,
  p_model text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_data jsonb;
  v_fp text;
  v_id uuid;
begin
  if not public.can_view_class(p_class_id) then
    raise exception '你不能为这个班级保存 AI 分析' using errcode = '42501';
  end if;
  if p_content is null or jsonb_typeof(p_content) <> 'object' or p_content = '{}'::jsonb then
    raise exception '报告内容为空' using errcode = '22023';
  end if;

  v_data := public._class_ai_data(p_paper_id, p_class_id);
  v_fp := md5((v_data -> 'payload')::text);

  -- **指纹必须对得上**：客户端是拿着服务端给的 payload 去问模型的，中间要是又有人交卷/判分，
  -- 这份结论对应的就不是现在的学情了 —— 存进去等于给"当前学情"贴了一张过期的标签。
  -- 让客户端重新取一次数据再生成，比存一份说不清的结论便宜。
  if p_fingerprint is distinct from v_fp then
    raise exception '成绩数据已经变了，请重新生成' using errcode = '40001';
  end if;

  insert into class_ai_reports
    (paper_id, paper_version_id, class_id, fingerprint, content, model, created_by)
  values
    (p_paper_id, (v_data -> 'paper' ->> 'version_id')::uuid, p_class_id, v_fp,
     p_content, nullif(btrim(coalesce(p_model, '')), ''), v_uid)
  on conflict (paper_version_id, class_id) do update
    set fingerprint = excluded.fingerprint,
        content = excluded.content,
        model = excluded.model,
        created_by = excluded.created_by,
        updated_at = now()
  returning id into v_id;

  perform public.audit('save_class_ai_report', null, null,
    jsonb_build_object('paper_id', p_paper_id, 'class_id', p_class_id,
                       'model', p_model, 'report_id', v_id));
  return v_id;
end;
$$;

revoke execute on function public.save_class_ai_report(uuid, uuid, text, jsonb, text) from public, anon;
grant execute on function public.save_class_ai_report(uuid, uuid, text, jsonb, text) to authenticated;

notify pgrst, 'reload schema';
