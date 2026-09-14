-- 0017: 学校贡献统计（管理端 dashboard 图表数据源）。
-- 仅系统管理员可见：每所启用学校的 教师数（profiles）与 题目数（questions，含下线题）。

create or replace function public.school_contribution_stats()
returns table(school_id uuid, name text, teacher_count bigint, question_count bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可查看学校贡献统计';
  end if;
  return query
    select s.id,
           s.name,
           (select count(*) from profiles p where p.school_id = s.id) as teacher_count,
           (select count(*) from questions q where q.school_id = s.id) as question_count
    from schools s
    where s.is_active
    order by s.name;
end;
$$;

revoke execute on function public.school_contribution_stats() from public, anon;
grant execute on function public.school_contribution_stats() to authenticated;
