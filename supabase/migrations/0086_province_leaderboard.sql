-- 0086: 排行榜加「全省」档，并把「全市」从"全平台"改成真正按市收口。
--
-- 口径（2026-10-05 用户拍板，见 docs/class-analytics-ai-design.md 第 1 步）：
--   全省 = **全省考过这份卷的人都算**（与现有全校/全市同一口径，不按年级/专业过滤），
--   **实名**、学生看自己 + 前三 —— 与既有三档一致（0077 定的"不脱敏"照旧）。
--
-- ⚠ 本次不止"加一档"，还顺手改了 city 的口径，**改这里之前先读这段**：
--   0077 写的时候 schools 表还没有城市列，所以 city 档实际是**全平台**（0077 里那句
--   "全市 = 全平台"就是它）。0082 给 schools 加了 city_id 并回填成绵阳市，于是"全市"
--   这个标签**已经失真**；此时若照原样再加一档"不筛"的全省，两个页签的数字会一模一样。
--   所以这里把 city 真正按 schools.city_id 收口（人的市由 profile → school → city 推导，
--   0082 的规矩），**全省才是"不筛"的那一档**。
--   线上现在只有一个市（绵阳市，10 所学校全挂着），所以**本次改动在现有数据上看不出差别**；
--   差别要到接入第二个市的当天才出现 —— 那正是它要堵的洞（否则「全市」会串市）。
--
-- 授权推理仍然只有一份：范围与可见性只在 resolve_paper_scope 里，两个 RPC
-- （paper_leaderboard 0077 / paper_question_stats 0078）都从它拿 scope_key。
-- 加档位 = 在这里加白名单 + 一个分支，排序逻辑一行不动。
--
-- 泄漏面不变：返回体只有"谁多少分、谁排第几、在哪个学校/班"（0077 的硬约束原样保留）。

-- =====================================================================
-- 1) 范围解析：白名单 + province；city 收口到市
-- =====================================================================
create or replace function public.resolve_paper_scope(
  p_paper_id uuid, p_scope text, p_class_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_scope text := lower(coalesce(nullif(btrim(p_scope), ''), 'class'));
  v_me profiles%rowtype;
  v_staff boolean;
  v_class classes%rowtype;
  v_school uuid;
  v_school_name text;
  v_city uuid;
  v_city_name text;
begin
  if v_scope not in ('class', 'school', 'city', 'province') then
    raise exception '榜单范围不合法（只能是 class / school / city / province）';
  end if;

  select * into v_me from profiles where user_id = v_uid;
  -- 学校管理员不一定 identity='teacher'（is_teacher 只看 identity 与 is_admin），
  -- 所以这里补一条 is_school_admin，否则他会被当成学生、被静默夹到"自己的班"
  v_staff := public.is_teacher() or public.is_admin() or public.is_school_admin(v_me.school_id);

  -- 全省：平台就是四川省（cities 是它下面的市），没有比它更大的范围可筛 —— 这一档不筛任何人，
  -- 与 0077 里 city 档原先的行为一致。实名可见性也照旧（学生端"自己 + 前三"由客户端按 rows 排）。
  if v_scope = 'province' then
    return jsonb_build_object('scope', 'province', 'label', '全省',
                              'class_id', null, 'school_id', null, 'city_id', null,
                              'is_staff', v_staff);
  end if;

  -- 全市（0086 起真正按市筛）：城的推导与 school 档同序、同兜底 ——
  -- 教师：选中班所在学校 → 自己的学校 → 试卷所属学校；学生：自己的学校。
  -- 学生推不出市时给空榜 + 'no_school'（线上有 3 个没绑学校的学生，原先"全市"能看全平台，
  -- 收口后他们会看到一张空榜——必须说明白，否则等于成绩"丢了"）。
  -- **刻意不退回"不筛"**：那会让"全市"在教学点上看不出问题、却在有第二个市时静默串市。
  if v_scope = 'city' then
    if v_staff then
      if p_class_id is not null and public.can_view_class(p_class_id) then
        select s.city_id into v_city
        from classes c join schools s on s.id = c.school_id
        where c.id = p_class_id;
      end if;
      v_city := coalesce(v_city,
                         (select s.city_id from schools s where s.id = v_me.school_id),
                         (select s.city_id from papers pp join schools s on s.id = pp.school_id
                           where pp.id = p_paper_id));
    else
      v_city := (select s.city_id from schools s where s.id = v_me.school_id);
      -- 学生没绑学校（或学校没挂市）时推不出市。给空榜 + 一句能照做的话（no_school），
      -- 但**绝不退回"不筛"**——那会让"全市"在有第二个市的当天静默变成全省。
      if v_city is null then
        return jsonb_build_object('scope', 'city', 'label', '全市', 'class_id', null,
                                  'school_id', null, 'city_id', null, 'is_staff', false,
                                  'note', 'no_school');
      end if;
    end if;
    select name into v_city_name from cities where id = v_city;
    return jsonb_build_object('scope', 'city', 'label', coalesce(v_city_name, '全市'),
                              'class_id', null, 'school_id', null, 'city_id', v_city,
                              'is_staff', v_staff);
  end if;

  if v_scope = 'school' then
    if v_staff then
      -- 教师看"全校"：优先他选的那个班所属学校，其次自己的学校，最后试卷所属学校
      if p_class_id is not null and public.can_view_class(p_class_id) then
        select school_id into v_school from classes where id = p_class_id;
      end if;
      v_school := coalesce(v_school, v_me.school_id,
                           (select school_id from papers where id = p_paper_id));
    else
      v_school := v_me.school_id;
      -- 同上：没学校的学生在"全校"档给一句能照做的说明，而不是含糊的 empty_scope
      if v_school is null then
        return jsonb_build_object('scope', 'school', 'label', '全校', 'class_id', null,
                                  'school_id', null, 'is_staff', false, 'note', 'no_school');
      end if;
    end if;
    select name into v_school_name from schools where id = v_school;
    return jsonb_build_object('scope', 'school', 'label', coalesce(v_school_name, '全校'),
                              'class_id', null, 'school_id', v_school, 'is_staff', v_staff);
  end if;

  -- ---- scope = 'class' ----
  if not v_staff then
    -- 学生：永远只看自己的班。传了别人的 p_class_id **静默忽略**——
    -- 报错等于给了"这个 uuid 是不是有效班级"的探针。
    select * into v_class from classes where id = v_me.class_id;
    if v_class.id is null then
      return jsonb_build_object('scope', 'class', 'label', '全班', 'class_id', null,
                                'school_id', v_me.school_id, 'is_staff', false,
                                'note', 'not_in_class');
    end if;
    return jsonb_build_object('scope', 'class', 'label', v_class.name, 'class_id', v_class.id,
                              'school_id', v_class.school_id, 'is_staff', false);
  end if;

  -- 教师/管理员：必须显式给班（页面上是班级下拉），且要过 can_view_class
  if p_class_id is null then
    raise exception '查看班级榜需要先选择班级' using errcode = '22023';
  end if;
  if not public.can_view_class(p_class_id) then
    raise exception '你不能查看这个班级的榜单' using errcode = '42501';
  end if;
  select * into v_class from classes where id = p_class_id;
  return jsonb_build_object('scope', 'class', 'label', v_class.name, 'class_id', v_class.id,
                            'school_id', v_class.school_id, 'is_staff', true);
end;
$$;

-- 内部函数：和 can_view_student / major_subtree_ids 同档，谁都不给 EXECUTE
revoke execute on function public.resolve_paper_scope(uuid, text, uuid) from public, anon, authenticated;

-- =====================================================================
-- 2) 排行榜：四档（全班 / 全校 / 全市 / 全省）
-- =====================================================================
create or replace function public.paper_leaderboard(
  p_paper_id uuid,
  p_scope text default 'class',
  p_class_id uuid default null,
  p_limit int default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_scope jsonb;
  v_paper papers%rowtype;
  v_ver paper_versions%rowtype;
  v_limit int := least(greatest(coalesce(p_limit, 200), 1), 500);
  v_class_id uuid;
  v_school_id uuid;
  v_city_id uuid;
  v_scope_key text;
  v_payload jsonb;
  v_ungraded int := 0;
  v_other int := 0;
  v_my_official boolean;
  v_my_status text;
  v_note text;
begin
  select * into v_paper from papers where id = p_paper_id;
  if not found then raise exception '试卷不存在'; end if;
  if v_paper.current_published_version_id is null then
    raise exception '这份试卷还没有入库的版本，没有成绩可言';
  end if;
  select * into v_ver from paper_versions where id = v_paper.current_published_version_id;
  if not found then raise exception '这份试卷还没有入库的版本，没有成绩可言'; end if;

  v_scope := public.resolve_paper_scope(p_paper_id, p_scope, p_class_id);
  v_scope_key := v_scope ->> 'scope';
  v_class_id := nullif(v_scope ->> 'class_id', '')::uuid;
  v_school_id := nullif(v_scope ->> 'school_id', '')::uuid;
  v_city_id := nullif(v_scope ->> 'city_id', '')::uuid;

  -- 我在这场卷子上的状态（决定 viewer.note：没考 / 是自主练习 / 还在待阅卷）
  select x.is_official, x.status into v_my_official, v_my_status
  from exam_attempts x
  where x.paper_version_id = v_ver.id and x.user_id = v_uid
  order by x.is_official desc, coalesce(x.submitted_at, x.started_at) desc
  limit 1;

  -- 未出分（主观题没判完）与旧版卷面的场次：分别计数，页面据此解释"榜为什么是空的"
  select count(*)::int into v_ungraded
  from exam_attempts a join profiles p on p.user_id = a.user_id
  left join schools s on s.id = p.school_id
  where a.paper_version_id = v_ver.id and a.is_official
    and a.status in ('submitted', 'grading')
    and case v_scope_key
          when 'class' then v_class_id is not null and p.class_id = v_class_id
          when 'school' then v_school_id is not null and p.school_id = v_school_id
          when 'city' then v_city_id is not null and s.city_id = v_city_id
          else true end;

  select count(*)::int into v_other
  from exam_attempts a
  where a.paper_id = p_paper_id and a.paper_version_id <> v_ver.id and a.is_official
    and a.status in ('submitted', 'grading', 'graded');

  if (v_scope_key = 'class' and v_class_id is null)
     or (v_scope_key = 'school' and v_school_id is null)
     or (v_scope_key = 'city' and v_city_id is null) then
    -- 没分班的学生看"全班"、没学校的看"全校/全市"：给空榜而不是报错，
    -- 客户端据此提示"去看更大的范围"
    v_note := coalesce(v_scope ->> 'note', 'empty_scope');
    v_payload := jsonb_build_object('rows', '[]'::jsonb, 'viewer', null, 'nearby', '[]'::jsonb,
      'stats', jsonb_build_object('total', 0, 'graded', 0, 'ungraded', v_ungraded,
                                  'other_version_skipped', v_other,
                                  'avg_score', null, 'avg_percent', null, 'max_score', null,
                                  'min_score', null, 'median_percent', null, 'p25_percent', null,
                                  'p75_percent', null));
  else
    -- ranked = 全量（不受 range 过滤），scoped = 当前范围。四档名次必须在**全量**上算，
    -- 否则"我的全校名次"会变成"我在这个班里的全校名次"。
    -- 分区键：省 = 不分区（全平台）、市 = schools.city_id、校 = profiles.school_id、
    -- 班 = profiles.class_id；学校的市为空的行在"市"这一档没有名次（null），不是第 0 名。
    with ranked as (
      select a.id as attempt_id, a.user_id, a.total_score, a.full_score,
             a.duration_ms, a.submitted_at,
             p.name, p.avatar_url, p.class_id, p.school_id,
             c.name as class_name, s.name as school_name, s.city_id,
             rank() over (order by a.total_score desc) as province_rank,
             count(*) over () as province_total,
             case when s.city_id is null then null
                  else rank() over (partition by s.city_id order by a.total_score desc) end as city_rank,
             case when s.city_id is null then null
                  else count(*) over (partition by s.city_id) end as city_total,
             case when p.class_id is null then null
                  else rank() over (partition by p.class_id order by a.total_score desc) end as class_rank,
             case when p.class_id is null then null
                  else count(*) over (partition by p.class_id) end as class_total,
             case when p.school_id is null then null
                  else rank() over (partition by p.school_id order by a.total_score desc) end as school_rank,
             case when p.school_id is null then null
                  else count(*) over (partition by p.school_id) end as school_total
      from exam_attempts a
      join profiles p on p.user_id = a.user_id
      left join classes c on c.id = p.class_id
      left join schools s on s.id = p.school_id
      where a.paper_version_id = v_ver.id and a.is_official and a.status = 'graded'
    ),
    scoped as (
      select r.*,
             rank() over (order by r.total_score desc) as rank_in_scope,
             count(*) over () as scope_total,
             row_number() over (order by r.total_score desc, r.duration_ms asc nulls last,
                                r.submitted_at asc, r.name) as ord
      from ranked r
      where case v_scope_key
              when 'class' then r.class_id = v_class_id
              when 'school' then r.school_id = v_school_id
              when 'city' then r.city_id = v_city_id
              else true end
    )
    select jsonb_build_object(
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'order', sc.ord, 'rank', sc.rank_in_scope, 'user_id', sc.user_id,
                 'name', sc.name, 'avatar_url', sc.avatar_url,
                 'school_id', sc.school_id, 'school_name', sc.school_name,
                 'class_id', sc.class_id, 'class_name', sc.class_name,
                 'score', sc.total_score, 'full_score', sc.full_score,
                 'percent', round(sc.total_score / nullif(sc.full_score, 0), 4),
                 'duration_ms', sc.duration_ms, 'submitted_at', sc.submitted_at,
                 'is_me', sc.user_id = v_uid)
               order by sc.ord)
        from scoped sc where sc.ord <= v_limit), '[]'::jsonb),
      'nearby', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'order', sc.ord, 'rank', sc.rank_in_scope, 'user_id', sc.user_id,
                 'name', sc.name, 'avatar_url', sc.avatar_url,
                 'school_id', sc.school_id, 'school_name', sc.school_name,
                 'class_id', sc.class_id, 'class_name', sc.class_name,
                 'score', sc.total_score, 'full_score', sc.full_score,
                 'percent', round(sc.total_score / nullif(sc.full_score, 0), 4),
                 'duration_ms', sc.duration_ms, 'submitted_at', sc.submitted_at,
                 'is_me', sc.user_id = v_uid)
               order by sc.ord)
        from scoped sc
        where abs(sc.ord - (select m.ord from scoped m where m.user_id = v_uid)) <= 2), '[]'::jsonb),
      'viewer', (
        select jsonb_build_object(
                 'user_id', sc.user_id, 'name', sc.name, 'avatar_url', sc.avatar_url,
                 'class_id', sc.class_id, 'class_name', sc.class_name,
                 'school_id', sc.school_id, 'school_name', sc.school_name,
                 'rank', sc.rank_in_scope, 'scope_total', sc.scope_total,
                 'score', sc.total_score, 'full_score', sc.full_score,
                 'percent', round(sc.total_score / nullif(sc.full_score, 0), 4),
                 'duration_ms', sc.duration_ms, 'submitted_at', sc.submitted_at,
                 'class_rank', sc.class_rank, 'class_total', sc.class_total,
                 'school_rank', sc.school_rank, 'school_total', sc.school_total,
                 'city_rank', sc.city_rank, 'city_total', sc.city_total,
                 'province_rank', sc.province_rank, 'province_total', sc.province_total,
                 -- percentile 跟着 city_rank 走（界面上就写在"全市 x/y（超过 z%）"里）。
                 -- 市推不出来的行 city_total 为 null → percentile 也是 null（客户端按 0 读）
                 'percentile', round((sc.city_total - (sc.city_rank - 1))::numeric
                                     / greatest(sc.city_total, 1), 4),
                 'chase', (
                   select jsonb_build_object('user_id', c2.user_id, 'name', c2.name,
                                             'score', c2.total_score,
                                             'gap', round(c2.total_score - sc.total_score, 2))
                   from scoped c2 where c2.ord = sc.ord - 1))
        from scoped sc where sc.user_id = v_uid),
      'stats', (
        select jsonb_build_object(
                 'total', count(*), 'graded', count(*), 'ungraded', v_ungraded,
                 'other_version_skipped', v_other,
                 'avg_score', round(avg(total_score), 2),
                 'avg_percent', round(avg(total_score / nullif(full_score, 0)), 4),
                 'max_score', max(total_score), 'min_score', min(total_score),
                 'median_percent', round(percentile_cont(0.5) within group
                                   (order by total_score / nullif(full_score, 0))::numeric, 4),
                 'p25_percent', round(percentile_cont(0.25) within group
                                   (order by total_score / nullif(full_score, 0))::numeric, 4),
                 'p75_percent', round(percentile_cont(0.75) within group
                                   (order by total_score / nullif(full_score, 0))::numeric, 4))
        from scoped)
    ) into v_payload;

    -- viewer 不在榜上时补一句为什么（榜上没有我 ≠ 我考了但系统没算）
    if v_payload -> 'viewer' is null or v_payload -> 'viewer' = 'null'::jsonb then
      v_note := case
        when v_my_official is null then 'not_submitted'
        when not v_my_official then 'not_official'
        when v_my_status <> 'graded' then 'not_graded'
        else null end;
    end if;
  end if;

  return jsonb_build_object(
    'paper', jsonb_build_object(
      'id', v_paper.id, 'title', v_ver.title, 'exam_name', v_ver.exam_name,
      'subject_label', v_ver.subject_label, 'version_id', v_ver.id,
      'version_no', v_ver.version_no, 'full_score', v_ver.total_score,
      'published_at', v_ver.published_at,
      'school_id', v_paper.school_id,
      'school_name', (select name from schools where id = v_paper.school_id)),
    'scope', jsonb_build_object(
      'key', v_scope_key,
      'label', v_scope ->> 'label',
      'class_id', v_scope -> 'class_id',
      'school_id', v_scope -> 'school_id',
      'city_id', v_scope -> 'city_id',
      'is_staff', v_scope -> 'is_staff',
      'note', v_scope -> 'note',
      'options', jsonb_build_array(
        jsonb_build_object('key', 'class', 'label', '全班', 'id', v_scope -> 'class_id'),
        jsonb_build_object('key', 'school', 'label', '全校', 'id', v_scope -> 'school_id'),
        jsonb_build_object('key', 'city', 'label', '全市', 'id', v_scope -> 'city_id'),
        jsonb_build_object('key', 'province', 'label', '全省', 'id', null))),
    'viewer', coalesce(v_payload -> 'viewer', 'null'::jsonb),
    'viewer_note', v_note,
    'rows', coalesce(v_payload -> 'rows', '[]'::jsonb),
    'nearby', coalesce(v_payload -> 'nearby', '[]'::jsonb),
    'stats', v_payload -> 'stats',
    'limit', v_limit,
    'truncated', coalesce((v_payload -> 'stats' ->> 'total')::int, 0) > v_limit);
end;
$$;

revoke execute on function public.paper_leaderboard(uuid, text, uuid, int) from public, anon;
grant execute on function public.paper_leaderboard(uuid, text, uuid, int) to authenticated;

-- =====================================================================
-- 3) 逐题统计：范围口径必须跟着走（0078 的三处 case）
-- =====================================================================
-- 只改"哪些场次参与统计"的三处筛选：city 档要真按市筛、province 档落到 else true（不筛）。
-- 其余（正确率、选项分布、错答名单、门禁）一行不动。
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
  v_city_id uuid;
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
  v_city_id := nullif(v_scope ->> 'city_id', '')::uuid;

  -- 三个计数：参与统计的、待阅卷的、考旧版卷面的（后两者页面各要说一句）
  select count(*)::int into v_attempts
  from exam_attempts a join profiles p on p.user_id = a.user_id
  left join schools s on s.id = p.school_id
  where a.paper_version_id = v_ver.id and a.is_official
    and a.status in ('submitted', 'grading', 'graded')
    and case v_scope_key
          when 'class' then v_class_id is not null and p.class_id = v_class_id
          when 'school' then v_school_id is not null and p.school_id = v_school_id
          when 'city' then v_city_id is not null and s.city_id = v_city_id
          else true end;

  select count(*)::int into v_ungraded
  from exam_attempts a join profiles p on p.user_id = a.user_id
  left join schools s on s.id = p.school_id
  where a.paper_version_id = v_ver.id and a.is_official
    and a.status in ('submitted', 'grading')
    and case v_scope_key
          when 'class' then v_class_id is not null and p.class_id = v_class_id
          when 'school' then v_school_id is not null and p.school_id = v_school_id
          when 'city' then v_city_id is not null and s.city_id = v_city_id
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
    left join schools s on s.id = p.school_id
    where a.paper_version_id = v_ver.id and a.is_official
      and a.status in ('submitted', 'grading', 'graded')
      and case v_scope_key
            when 'class' then v_class_id is not null and p.class_id = v_class_id
            when 'school' then v_school_id is not null and p.school_id = v_school_id
            when 'city' then v_city_id is not null and s.city_id = v_city_id
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
      'city_id', v_scope -> 'city_id',
      'is_staff', v_scope -> 'is_staff', 'note', v_scope -> 'note',
      'options', jsonb_build_array(
        jsonb_build_object('key', 'class', 'label', '全班', 'id', v_scope -> 'class_id'),
        jsonb_build_object('key', 'school', 'label', '全校', 'id', v_scope -> 'school_id'),
        jsonb_build_object('key', 'city', 'label', '全市', 'id', v_scope -> 'city_id'),
        jsonb_build_object('key', 'province', 'label', '全省', 'id', null))),
    'stats', jsonb_build_object(
      'attempts', v_attempts, 'ungraded', v_ungraded, 'other_version_skipped', v_other),
    'items', v_items,
    'student_limit', v_limit);
end;
$$;

revoke execute on function public.paper_question_stats(uuid, text, uuid, int) from public, anon;
grant execute on function public.paper_question_stats(uuid, text, uuid, int) to authenticated;

notify pgrst, 'reload schema';
