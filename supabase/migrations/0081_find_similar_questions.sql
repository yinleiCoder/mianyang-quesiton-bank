-- 0081: 查重接入界面 —— 修 import_find_similar 的返回，加手动录入用的查询。
--
-- 背景：查重引擎早就写好了（0035 的 import_find_similar），但**一直没人调用**
-- （那个迁移自己就标了「v1 未接 UI」）。2026-09-29 把它接到导入预览上时发现两件事，
-- 这个迁移一起处理。
--
-- ── 一、修 import_find_similar 返回的 stem ────────────────────────────────
-- 它返回的 `stem` 取的是 **import_job_items 那一侧**的题干：
--     left(public.v_blocks_text(i.content -> 'stem'), 80)     -- i = 待导入的那条
-- 而调用方要的是**比对到的已发布题**的题干 —— 前者是审核人本来就盯着看的东西，
-- 拿它当提示等于没提示。改成 v 那一侧。
-- （改之前 dump 过线上定义逐字核对，只动这一处。）
--
-- ── 二、加 find_similar_questions ────────────────────────────────────────
-- 手动录入（/questions/new）没有 import job，而 import_find_similar 的第一个参数
-- 就是 p_job_id、守卫是 is_import_job_owner，套不上。所以单开一个直接拿 content 比。
--
-- **口径必须与 import_find_similar 逐条一致**（比题干、只比已发布题、按相似度降序），
-- 否则"AI 导入时提示、手动录入时不提示"就成了两套标准，教师会不知道该信哪个。
--
-- 阈值仍用 0.55，但**客户端要分档显示**：2026-09-29 拿线上 380 道已发布题跑过全部
-- 72,010 个配对，>0.55 的只有 9 对，其中真重复只有 2 对（都是同题换了个空位写法）；
-- 其余 7 对是**同一知识点、不同侧面的辨析题**（含「行地址绝对引用」vs「列地址绝对引用」
-- 这种恰好互为反面的成对题）。在 0.55 上直接报「疑似重复」会把好题判死，
-- 所以界面分三档，低档明确写「供参考」而不是「疑似重复」。

-- ── 一 ──
create or replace function public.import_find_similar(p_job_id uuid, p_threshold real default 0.55)
returns table (item_id uuid, question_id uuid, version_id uuid, similarity real, stem text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
begin
  if not public.is_import_job_owner(p_job_id) then
    raise exception '任务不存在或无权访问';
  end if;

  return query
  select i.id, v.question_id, v.id,
         similarity(v.search_text, public.v_blocks_text(i.content -> 'stem'))::real,
         -- **命中题的题干**（不是待导入那条的）——见文件头
         left(public.v_blocks_text(v.content -> 'stem'), 80)
  from import_job_items i
  join question_versions v
    on v.status = 'published'
   and v.search_text is not null
   and similarity(v.search_text, public.v_blocks_text(i.content -> 'stem')) > p_threshold
  where i.job_id = p_job_id
  order by 4 desc
  limit 200;
end;
$$;

-- ── 二 ──
create or replace function public.find_similar_questions(
  p_content jsonb,
  p_threshold real default 0.55
)
returns table (question_id uuid, version_id uuid, similarity real, stem text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_stem text := public.v_blocks_text(p_content -> 'stem');
begin
  -- 出题辅助，不是浏览接口：按出题权限收口
  if not public.is_teacher() then
    raise exception '仅教师可查重';
  end if;

  -- 题干太短（"正确"、"以下"这种）跟谁都比得像，纯噪声。宁可什么都不返回。
  if length(v_stem) < 8 then
    return;
  end if;

  return query
  select v.question_id, v.id,
         similarity(v.search_text, v_stem)::real,
         left(public.v_blocks_text(v.content -> 'stem'), 80)
  from question_versions v
  where v.status = 'published'
    and v.search_text is not null
    and similarity(v.search_text, v_stem) > p_threshold
  order by 3 desc
  limit 20;
end;
$$;

revoke execute on function public.find_similar_questions(jsonb, real) from public, anon;
grant execute on function public.find_similar_questions(jsonb, real) to authenticated;

notify pgrst, 'reload schema';
