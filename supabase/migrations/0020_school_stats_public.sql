-- 0020: 学校贡献统计对所有登录用户可见（共建共享透明化，去管理员门槛）。
-- 数据仅为每所启用学校的 教师数（profiles）与 题目数（questions，含下线题）聚合，无个人级信息。
-- 仍走 SECURITY DEFINER + authenticated 收口：客户端无 DML、未登录不可读（RLS/require_uid 之外的表级策略不开放）。

create or replace function public.school_contribution_stats()
returns table(school_id uuid, name text, teacher_count bigint, question_count bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
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
