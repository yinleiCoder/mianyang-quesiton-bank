-- 0111: 错题本支持排序 + 搜索
--
-- 用户口径（2026-10-24）：错题本要用 DataTable 展示，能按「最近练习时间」或
-- 「累计错误次数」排序，并且能搜索错题。
--
-- 为什么新建 v2 而不是给旧函数加参数：
--   PostgreSQL 按 (名字, 入参类型) 认函数。给 list_my_wrong_questions 加参数
--   会留下两个重载，PostgREST 解析 RPC 时会因歧义直接报 PGRST203。
--   删旧版要 drop function，迁移工具对 drop 有额外拦截；新建 v2 最省事也最安全。
--
-- 排序键（白名单，未知值回落 recent）：
--   recent_desc（默认，最近答错在前）
--   recent_asc （最久没练在前）
--   wrong_desc （累计错误次数多在前）
--   wrong_asc  （累计错误次数少在前）
--
-- 搜索匹配 question_versions.search_text（题干 + 选项等检索文本），大小写不敏感，
-- 并转义 %/_/\，否则搜「100%」会变成通配符（与 0069 practice_candidates 同一条规矩）。

create or replace function public.list_my_wrong_questions_v2(
  p_limit int default 20,
  p_offset int default 0,
  p_sort text default 'recent',
  p_keyword text default null)
returns table(
  question_id uuid,
  version_id uuid,
  qtype text,
  difficulty smallint,
  answered_at timestamptz,
  wrong_count bigint,
  stem_text text,
  available boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_sort text := case
    when p_sort in ('recent_asc', 'wrong_desc', 'wrong_asc') then p_sort
    else 'recent_desc'
  end;
  v_kw text := nullif(btrim(coalesce(p_keyword, '')), '');
begin
  if v_kw is not null then
    -- 先转义反斜杠，再转义 LIKE 的两个元字符
    v_kw := replace(replace(replace(v_kw, '\', '\\'), '%', '\%'), '_', '\_');
  end if;

  return query
  with latest as (
    select distinct on (a.question_id)
           a.question_id, a.version_id, a.is_correct, a.answered_at
    from practice_answers a
    where a.user_id = v_uid
    order by a.question_id, a.answered_at desc
  ),
  wrong_rows as (
    select l.question_id,
           coalesce(cv.id, l.version_id) as version_id,
           coalesce(cv.qtype, lv.qtype) as qtype,
           coalesce(cv.difficulty, lv.difficulty) as difficulty,
           l.answered_at,
           (select count(*) from practice_answers a
             where a.user_id = v_uid
               and a.question_id = l.question_id
               and a.is_correct is not true) as wrong_count,
           case when cv.id is not null
                then left(coalesce(cv.search_text, ''), 120) end as stem_text,
           (cv.id is not null) as available,
           coalesce(cv.search_text, lv.search_text) as search_blob
    from latest l
    join question_versions lv on lv.id = l.version_id
    left join questions q on q.id = l.question_id
      and q.state = 'live' and q.current_published_version_id is not null
    left join question_versions cv
      on cv.id = q.current_published_version_id and cv.status = 'published'
    where l.is_correct is not true
  )
  select r.question_id, r.version_id, r.qtype, r.difficulty,
         r.answered_at, r.wrong_count, r.stem_text, r.available
  from wrong_rows r
  where v_kw is null or r.search_blob ilike '%' || v_kw || '%'
  order by
    case when v_sort = 'wrong_asc' then r.wrong_count end asc nulls last,
    case when v_sort = 'wrong_desc' then r.wrong_count end desc nulls last,
    case when v_sort = 'recent_asc' then r.answered_at end asc nulls last,
    r.answered_at desc
  limit greatest(coalesce(p_limit, 20), 1)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

comment on function public.list_my_wrong_questions_v2(int, int, text, text) is
  '错题本（可排序、可搜索）：sort = recent_desc/recent_asc/wrong_desc/wrong_asc，keyword 匹配检索文本。';

revoke execute on function public.list_my_wrong_questions_v2(int, int, text, text) from public, anon;
grant execute on function public.list_my_wrong_questions_v2(int, int, text, text) to authenticated;

notify pgrst, 'reload schema';
