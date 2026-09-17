-- 0048: 修正两个"删除守卫吞掉级联删除"的 bug，并清理已产生的孤儿版本。
--
-- 症状：`delete_question_draft` 只删掉了 questions 主档行，question_versions 的
-- on delete cascade 被静默吞掉——不报错、不警告，作者看到的是"删除成功"。
--
-- 根因：两个守卫函数在 DELETE 分支都走 `return new`，而 **BEFORE DELETE 触发器里
-- NEW 恒为 NULL，PostgreSQL 把"返回 NULL"解释为跳过这次删除**。级联删除正是以
-- BEFORE DELETE 触发器的形式作用在子表上的，于是被一并跳过。
-- 更隐蔽的是：PG 的级联删除不会回头复查外键，所以留下孤儿行也没有任何报错。
--
-- 2026-09-17 实测线上已有 4 行孤儿 question_versions（父题都不存在了），
-- 全部是 draft、无标签外键以外的引用，说明这条路径被真实使用过。
-- 顺带查过 approvals / version_tags / version_media / paper_* 均无同类孤儿：
-- approvals 未被波及是因为 delete_question_draft 只允许删除"从未提交过"的纯草稿，
-- 这种题根本没有审批行。

-- =====================================================================
-- 1) 版本守卫：DELETE 分支返回 OLD
-- =====================================================================
-- 除最后一段外与 0012 完全一致（supersede 事务开关、逐字段比对都不动）。
create or replace function public.guard_version_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.status in ('published', 'superseded', 'retracted') then
    if tg_op = 'UPDATE'
       and old.status = 'published' and new.status = 'superseded'
       and current_setting('app.allow_supersede', true) = 'on'
       and new.question_id is not distinct from old.question_id
       and new.version_no is not distinct from old.version_no
       and new.change_type is not distinct from old.change_type
       and new.base_version_id is not distinct from old.base_version_id
       and new.qtype is not distinct from old.qtype
       and new.difficulty is not distinct from old.difficulty
       and new.content is not distinct from old.content
       and new.search_text is not distinct from old.search_text
       and new.created_by is not distinct from old.created_by
       and new.submitted_at is not distinct from old.submitted_at
       and new.published_at is not distinct from old.published_at
       and new.created_at is not distinct from old.created_at then
      return new;
    end if;
    raise exception '该状态的版本不可直接修改';
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception '只能删除纯草稿版本';
    end if;
    -- 必须返回 OLD：返回 NULL 会静默取消这次删除（连级联删除一起吞掉）
    return old;
  end if;
  return new;
end;
$$;

-- =====================================================================
-- 2) 审批守卫：DELETE 分支返回 OLD
-- =====================================================================
-- 0003 的原版在 DELETE 分支同样返回 new。它尚未造成孤儿（纯草稿题没有审批行，
-- 而审批行本身从不删除，只置 cancelled），但同一个坑留着迟早会踩——比如将来
-- 允许删除已撤回的题目时。
create or replace function public.guard_approval_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.state in ('approved', 'returned', 'cancelled') then
    raise exception '已决审批记录不可修改或删除';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- =====================================================================
-- 3) 一次性清理已产生的孤儿版本
-- =====================================================================
-- 守卫修好之后这条 delete 才能真正生效（在此之前它会被静默跳过）。
-- 非 draft 的孤儿会让守卫 raise 从而整个迁移失败——这是刻意的：
-- 那种情况需要人工判断，不该被静默跳过。本次 4 行全是 draft。
do $$
declare
  v_n int;
begin
  delete from question_versions v
  where not exists (select 1 from questions q where q.id = v.question_id);
  get diagnostics v_n = row_count;
  raise notice '已清理孤儿 question_versions: % 行', v_n;
end;
$$;

-- 版本没了，引用了它的 version_tags / version_media 随外键级联清掉；
-- 因此不再被引用的 media_objects 由管理员在「媒体回收」里统一 GC（这里不越权删对象存储）。
