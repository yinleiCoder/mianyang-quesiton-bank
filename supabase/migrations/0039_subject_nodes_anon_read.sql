-- 0039: subject_nodes 对 anon 开放只读（照 0007 给 schools 的先例）。
-- 原因：学生注册时还没登录，而「专业大类 / 专业」需要从科目树的专业目录里选，
-- 不能让人手输——手输的名字与树里维护的名字对不上，后续就无法把学生与课程关联起来。
-- 为什么可以放开：科目树是公开的元数据（专业/课程的目录），不含任何个人信息，
-- 与「学校名单」同一性质；库里本来也是全校共享的浏览条件。
-- 只加 select，不加任何写权限（写仍只走管理员 RPC）。

grant select on public.subject_nodes to anon;

drop policy if exists select_anon_nodes on public.subject_nodes;
create policy select_anon_nodes on public.subject_nodes for select to anon using (true);
