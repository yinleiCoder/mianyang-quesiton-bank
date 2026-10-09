-- 0091：试卷能不能删，判据从「没提交过审核」改成「没人考过」
--
-- 起因（2026-10-08）：组卷库里两条试卷在界面上都没有删除入口，但它们其实是两回事：
--   · 【测试】客户端联调卷（offline、0 场考试）—— 本来可以安全删掉，被旧判据误伤；
--   · 24级计算机模拟卷（一）（live、14 场考试）—— 删不得，学生成绩单指着它。
--
-- 旧判据是"所有版本都是 draft"，那是个**代理判据**：它真正想保护的是"别删掉有人用过的卷子"。
-- 而真正的依赖只有一处，数据库早就写明了 —— `exam_attempts.paper_id/paper_version_id`
-- 是 **ON DELETE RESTRICT**（其余引用不是 CASCADE 就是 SET NULL）。所以直接问那个问题更准。
--
-- 仍然拦着的两条：
--   · 有人考过（考场记录会变成孤儿）；
--   · 有正在审批的任务（让审批人手上的任务凭空消失不体面，先撤回再删）；
--   · 不是自己创建的（管理员除外）。
--
-- 函数名去掉 `_draft`：它现在管的不只是草稿，名字得说实话。旧的留成**一层壳**转发到新名字，
-- 免得任何还在调旧名字的地方（含别人本地没更新的分支）突然 404。

create or replace function public.delete_paper(p_paper_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_paper papers%rowtype;
  v_attempts int;
begin
  select * into v_paper from papers where id = p_paper_id;
  if not found then
    raise exception '试卷不存在';
  end if;
  if v_paper.creator_id is distinct from v_uid and not public.is_admin() then
    raise exception '只能删除自己创建的试卷';
  end if;

  select count(*) into v_attempts from exam_attempts where paper_id = p_paper_id;
  if v_attempts > 0 then
    raise exception '这份试卷已有 % 场考试记录，不能删除（学生还要在成绩单里看它）', v_attempts;
  end if;

  if exists (select 1 from paper_approvals
             where paper_id = p_paper_id and state = 'waiting') then
    raise exception '该试卷有正在审批的任务，请先撤回再删除';
  end if;

  perform public.paper_audit('delete_paper', p_paper_id, null,
    jsonb_build_object('title', (select title from paper_versions where paper_id = p_paper_id
                                 order by version_no desc limit 1)));
  delete from papers where id = p_paper_id;
end;
$$;

-- 旧名字：转发。**不要再往里加逻辑** —— 规则只有一份，就在上面。
create or replace function public.delete_paper_draft(p_paper_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.delete_paper(p_paper_id);
end;
$$;

revoke execute on function public.delete_paper(uuid) from public, anon;
grant execute on function public.delete_paper(uuid) to authenticated;
revoke execute on function public.delete_paper_draft(uuid) from public, anon;
grant execute on function public.delete_paper_draft(uuid) to authenticated;

-- 列表带上 deletable：**判据只有服务端这一份**，界面照着画按钮就行。
-- 客户端的 status/version_no 推不出来（它们说明不了"有没有人考过"）。
create or replace function public.list_my_papers(p_limit integer default 50, p_offset integer default 0)
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
      join paper_versions v on v.paper_id = p.id
      where p.creator_id = v_uid
        and (v.status in ('draft','pending_group','pending_city','returned')
             or v.id = p.current_published_version_id)
      order by sort_key desc
      limit v_limit offset v_offset
    ) x;

  return jsonb_build_object('total', v_total, 'limit', v_limit, 'offset', v_offset, 'papers', v_rows);
end;
$$;
