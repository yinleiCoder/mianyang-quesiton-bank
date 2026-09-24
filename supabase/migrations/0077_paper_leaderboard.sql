-- 0077: 试卷成绩排行榜（全班 / 全校 / 全市三档）。
--
-- 产品口径（用户 2026-09-24）：能看到某张试卷的排名，参考多邻国，按班级/学校/全市三档看，
-- **显示真实姓名与学校名**（用户明确选了不脱敏），首次交卷计入排行（0076 的 is_official）、
-- 后续考试为自主练习不计入。
--
-- 为什么必须是 SECURITY DEFINER：`exam_attempts` 的 RLS 是「本人或该卷阅卷人」
-- （0051 的策略，已核实线上），跨学生读一条都读不到。0063 那四条"为什么要走 definer
-- 而不是放宽 RLS"的论证在这里同样成立，而且更重——这次是把**别人的姓名与分数**开给学生。
--
-- **硬约束（改这个文件前先读）**：返回体里只出现白名单字段，
-- 永不 `to_jsonb(exam_attempts)` 整行（会把 graded_by 之类的内部列带出去），
-- 也永不返回作答内容或标准答案。泄漏面钉死在"谁多少分、谁排第几"。
-- 与 0052 那句"不是前端不显示，是根本不发下去"同一条规矩。
--
-- 榜单只看**当前入库版本**（改版后题与满分都变了，混排不公平）：旧版本的场次计入
-- `stats.other_version_skipped` 并在页面上说明，而不是静默消失。

-- =====================================================================
-- 1) 范围解析（内部助手）：排行榜与每题统计共用，让**授权推理只有一份**
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
begin
  if v_scope not in ('class', 'school', 'city') then
    raise exception '榜单范围不合法（只能是 class / school / city）';
  end if;

  select * into v_me from profiles where user_id = v_uid;
  -- 学校管理员不一定 identity='teacher'（is_teacher 只看 identity 与 is_admin），
  -- 所以这里补一条 is_school_admin，否则他会被当成学生、被静默夹到"自己的班"
  v_staff := public.is_teacher() or public.is_admin() or public.is_school_admin(v_me.school_id);

  if v_scope = 'city' then
    -- 全市 = 全平台（schools 表没有城市列）。将来接入外市学校时这里要跟着改口径
    return jsonb_build_object('scope', 'city', 'label', '全市',
                              'class_id', null, 'school_id', null, 'is_staff', v_staff);
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
-- 2) 排行榜
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

  -- 我在这场卷子上的状态（决定 viewer.note：没考 / 是自主练习 / 还在待阅卷）
  select x.is_official, x.status into v_my_official, v_my_status
  from exam_attempts x
  where x.paper_version_id = v_ver.id and x.user_id = v_uid
  order by x.is_official desc, coalesce(x.submitted_at, x.started_at) desc
  limit 1;

  -- 未出分（主观题没判完）与旧版卷面的场次：分别计数，页面据此解释"榜为什么是空的"
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

  if (v_scope_key = 'class' and v_class_id is null) or (v_scope_key = 'school' and v_school_id is null) then
    -- 没分班的学生看"全班"：给空榜而不是报错，客户端据此提示"去看全校 / 全市"
    v_note := coalesce(v_scope ->> 'note', 'empty_scope');
    v_payload := jsonb_build_object('rows', '[]'::jsonb, 'viewer', null, 'nearby', '[]'::jsonb,
      'stats', jsonb_build_object('total', 0, 'graded', 0, 'ungraded', v_ungraded,
                                  'other_version_skipped', v_other,
                                  'avg_score', null, 'avg_percent', null, 'max_score', null,
                                  'min_score', null, 'median_percent', null, 'p25_percent', null,
                                  'p75_percent', null));
  else
    -- ranked = 全量（不受 range 过滤），scoped = 当前范围。三档名次必须在**全量**上算，
    -- 否则"我的全校名次"会变成"我在这个班里的全校名次"。
    with ranked as (
      select a.id as attempt_id, a.user_id, a.total_score, a.full_score,
             a.duration_ms, a.submitted_at,
             p.name, p.avatar_url, p.class_id, p.school_id,
             c.name as class_name, s.name as school_name,
             rank() over (order by a.total_score desc) as city_rank,
             count(*) over () as city_total,
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
      'is_staff', v_scope -> 'is_staff',
      'note', v_scope -> 'note',
      'options', jsonb_build_array(
        jsonb_build_object('key', 'class', 'label', '全班', 'id', v_scope -> 'class_id'),
        jsonb_build_object('key', 'school', 'label', '全校', 'id', v_scope -> 'school_id'),
        jsonb_build_object('key', 'city', 'label', '全市', 'id', null))),
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

notify pgrst, 'reload schema';
