-- 0149: 阅卷批量认领（公共池多选 + 一键全部）
--
-- 0148 的 claim_exam_grading 一次只认领一场；这里补两个批量入口：
--   · claim_exam_grading_bulk(uuid[])：认领勾选的场次，逐场跳过别人已认领/不在范围/非待批的；
--   · claim_all_exam_grading(uuid)：把某份卷里「我能批且未认领」的场次一次认领完。
-- 两者都复用 0148 的 can_user_grade_attempt 资格口径，认领仍是行锁 + 条件更新。

-- =====================================================================
-- 1) 多选认领：逐场处理，冲突不中断整批
-- =====================================================================
create or replace function public.claim_exam_grading_bulk(p_attempt_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_ids uuid[];
  v_id uuid;
  v_a exam_attempts%rowtype;
  v_name text;
  v_claimed int := 0;
  v_skipped int := 0;
  v_conflicts jsonb := '[]'::jsonb;
begin
  -- 去重并按 id 排序：两位老师同时批量认领同一批场次时，锁定顺序一致，避免死锁。
  select array_agg(distinct t.v order by t.v) into v_ids
  from unnest(coalesce(p_attempt_ids, '{}'::uuid[])) as t(v);
  if coalesce(array_length(v_ids, 1), 0) = 0 then
    return jsonb_build_object('claimed', 0, 'skipped', 0, 'conflicts', '[]'::jsonb);
  end if;

  foreach v_id in array v_ids loop
    select * into v_a from exam_attempts where id = v_id for update;
    if not found then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if v_a.status not in ('submitted', 'grading') then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if not public.can_user_grade_attempt(v_uid, v_id) then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    if v_a.claimed_by is not null and v_a.claimed_by <> v_uid then
      select name into v_name from profiles where user_id = v_a.claimed_by;
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'attempt_id', v_id,
        'claimed_by_name', coalesce(v_name, '其他老师')));
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if v_a.claimed_by is null then
      update exam_attempts
      set claimed_by = v_uid, claimed_at = now()
      where id = v_id;
    end if;
    v_claimed := v_claimed + 1;
  end loop;

  return jsonb_build_object(
    'claimed', v_claimed, 'skipped', v_skipped, 'conflicts', v_conflicts);
end;
$$;

comment on function public.claim_exam_grading_bulk(uuid[]) is
  '批量认领勾选的场次；别人已认领的记入 conflicts 并跳过，不影响其余场次。';

-- =====================================================================
-- 2) 一键认领本卷全部：只碰「我能批且未认领」的场次
-- =====================================================================
create or replace function public.claim_all_exam_grading(p_paper_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_id uuid;
  v_claimed int := 0;
  v_skipped int := 0;
begin
  if not public.is_paper_grader(p_paper_id)
     and not exists (
       select 1 from exam_attempts a
       where a.paper_id = p_paper_id
         and public.can_user_grade_attempt(v_uid, a.id)
     ) then
    raise exception '你没有这份卷的阅卷权限（学校/专业/科目不符）'
      using errcode = '42501';
  end if;

  for v_id in
    select a.id
    from exam_attempts a
    where a.paper_id = p_paper_id
      and a.status in ('submitted', 'grading')
      and a.claimed_by is null
      and public.can_user_grade_attempt(v_uid, a.id)
    order by coalesce(a.submitted_at, a.started_at)
    for update skip locked
  loop
    update exam_attempts
    set claimed_by = v_uid, claimed_at = now()
    where id = v_id and claimed_by is null;

    if found then
      v_claimed := v_claimed + 1;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return jsonb_build_object('claimed', v_claimed, 'skipped', v_skipped);
end;
$$;

comment on function public.claim_all_exam_grading(uuid) is
  '一键认领某份卷里当前用户能批且未认领的场次；并发被抢走的计入 skipped。';

-- =====================================================================
-- 3) 授权
-- =====================================================================
revoke execute on function public.claim_exam_grading_bulk(uuid[]) from public, anon;
grant execute on function public.claim_exam_grading_bulk(uuid[]) to authenticated;

revoke execute on function public.claim_all_exam_grading(uuid) from public, anon;
grant execute on function public.claim_all_exam_grading(uuid) to authenticated;
