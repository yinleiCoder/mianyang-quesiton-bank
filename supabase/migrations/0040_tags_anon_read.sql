-- 0040: tags 对 anon 开放只读（照 0007 给 schools、0039 给 subject_nodes 的先例）。
-- 原因：题库筛选条（/bank）与出题页的「标签字典」与调用者身份无关，是全市共享的公共词表，
-- 不含个人信息 —— 正是可以进 Data Cache 的那类数据。不放开的话，缓存函数不能读 cookies()，
-- 而带会话的客户端必然读 cookies，这份字典就只能每次都走一次 170–460ms 的 Supabase 往返。
-- 只给 (id, name) 的**列级** select —— created_by / created_at 不暴露；
-- 写权限一概不加（建/改名/合并/删除仍走管理员 RPC）。

grant select (id, name) on public.tags to anon;

drop policy if exists select_anon_tags on public.tags;
create policy select_anon_tags on public.tags for select to anon using (true);
