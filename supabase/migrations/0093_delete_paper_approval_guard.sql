-- 0093：删整份试卷时，让**审批守卫**也放行
--
-- 09XX 系列把"删整份试卷"这条路一层层打通，每一步都是被真实报错顶出来的：
--   0091  放宽 RPC 判据（没人考过 + 没有在审任务 + 自己建的）
--   0092  `paper_versions` 的不可变守卫（guard_paper_version_immutable）
--   0093  `paper_approvals` 的不可变守卫（← 本文件）
--
-- 实测（2026-10-09）：0091+0092 之后删一份考过的卷子，报
--   「已决审批记录不可修改或删除 / guard_paper_approval_immutable line 12」
-- 因为 papers → paper_approvals 的级联要带走那两行**已决**审批，而守卫拦着它。
--
-- 与题库那次是同一对守卫（见 0055 的注释：guard_version_immutable + guard_approval_immutable），
-- 解法也沿用同一套：guard_paper_version_immutable 已经有 app.allow_paper_delete 开关（0092），
-- 这里给审批守卫补上**同一个开关**——一个事务级标志，两道守卫生效，
-- 只有 delete_paper / 明确打开它的维护块会设上。
--
-- 注意开关写在"已决"判断**之前**：已决行正是要放行的那一类。

create or replace function public.guard_paper_approval_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 整份试卷被合法删除：级联要带走它的审批行（含已决的），放行
  if tg_op = 'DELETE' and current_setting('app.allow_paper_delete', true) = 'on' then
    return old;
  end if;

  if old.state in ('approved', 'returned', 'cancelled') then
    if tg_op = 'UPDATE'
       and current_setting('app.user_cleanup', true) = 'on'
       and new.assigned_user_ids <@ old.assigned_user_ids
       and (new.decided_by is null or new.decided_by = old.decided_by)
       and (to_jsonb(new) - 'assigned_user_ids' - 'decided_by')
           is not distinct from (to_jsonb(old) - 'assigned_user_ids' - 'decided_by') then
      return new;
    end if;
    raise exception '已决审批记录不可修改或删除';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
