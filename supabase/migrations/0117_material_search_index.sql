-- 0117: 复习资料搜索补 trigram 索引
--
-- `lib/materials.js` 用 `ilike('search_text', '%kw%')` 搜资料；0070 只建了
-- 列表/学科/作者三条 B-tree，`%kw%` 用不上，数据一多就是全表扫描。
-- search_text 是生成列（lower(title + ' ' + description)），直接建 GIN trigram 即可。
--
-- pg_trgm 在 0035（查重）已经启用；这里再写 create extension 是幂等的，
-- 防止单独在空库上跑本文件。

create extension if not exists pg_trgm;

create index if not exists review_materials_search_trgm
  on public.review_materials using gin (search_text gin_trgm_ops);
