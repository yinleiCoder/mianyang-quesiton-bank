-- 0075: 题目可以挂在科目树的**任意层级**（公共学科、专业大类、专业、课程）。
--
-- 口径变更（用户 2026-09-24）：0060 定的是「题只挂末端（公共学科/课程），卷子可挂任意层级」。
-- 实际使用中「计算机类」这种按专业大类组织的题库真实存在——题就该能挂在大类本身，
-- 不该被逼着先建一门不存在的课程。于是把出题侧的节点规则放宽到与组卷侧一致。
--
-- 出题/导入与组卷各自收口在一个函数里：
--   · create_question_draft（0004）与 import_create_job（0035）→ check_can_author
--   · create_paper_draft → check_can_author_paper（0060，本来就不查 kind）
-- 所以只改 check_can_author：去掉「节点可挂题」那一段。
--
-- can_attach_question 随之删除——放宽后它恒为 true，留着只会让后来者以为这里真有一道闸
-- （线上核对过：只有 check_can_author 引用它，没有任何 RLS 策略引用）。
-- 前端同名口径仍在 lib/subject-nodes.js 的 isAttachable：那是四个 kind 的白名单，
-- 将来真加了新 kind 时前端会先拦住，不会静默放行。
--
-- 0060 的注释写着「check_can_author 一个字不动」——那条已被本次变更取代，别再照它改回去。
-- 冻结节点照旧不能挂新题：is_frozen 断言原样保留。

create or replace function public.check_can_author(p_course_node uuid)
returns uuid  -- 返回作者的 school_id
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_school uuid;
  v_frozen boolean;
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
  select school_id into v_school from profiles where user_id = v_uid;
  if v_school is null then
    raise exception '你的账号未绑定学校，无法出题';
  end if;
  select is_frozen into v_frozen from subject_nodes where id = p_course_node;
  if not found then
    raise exception '科目节点不存在';
  end if;
  if v_frozen then
    raise exception '该科目节点已冻结，暂不能提交新题';
  end if;
  return v_school;
end;
$$;

drop function if exists public.can_attach_question(subject_nodes);

notify pgrst, 'reload schema';
