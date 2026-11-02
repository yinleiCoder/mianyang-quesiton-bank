-- 0116: 试卷快照的答案可见性（网页展示路径）
--
-- 背景（2026-11-02）：
-- `get_paper_version` 经 `can_read_paper_version` 对「published + live」的版本
-- 向**所有 authenticated** 放行，返回的 `paper_version_json` 带 `content.answer`。
-- 学生把正卷 URL `/print/paper/<versionId>` 改成 `/print/paper/<versionId>/answers`
-- 就能拿答案；试卷详情页传给 `ExportPdfButton` 的 RSC 载荷同样带答案。
--
-- 考试路径本来就用 0052 的 `strip_answers`（`exam_paper_json`），这里补的是
-- **网页展示路径**。两处必须同一口径：不是"前端不显示"，是根本不发下去。
--
-- 口径：
--   · 教师（is_teacher）、系统管理员、本校管理员可看；
--   · 作者可看；
--   · **这一版**的审批参与人（assigned_user_ids 含本人，或 decided_by 本人）可看；
--   · 其余登录用户（学生）拿到的是**已剥答案**的快照，并带 `answers_visible=false`。
-- 不新增 RPC：`get_paper_version` 签名不变，只改返回内容；所有调用方无需改。
-- 页面层再用 `answers_visible` 做一次纵深防御（见 /print/paper/[id]/answers）。

create or replace function public.can_view_paper_answers(p_version_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from paper_versions v
    join papers p on p.id = v.paper_id
    where v.id = p_version_id and (
      public.is_teacher()
      or (select public.is_admin())
      or public.is_school_admin_of_paper(p.id)
      or v.created_by = (select auth.uid())
      -- 审批参与人只对**这一版**有效：全局 is_approver 会放过别的卷
      or exists (
        select 1 from paper_approvals a
        where a.paper_version_id = v.id
          and ((select auth.uid()) = any(a.assigned_user_ids)
               or a.decided_by = (select auth.uid()))
      )
    )
  );
$$;

revoke execute on function public.can_view_paper_answers(uuid) from public, anon;
grant execute on function public.can_view_paper_answers(uuid) to authenticated;

-- 对外读入口：可见性断言不变；答案按角色剥离，并显式告诉页面是否可见。
-- 剥答案复用 0052 的 `strip_answers`，别在这里再写一套。
create or replace function public.get_paper_version(p_version_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_snap jsonb;
  v_secs jsonb;
  v_items jsonb;
begin
  -- 允许匿名判断之外的路径：作者/管理员/本校管理员/审批参与人/已发布
  if not public.can_read_paper_version(p_version_id) then
    raise exception '无权查看这份试卷' using errcode = '42501';
  end if;

  v_snap := public.paper_version_json(p_version_id);
  if v_snap is null then return null; end if;

  -- 教师/管理员/作者/本版审批人：保留答案
  if public.can_view_paper_answers(p_version_id) then
    return jsonb_set(v_snap, '{answers_visible}', 'true'::jsonb);
  end if;

  -- 其余登录用户（学生）：与 exam_paper_json 完全同口径地剥掉 content.answer
  select coalesce(jsonb_agg(
           jsonb_set(s, '{items}', coalesce((
             select jsonb_agg(
                      jsonb_set(it, '{content}', public.strip_answers(it -> 'content'))
                      order by it -> 'seq')
             from jsonb_array_elements(s -> 'items') it), '[]'::jsonb))
           order by s -> 'sort_order'), '[]'::jsonb)
    into v_secs
    from jsonb_array_elements(v_snap -> 'sections') s;

  select coalesce(jsonb_agg(
           jsonb_set(it, '{content}', public.strip_answers(it -> 'content'))
           order by it -> 'seq'), '[]'::jsonb)
    into v_items
    from jsonb_array_elements(v_snap -> 'items') it;

  v_snap := jsonb_set(jsonb_set(v_snap, '{sections}', v_secs), '{items}', v_items);
  return jsonb_set(v_snap, '{answers_visible}', 'false'::jsonb);
end;
$$;

comment on function public.get_paper_version(uuid) is
  '整卷快照；答案只对教师/管理员/作者/本版审批人可见（0116）。'
  '返回值带 answers_visible；学生拿到的是已剥答案的版本。';
