-- 0085b: 协同组卷 · 分段保存（0085 的最后一步，单独一个文件）。
--
-- 为什么拆出来：这两个函数要"换掉自己那段题目"，实现上必然是**先删后插**
-- （旧行不删，新列表变短时多出来的题会留在卷面上）。而 0085 是通过 MCP 的
-- apply_migration 分步落到线上的，那条路径对含 `delete` 的语句会自动拒绝
-- （实测：第 1/2/3a-3d/4a 步都过，只有含 delete 的第 3 步与 4b 被拒）。
-- 于是这两段单独成文件、由人在 Supabase 面板的 SQL Editor 里执行。
--
-- **一份卷子的完整落库顺序**：0085（表/列/回填 → 读权限 → 分派与读取 RPC →
-- 交段与"别人的段删不掉"的守卫）→ 本文件（两个分段保存 RPC）。
-- 两部分都跑完，协同组卷才可用。

-- 创始人编辑**自己**的题（assignment_id 为 null 的那些）+ 大题表头（标题/说明/计分口径）。
-- 已分派出去的题一行都不碰。
--
-- **没有乐观锁参数**（与 save_paper_draft 不同）：版本级的 `updated_us` 在协作期间必然失效 ——
-- trg_paper_items_total 会在任何题项变动后 update paper_versions，trg_paper_versions_touch
-- 于是刷新 updated_at，于是**任何一个被指派人存一次，其他人的 token 全废**。
-- 分段保存本身是"一段一个写者"，不需要版本级锁；同一人两个标签页互相覆盖是唯一代价。
create or replace function public.save_paper_section(
  p_version_id uuid, p_section_ord integer, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_ver paper_versions%rowtype;
  v_sec paper_sections%rowtype;
  v_sec_id uuid;
  v_item jsonb;
  v_qv record;
  v_units numeric[];
  v_custom jsonb;
  v_mode text;
  v_each numeric;
  v_pos int := 0;
  v_base int;
  v_min_assigned int;
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
  select * into v_ver from paper_versions where id = p_version_id;
  if not found then
    raise exception '试卷不存在';
  end if;
  if v_ver.created_by is distinct from v_uid then
    raise exception '这一段不在你手里（只有创始人与被指派人能改）';
  end if;
  if v_ver.status not in ('draft', 'returned') then
    raise exception '只能编辑草稿或被退回的试卷';
  end if;

  select * into v_sec from paper_sections
   where paper_version_id = p_version_id and sort_order = p_section_ord;
  if not found then
    raise exception '第 % 个大题不存在', p_section_ord;
  end if;
  v_sec_id := v_sec.id;

  v_mode := coalesce(nullif(p_payload ->> 'score_mode', ''), v_sec.score_mode);
  if v_mode not in ('per_item', 'per_blank', 'per_sub') then
    raise exception '计分口径不合法';
  end if;
  v_each := coalesce(nullif(p_payload ->> 'score_each', '')::numeric, v_sec.score_each);
  if v_each < 0 or v_each > 100 then
    raise exception '每小题分值必须在 0~100 之间';
  end if;

  -- 这一段里还活着的分派段，最小起点：创始人自己的题只能排在它前面
  -- （已收回的那些 assignee_id = created_by，不算）
  select min(from_qno) into v_min_assigned from paper_assignments
   where version_id = p_version_id and section_ord = p_section_ord
     and assignee_id <> created_by;

  -- 换掉"自己的"题（别人的一行不碰）。先删后插：删在插之前，seq 的唯一索引不会撞。
  delete from paper_items
   where paper_version_id = p_version_id and section_id = v_sec_id and assignment_id is null;

  select coalesce(max(seq), 0) into v_base from paper_items where paper_version_id = p_version_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_payload -> 'items', '[]'::jsonb)) loop
    v_pos := v_pos + 1;
    if v_min_assigned is not null and v_pos >= v_min_assigned then
      raise exception '第 % 大题从第 % 题起已分派给别人，你在这里最多放 % 道题',
        p_section_ord, v_min_assigned, v_min_assigned - 1;
    end if;

    select * into v_qv from public.resolve_paper_item(
      nullif(v_item ->> 'question_version_id', '')::uuid);
    if v_item ->> 'question_id' is not null
       and (v_item ->> 'question_id')::uuid <> v_qv.question_id then
      raise exception '第 % 题的题目与版本不匹配', v_pos;
    end if;

    v_custom := case when v_item ? 'custom_units' and jsonb_typeof(v_item -> 'custom_units') = 'array'
                     then v_item -> 'custom_units' else null end;
    if v_custom is not null and jsonb_array_length(v_custom) > 0 then
      perform public.jsonb_numeric_sum(v_custom);
    end if;
    v_units := public.paper_item_units(v_qv.qtype, v_qv.content, v_mode, v_each, v_custom);

    begin
      insert into paper_items
        (paper_version_id, section_id, seq, pos, question_id, question_version_id,
         qtype, difficulty, score, score_units, origin, note, assignment_id)
      values
        (p_version_id, v_sec_id, v_base + v_pos, v_pos, v_qv.question_id, v_qv.version_id,
         v_qv.qtype, v_qv.difficulty,
         (select coalesce(sum(u), 0) from unnest(v_units) u),
         to_jsonb(v_units),
         coalesce(nullif(v_item ->> 'origin', ''), 'bank'),
         nullif(trim(v_item ->> 'note'), ''), null);
    exception when unique_violation then
      raise exception '第 % 大题的第 % 题与卷内已有题目重复（同一份试卷不能用两道相同的题）', p_section_ord, v_pos;
    end;
  end loop;

  update paper_sections set
    title = coalesce(nullif(trim(p_payload ->> 'title'), ''), title),
    instruction = case when p_payload ? 'instruction'
                       then nullif(trim(p_payload ->> 'instruction'), '') else instruction end,
    score_mode = v_mode,
    score_each = v_each
  where id = v_sec_id;

  perform public.recompute_paper_seq(p_version_id);
  perform public.paper_audit('save_paper_section', v_ver.paper_id, p_version_id,
    jsonb_build_object('section_ord', p_section_ord, 'items', v_pos));

  return public.paper_version_json(p_version_id);
end;
$$;

-- 被指派人保存自己那一段：题只能落在 [from_qno, to_qno] 内，数量不能超过区间长度。
-- 第一次保存把 open 置成 claimed（"有人在做了"）。
-- **乐观锁是段级的**（paper_assignments.updated_at，每次保存显式刷新）：
-- 它保护的正是文档要的那件事——交完又被改、以及创始人解锁后旧页面还能写。
create or replace function public.save_paper_assignment(
  p_assignment_id uuid, p_items jsonb, p_expected_us bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_a paper_assignments%rowtype;
  v_ver paper_versions%rowtype;
  v_cur_us bigint;
  v_sec paper_sections%rowtype;
  v_item jsonb;
  v_qv record;
  v_units numeric[];
  v_custom jsonb;
  v_pos int := 0;
  v_base int;
  v_cap int;
  v_new_us bigint;
begin
  select * into v_a from paper_assignments where id = p_assignment_id;
  if not found then
    raise exception '分派不存在';
  end if;
  if v_a.assignee_id is distinct from v_uid then
    raise exception '这一段不在你手里' using errcode = '42501';
  end if;
  if v_a.state in ('submitted', 'locked') then
    raise exception '这一段已提交（交了即锁）。要改请联系创始人解锁';
  end if;

  select * into v_ver from paper_versions where id = v_a.version_id;
  if v_ver.status not in ('draft', 'returned') then
    raise exception '卷子已提交或已入库，不能再改';
  end if;

  v_cur_us := (extract(epoch from v_a.updated_at) * 1000000)::bigint;
  if p_expected_us is not null and p_expected_us <> v_cur_us then
    raise exception '这一段在别处被改过（或在另一个标签页里编辑），请刷新页面后重试'
      using errcode = '40001';
  end if;

  select * into v_sec from paper_sections
   where paper_version_id = v_a.version_id and sort_order = v_a.section_ord;
  if not found then
    raise exception '第 % 个大题不存在（卷面结构可能被创始人改过，请刷新）', v_a.section_ord;
  end if;

  v_cap := v_a.to_qno - v_a.from_qno + 1;
  if coalesce(jsonb_array_length(coalesce(p_items, '[]'::jsonb)), 0) > v_cap then
    raise exception '这一段是第 %~% 题，最多 % 道题', v_a.from_qno, v_a.to_qno, v_cap;
  end if;

  delete from paper_items where assignment_id = p_assignment_id;

  select coalesce(max(seq), 0) into v_base from paper_items where paper_version_id = v_a.version_id;

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_pos := v_pos + 1;
    select * into v_qv from public.resolve_paper_item(
      nullif(v_item ->> 'question_version_id', '')::uuid);
    if v_item ->> 'question_id' is not null
       and (v_item ->> 'question_id')::uuid <> v_qv.question_id then
      raise exception '第 % 题（段内第 % 题）的题目与版本不匹配', v_a.from_qno + v_pos - 1, v_pos;
    end if;

    v_custom := case when v_item ? 'custom_units' and jsonb_typeof(v_item -> 'custom_units') = 'array'
                     then v_item -> 'custom_units' else null end;
    if v_custom is not null and jsonb_array_length(v_custom) > 0 then
      perform public.jsonb_numeric_sum(v_custom);
    end if;
    v_units := public.paper_item_units(v_qv.qtype, v_qv.content, v_sec.score_mode, v_sec.score_each, v_custom);

    begin
      insert into paper_items
        (paper_version_id, section_id, seq, pos, question_id, question_version_id,
         qtype, difficulty, score, score_units, origin, note, assignment_id)
      values
        (v_a.version_id, v_sec.id, v_base + v_pos, v_a.from_qno + v_pos - 1,
         v_qv.question_id, v_qv.version_id,
         v_qv.qtype, v_qv.difficulty,
         (select coalesce(sum(u), 0) from unnest(v_units) u),
         to_jsonb(v_units),
         coalesce(nullif(v_item ->> 'origin', ''), 'bank'),
         nullif(trim(v_item ->> 'note'), ''), p_assignment_id);
    exception when unique_violation then
      raise exception '第 % 题与卷内已有题目重复（同一份试卷不能用两道相同的题）', v_a.from_qno + v_pos - 1;
    end;
  end loop;

  -- 每次保存都刷新这一段自己的 token（trg_paper_assignments_touch 会写 updated_at）
  update paper_assignments
     set state = case when v_a.state = 'open' and v_pos > 0 then 'claimed' else state end,
         updated_at = now()
   where id = p_assignment_id
   returning (extract(epoch from updated_at) * 1000000)::bigint into v_new_us;

  perform public.recompute_paper_seq(v_a.version_id);
  perform public.paper_audit('save_paper_assignment', v_ver.paper_id, v_a.version_id,
    jsonb_build_object('assignment_id', p_assignment_id, 'items', v_pos));

  return jsonb_build_object(
    'version', public.paper_version_json(v_a.version_id),
    'assignment_us', v_new_us);
end;
$$;

revoke all on function public.save_paper_section(uuid, integer, jsonb) from public, anon;
revoke all on function public.save_paper_assignment(uuid, jsonb, bigint) from public, anon;
grant execute on function public.save_paper_section(uuid, integer, jsonb) to authenticated;
grant execute on function public.save_paper_assignment(uuid, jsonb, bigint) to authenticated;

notify pgrst, 'reload schema';
