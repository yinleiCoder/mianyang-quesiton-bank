-- 0099: 练习抽题改成「按比例混合复习」（用户 2026-10-13 拍板选 B）
--
-- 起因：首页的遗忘曲线**永远画不出来**。查下来不是曲线算法的问题，是**抽题顺序**：
-- 候选池分四层（0 新题 / 1 到期该复习 / 2 今天之前练过 / 3 今天练过），而
-- `order by c0.tier` 让**新题永远先发**。题库里还有上千道没练过的题，于是
-- 「到期复习」永远轮不上——线上实测某账号 105 次作答里只有 4 次是"隔天重练同一道题"，
-- 而曲线要求「≥2 个间隔档、每档 ≥3 次」，自然永远达不到。
--
-- 参照物是墨墨背单词：它第二天就有曲线，因为它的机制**就是**第二天把昨天背过的词
-- 再推给你——曲线是被机制喂出来的，不是自然攒出来的。我们原来的优先级恰好相反。
--
-- 改法：**每次练习留 30% 名额给"到期该复习的"**（至少 1 道），其余给新题；
-- 到期不够时新题自动补满，新题不够时补位层兜底。卷面顺序（按题型分块）没动。
--
-- 实现照 0067 的先例：取线上定义做定点字符串替换，**匹配不到就 raise**，绝不静默漏改。
-- 注意线上签名带 smallint[]（0098 的难度多选），别照 0069 的旧签名写。
do $do$
declare
  v_def text;
  v_old text := $old$    select * from public.practice_candidates(v_uid, p_source, p_node_id, p_qtypes,
                                            v_difficulties, p_tag_id, v_kw, p_question_ids) c0
    where p_allow_same_day or not c0.today_done
    order by c0.tier,                                       -- 新题 → 到期 → 补位 → （加练）
             -- 到期层：逾期越久越靠前
             case when c0.tier = 1 then c0.due_at end asc,
             -- 补位层 / 加练层：最久没练的靠前
             case when c0.tier >= 2 then c0.last_at end asc,
             random()
    limit p_limit
$old$;
  v_new text := $new$    select * from (
      -- 先按层各自编号（到期层按"逾期最久"、补位层按"最久没练"），
      -- 再按配额挑：这样"给复习留的名额"才落得到最该复习的那几道上。
      select q0.*,
             row_number() over (
               partition by q0.tier
               order by case when q0.tier = 1 then q0.due_at end asc,
                        case when q0.tier >= 2 then q0.last_at end asc,
                        random()) as rn
      from public.practice_candidates(v_uid, p_source, p_node_id, p_qtypes,
                                      v_difficulties, p_tag_id, v_kw, p_question_ids) q0
      where p_allow_same_day or not q0.today_done
    ) q
    order by case
               -- 复习名额：到期题里最该复习的前 30%（至少 1 道——题量小的时候
               -- 也不至于一道都不复习）。到期的题不够，名额自然让给下面的新题。
               when q.tier = 1 and q.rn <= greatest(1, round(p_limit * 0.3)) then 0
               -- 新题补满剩下的名额（原来它是第 0 层、永远优先，见文件头）
               when q.tier = 0 then 1
               -- 到期但没抢到名额的（今天发不完的），排在新题之后
               when q.tier = 1 then 2
               -- 补位层 / 加练层
               else 3
             end,
             case when q.tier = 1 then q.due_at end asc,
             case when q.tier >= 2 then q.last_at end asc,
             random()
    limit p_limit
$new$;
begin
  select pg_get_functiondef(
    'public.start_practice_session(uuid,text[],smallint,smallint[],uuid,text,integer,text,uuid[],boolean)'::regprocedure)
    into v_def;

  if position(v_old in v_def) = 0 then
    raise exception '0099：没在线上函数里匹配到旧的抽题块（函数被别处改过？）——先 dump 线上定义再改，别硬来';
  end if;

  execute replace(v_def, v_old, v_new);
  raise notice '0099：抽题已改成 30% 复习 + 70% 新题（到期不够时新题补满）';
end
$do$;
