-- 0097：教学动画整个功能撤掉了（2026-10-09 用户决定）—— 把 0094/0094b 建的东西全部拆掉
--
-- 背景：这个功能前后两版都撤了（先是"站内用 Remotion 制作"，改成"上传视频"之后，
-- 用户又决定整条不要）。代码侧已经删干净，这一份把库里也清掉 ——
-- 留着空表比删掉更糟：下一个人看 schema 会以为这里还有个能用的功能。
--
-- ⚠ **不可逆**。执行前库里有 5 条动画记录、共 2.84MB（4 条有视频、1 条只有行没文件）。
--
-- ⚠ **对象存储不归这里管**：数据库删不了 OSS 上的文件。执行完这 7 个对象会变成孤儿
--（不占数据库、不报错、学生也看不到，因为没有任何行指向它们）。要一并清掉得单独跑一次
-- OSS 删除，key 是：
--   animations/2026/10/2edac95a-42a8-462e-bb0d-928db3f50cf3.mp4
--   animations/2026/10/5dba3596-f66a-4828-aeb5-6073632cf323.mp4
--   animations/2026/10/c8fa5b60-1e0e-43ff-96dc-9c2bde456240.png
--   animations/2026/10/8f526c83-66af-4d99-b4ff-6a760ddfaf9d.mp4
--   animations/2026/10/8103471d-9b4e-48c2-91c1-eaf8af2d4809.png
--   animations/2026/10/16c89794-79f4-405e-bb2a-163936856144.mp4
--   animations/2026/10/87fd9d2e-591e-45c1-a556-49452700db0e.png

do $$
declare
  v_rows integer;
  v_bytes bigint;
begin
  select count(*), coalesce(sum(size), 0) into v_rows, v_bytes from public.teaching_animations;
  raise notice '即将删除 teaching_animations 的 % 条记录（% MB）', v_rows, round(v_bytes / 1024.0 / 1024.0, 2);
end $$;

-- ---------------------------------------------------------------------
-- 1) 先删函数
-- ---------------------------------------------------------------------
-- **顺序不能反**：PL/pgSQL 的函数体不参与依赖跟踪，`drop table` 不会带走引用它的函数 ——
-- 反过来做会留下一堆"指向已删表的僵尸函数"，调用时报 42P01 而不是 42883，很难认。
-- 这里一个 cascade 都不加：真还有别的东西依赖它们，就让迁移当场失败，
-- 而不是静默把依赖一起带走。
drop function if exists public.update_teaching_animation_source(uuid, text, integer, jsonb);
drop function if exists public.save_teaching_animation_render(uuid, text, text, text, bigint, text, integer);
drop function if exists public.set_teaching_animation_published(uuid, boolean);
drop function if exists public.delete_teaching_animation(uuid);
drop function if exists public.create_teaching_animation(text, text, uuid, text, integer, integer, integer, integer, jsonb, text);
drop function if exists public.is_school_admin_of_animation(uuid);

-- ---------------------------------------------------------------------
-- 2) 再删表（策略、索引、主键、外键、以及挂在表上的 touch 触发器都随表走）
-- ---------------------------------------------------------------------
-- 表上那两个触发器用的是公共的 touch_updated_at()，**不要动那个函数**，别的表还在用。
drop table if exists public.teaching_animation_sources;
drop table if exists public.teaching_animations;

-- 后置断言：确认真的没了（少写一个 drop 时会在这里报出来，而不是等下次有人查 schema）
do $$
declare
  v_left integer;
begin
  select count(*) into v_left
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname like '%teaching_animation%';
  if v_left > 0 then
    raise exception '还有 % 个 teaching_animation* 对象没删掉', v_left;
  end if;
end $$;

notify pgrst, 'reload schema';
