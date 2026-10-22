-- 0104: 改版草稿的生命周期 + 组卷库的创建者/合卷者
--
-- 用户 2026-10-22 报：
--   1. 发起改版后的草稿只复制了试卷，详情页没有「编辑卷面」入口；
--   2. 已发布试卷和改版草稿都没有删除入口；
--   3. 组卷库列表没有标注创建者、合卷者。
--
-- 原因/修法：
--   · 详情页优先展示 current_published_version_id，改版草稿被它盖住了 → 前端补一条
--     「改版草稿」横幅（编辑/删除/撤回），主预览仍看已入库版本；
--   · 整卷删除 delete_paper 有 0091 的规则（有考试记录/有在审任务不许删），但缺一条
--     **只删改版草稿、保留已入库版本** 的 RPC → 新增 delete_paper_version；
--   · list_my_papers 旧 SQL 会把"有在流版本 + 已入库版本"的同一份试卷列成两行 →
--     改成每份试卷一行（在流优先），并带 creator_name / collaborators；
--   · list_papers（公共库）也带 creator_name / collaborators；
--   · retract_paper 原来把版本置为 retracted 终态，撤回后不能改 → 改为回到 draft
--     （与题目 0101 的口径一致，改版撤回后能继续编辑再提交）。

-- =====================================================================
-- 1) 守卫：放行"单版本删除"（仅草稿/被退回，由 delete_paper_version 校验）
-- =====================================================================
create or replace function public.guard_paper_version_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 整份试卷被合法删除（delete_paper 打开开关）：放行，让级联把版本一起带走
  if tg_op = 'DELETE' and current_setting('app.allow_paper_delete', true) = 'on' then
    return old;
  end if;

  -- 单个改版版本被删除（delete_paper_version 打开开关）：只放行草稿/被退回。
  -- 归属、「不是当前入库版」、至少保留一个版本都在 RPC 里校验。
  if tg_op = 'DELETE' and current_setting('app.allow_paper_version_delete', true) = 'on' then
    if old.status not in ('draft', 'returned') then
      raise exception '只能删除草稿或被退回的改版';
    end if;
    return old;
  end if;

  if old.status in ('published', 'superseded', 'retracted') then
    if tg_op = 'UPDATE'
       and old.status = 'published' and new.status = 'superseded'
       and current_setting('app.allow_paper_supersede', true) = 'on'
       and (to_jsonb(new) - 'status') is not distinct from (to_jsonb(old) - 'status') then
      return new;
    end if;
    -- 用户注销清理：仅 created_by 置空，其余字段（含 status/卷面/时间戳）原样
    if tg_op = 'UPDATE'
       and current_setting('app.user_cleanup', true) = 'on'
       and old.created_by is not null and new.created_by is null
       and (to_jsonb(new) - 'created_by') is not distinct from (to_jsonb(old) - 'created_by') then
      return new;
    end if;
    raise exception '该状态的试卷版本不可直接修改';
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception '只能删除纯草稿版本的试卷';
    end if;
    -- 必须返回 OLD：BEFORE DELETE 触发器返回 NULL 会**静默取消**这次删除（0048 的坑）
    return old;
  end if;
  return new;
end;
$$;

-- 只删一份改版草稿，保留已入库版本
create or replace function public.delete_paper_version(p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_ver paper_versions%rowtype;
  v_paper papers%rowtype;
begin
  select * into v_ver from paper_versions where id = p_version_id;
  if not found then
    raise exception '试卷版本不存在';
  end if;
  select * into v_paper from papers where id = v_ver.paper_id;
  if v_paper.creator_id is distinct from v_uid and not public.is_admin() then
    raise exception '只能删除自己创建的试卷版本';
  end if;
  if v_ver.status not in ('draft', 'returned') then
    raise exception '只有草稿或被退回的改版可以删除；审核中请先撤回';
  end if;
  if v_paper.current_published_version_id = p_version_id then
    raise exception '不能删除当前入库版本';
  end if;
  if not exists (
    select 1 from paper_versions v
    where v.paper_id = v_paper.id and v.id <> p_version_id
  ) then
    raise exception '这是试卷的唯一版本，请直接删除试卷';
  end if;
  if exists (
    select 1 from paper_approvals a
    where a.paper_version_id = p_version_id and a.state = 'waiting'
  ) then
    raise exception '该版本还有审批中的任务，请先撤回';
  end if;

  perform public.paper_audit('delete_paper_version', v_paper.id, p_version_id,
    jsonb_build_object('version_no', v_ver.version_no, 'status', v_ver.status));

  perform set_config('app.allow_paper_version_delete', 'on', true);
  delete from paper_versions where id = p_version_id;
end;
$$;

-- 撤回审核中的改版 → 回到草稿（与题目 retract_question 同口径，撤回后可继续编辑）
create or replace function public.retract_paper(p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_ver paper_versions%rowtype;
begin
  select * into v_ver from paper_versions where id = p_version_id;
  if not found then
    raise exception '试卷不存在';
  end if;
  if v_ver.created_by is distinct from v_uid then
    raise exception '只能撤回自己提交的试卷';
  end if;
  if v_ver.status not in ('pending_group', 'pending_city') then
    raise exception '只有审核中的试卷可以撤回';
  end if;
  update paper_versions set status = 'draft' where id = p_version_id;
  update paper_approvals set state = 'cancelled'
  where paper_version_id = p_version_id and state = 'waiting';
  perform public.paper_audit('retract_paper', v_ver.paper_id, p_version_id);
end;
$$;

revoke execute on function public.delete_paper_version(uuid) from public, anon;
grant execute on function public.delete_paper_version(uuid) to authenticated;

-- =====================================================================
-- 2) 我的试卷：每份试卷一行（在流版本优先），带创建者/合卷者
-- =====================================================================
create or replace function public.list_my_papers(p_limit int default 50, p_offset int default 0)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_rows jsonb;
  v_total int;
begin
  select count(*)::int into v_total from papers p
  where p.creator_id = v_uid;

  select coalesce(jsonb_agg(x.payload order by x.sort_key desc), '[]'::jsonb)
    into v_rows
    from (
      select jsonb_build_object(
               'paper_id', p.id, 'version_id', v.id, 'version_no', v.version_no,
               'title', v.title, 'exam_name', v.exam_name, 'subject_label', v.subject_label,
               'status', v.status, 'total_score', v.total_score, 'target_score', v.target_score,
               'duration_minutes', v.duration_minutes,
               'published_version_id', p.current_published_version_id,
               'paper_state', p.state, 'course_node_id', p.course_node_id,
               'creator_id', p.creator_id,
               'creator_name', (select pr.name from profiles pr where pr.user_id = p.creator_id),
               'collaborators', coalesce((
                 -- 合卷者按**整份试卷**聚合：改版草稿没有重新分派时，
                 -- 也应该显示上一版/已入库版本的协作老师
                 select jsonb_agg(distinct pr.name order by pr.name)
                 from paper_assignments a
                 join paper_versions pv2 on pv2.id = a.version_id
                 join profiles pr on pr.user_id = a.assignee_id
                 where pv2.paper_id = p.id and pr.name is not null), '[]'::jsonb),
               'item_count', (select count(*) from paper_items i where i.paper_version_id = v.id),
               'health', (select count(*) from paper_items i
                          join questions q on q.id = i.question_id
                          join question_versions qv on qv.id = i.question_version_id
                          where i.paper_version_id = v.id
                            and not (q.state = 'live' and qv.status = 'published'
                                     and q.current_published_version_id = i.question_version_id)),
               'deletable', (not exists (select 1 from exam_attempts a where a.paper_id = p.id)
                             and not exists (select 1 from paper_approvals a
                                             where a.paper_id = p.id and a.state = 'waiting')),
               'updated_at', v.updated_at, 'submitted_at', v.submitted_at, 'published_at', v.published_at,
               'waiting_stage', (select a.stage from paper_approvals a
                                 where a.paper_version_id = v.id and a.state = 'waiting' limit 1),
               'waiting_assignees', (select a.assigned_user_ids from paper_approvals a
                                     where a.paper_version_id = v.id and a.state = 'waiting' limit 1)
             ) as payload,
             coalesce(v.published_at, v.submitted_at, v.updated_at) as sort_key
      from papers p
      -- 每份试卷只取一行：有草稿/在审/退回的改版时优先它，否则取当前入库版
      join lateral (
        select v2.*
        from paper_versions v2
        where v2.paper_id = p.id
          and (v2.status in ('draft','pending_group','pending_city','returned')
               or v2.id = p.current_published_version_id)
        order by
          case when v2.status in ('draft','pending_group','pending_city','returned') then 0 else 1 end,
          v2.version_no desc
        limit 1
      ) v on true
      where p.creator_id = v_uid
      order by sort_key desc
      limit v_limit offset v_offset
    ) x;

  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'papers', v_rows);
end;
$$;

-- =====================================================================
-- 3) 公共组卷库：带创建者/合卷者
-- =====================================================================
create or replace function public.list_papers(
  p_node uuid default null, p_kw text default null,
  p_limit int default 20, p_offset int default 0)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_limit int := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset int := greatest(coalesce(p_offset, 0), 0);
  v_rows jsonb;
  v_total int;
begin
  with recursive subtree as (
    select id from subject_nodes where id = p_node
    union all
    select sn.id from subject_nodes sn join subtree st on sn.parent_id = st.id
  ),
  hit as (
    select v.id as version_id, v.paper_id, v.title, v.exam_name, v.subject_label,
           v.total_score, v.duration_minutes, v.version_no, v.published_at,
           p.school_id, p.course_node_id,
           p.creator_id,
           (select pr.name from profiles pr where pr.user_id = p.creator_id) as creator_name,
           coalesce((
             select jsonb_agg(distinct pr.name order by pr.name)
             from paper_assignments a
             join paper_versions pv2 on pv2.id = a.version_id
             join profiles pr on pr.user_id = a.assignee_id
             where pv2.paper_id = p.id and pr.name is not null), '[]'::jsonb) as collaborators,
           (not exists (select 1 from exam_attempts a where a.paper_id = p.id)
            and not exists (select 1 from paper_approvals a
                            where a.paper_id = p.id and a.state = 'waiting')) as deletable,
           (select count(*) from paper_items i where i.paper_version_id = v.id) as item_count,
           count(*) over () as total_count
    from paper_versions v
    join papers p on p.id = v.paper_id
    where v.status = 'published' and p.state = 'live' and p.current_published_version_id = v.id
      and (p_node is null or p.course_node_id in (select id from subtree))
      and (p_kw is null or trim(p_kw) = ''
           or strpos(lower(v.title), lower(trim(p_kw))) > 0
           or strpos(lower(coalesce(v.exam_name, '')), lower(trim(p_kw))) > 0)
  ),
  page as (
    select * from hit order by published_at desc nulls last limit v_limit offset v_offset
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'version_id', g.version_id, 'paper_id', g.paper_id, 'title', g.title,
           'exam_name', g.exam_name, 'subject_label', g.subject_label,
           'total_score', g.total_score, 'duration_minutes', g.duration_minutes,
           'version_no', g.version_no, 'published_at', g.published_at,
           'school_id', g.school_id, 'course_node_id', g.course_node_id,
           'creator_id', g.creator_id, 'creator_name', g.creator_name,
           'collaborators', g.collaborators, 'deletable', g.deletable,
           'item_count', g.item_count) order by g.published_at desc nulls last), '[]'::jsonb),
         coalesce(max(g.total_count), 0)::int
    into v_rows, v_total
    from page g;

  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'papers', v_rows);
end;
$$;

notify pgrst, 'reload schema';
