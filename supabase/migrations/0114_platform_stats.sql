-- 0114: 平台规模计数（学校 / 学生 / 教师 / 市区）
--
-- 用户 2026-10-24：网页端工作台与 Flutter 首页都要显示当前系统的
-- 学校数量、学生数量、老师数量、市区数量（四川全省共享）。
--
-- 为什么走 SECURITY DEFINER RPC 而不是客户端直接 count：
--   profiles 的 SELECT 策略按"本人 / 同校"收口，学生直接 count 只能数到自己学校，
--   而这里的口径是**全省共享**的全局数字。RPC 只返回四个整数，不泄露任何个人行。
--
-- 口径：
--   · schools  = 全部学校（含停用；平台规模看的是"注册了多少所"）
--   · students = profiles.identity = 'student'
--   · teachers = profiles.identity = 'teacher'（待审核教师不算）
--   · cities   = cities 表的市数

create or replace function public.platform_stats()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'schools',  (select count(*) from public.schools),
    'students', (select count(*) from public.profiles where identity = 'student'),
    'teachers', (select count(*) from public.profiles where identity = 'teacher'),
    'cities',   (select count(*) from public.cities));
$$;

comment on function public.platform_stats() is
  '平台规模：学校/学生/教师/市区数量。全局口径，所有登录用户可见，只返回四个整数。';

revoke execute on function public.platform_stats() from public, anon;
grant execute on function public.platform_stats() to authenticated;

notify pgrst, 'reload schema';
