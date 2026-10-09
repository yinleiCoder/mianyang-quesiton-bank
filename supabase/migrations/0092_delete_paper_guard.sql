-- 0092：让"删整份试卷"能穿过不可变守卫
--
-- 0091 放宽了 delete_paper 的**判据**，但真正拦人的还有一层：`paper_versions` 上的
-- BEFORE DELETE 守卫 `guard_paper_version_immutable`。它保护的是"已发布版本的**内容**"——
-- 连改一道题都要走改版流程（这是对的：学生考过的卷面不能变）。而删整份试卷时，
-- 外键级联会删掉它的版本行，于是撞上守卫，报「该状态的试卷版本不可直接修改」。
--
-- 实测（2026-10-08）：判据放宽后点删除，界面弹的就是这句话。
--
-- 解法沿用**这道守卫自己的既有写法**——它已经有两条"合法穿透"开关
-- （app.allow_paper_supersede、app.user_cleanup），加第三条比另起一套机制更不容易跑偏：
--   · 开关是**事务级**的（set_config(..., true)），只在 delete_paper 那一个事务里有效；
--   · 只有 delete_paper 会打开它，而 delete_paper 自己是 SECURITY DEFINER + 三条断言
--     （是作者/管理员、没人考过、没有在审任务）。

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

-- delete_paper 补上"开开关"这一步（其余一字不动，规则仍只有那一份）
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

  -- 事务级开关：只影响这一次删除，出事务即失效（见上面守卫里的说明）
  perform set_config('app.allow_paper_delete', 'on', true);
  delete from papers where id = p_paper_id;
end;
$$;
