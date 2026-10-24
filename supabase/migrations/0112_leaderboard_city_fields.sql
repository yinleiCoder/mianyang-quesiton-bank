-- 0112: 排行榜返回「市区」字段（全校 / 全市 / 全省三档都要能看出学生在哪个市）
--
-- 用户口径（2026-10-24）：成绩排行在全校/全市/全省档下要补「班级」（原本已有
-- class_name，前端只是没显示）与「市区」字段；全省榜尤其需要市区来区分学校归属。
--
-- 做法：不重抄 11KB 的 paper_leaderboard，而是「读线上定义 + 定点替换 + 逐一校验」
-- （与 0067 同一套写法）。任何一处没替换成功就整体失败，不会留下半成品。
--
-- 返回体只多两个键：rows/nearby/viewer 里的 city_id / city_name。
-- 泄漏面不变：仍然只有"谁多少分、在哪个学校/班/市"，没有任何作答内容。

do $$
declare
  v_def text;
  v_new text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace and p.proname = 'paper_leaderboard';

  if v_def is null then
    raise exception '找不到 paper_leaderboard';
  end if;

  -- 1) ranked CTE：把学校的市名一起带出来
  v_new := replace(
    v_def,
    E'             c.name as class_name, s.name as school_name, s.city_id,\n',
    E'             c.name as class_name, s.name as school_name, s.city_id, ci.name as city_name,\n');
  if v_new = v_def then
    raise exception 'paper_leaderboard 的 ranked 字段与预期不符（city_name 未插入）';
  end if;
  v_def := v_new;

  -- 2) ranked 的来源表补 cities 关联
  v_new := replace(
    v_def,
    E'      left join schools s on s.id = p.school_id\n      where a.paper_version_id = v_ver.id',
    E'      left join schools s on s.id = p.school_id\n      left join cities ci on ci.id = s.city_id\n      where a.paper_version_id = v_ver.id');
  if v_new = v_def then
    raise exception 'paper_leaderboard 的 ranked 连接与预期不符（cities join 未插入）';
  end if;
  v_def := v_new;

  -- 3) rows / nearby / viewer：三处共用同一行字段模式，一次全部补上
  --    （viewer 也带 city_name 不会有害，客户端不用即可）
  v_new := replace(
    v_def,
    E'                 ''class_id'', sc.class_id, ''class_name'', sc.class_name,\n',
    E'                 ''class_id'', sc.class_id, ''class_name'', sc.class_name,\n'
    || E'                 ''city_id'', sc.city_id, ''city_name'', sc.city_name,\n');
  if v_new = v_def then
    raise exception 'paper_leaderboard 的行字段与预期不符（city_id/city_name 未插入）';
  end if;

  execute v_new;
end $$;

notify pgrst, 'reload schema';
