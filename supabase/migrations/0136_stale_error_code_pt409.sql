-- 0136: 把「成绩数据已变化」的错误码从 40001 改成 PT409
--
-- 原因（Supabase 官方文档 + 实测）：PostgREST 14 会把 SQLSTATE 40001
-- （serialization_failure）当成可重试的串行化冲突，**无限重试**整个事务；
-- 15/16 才修。表现是：RPC 明明 75ms 就 raise 了，HTTP 请求却挂到 120 秒后被网关 504，
-- 同时数据库里留下不断重跑的后端（cpu 也会被拖高）。
--
-- 受影响的三条保存路径都改成 `PT409`（PostgREST 会映射成 HTTP 409，且不重试）：
--   · save_class_ai_report（0088）
--   · save_class_lesson_plan（0123）
--   · save_class_error_diagnosis（0134/0135）
-- 客户端同步改为判断 error.code === 'PT409'。
--
-- ⚠ 其它仍用 40001 的 RPC（导入租约、试卷乐观锁）是同一个坑，但改动面更大，
--    本次不动；后续单独处理。若线上出现「保存/导入卡住 + authenticator 连接
--    不断重跑同一语句」，先查 40001。

create or replace function public.save_class_ai_report(
  p_paper_id uuid,
  p_class_id uuid,
  p_fingerprint text,
  p_content jsonb,
  p_model text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_data jsonb;
  v_fp text;
  v_id uuid;
begin
  if not public.can_view_class(p_class_id) then
    raise exception '你不能为这个班级保存 AI 分析' using errcode = '42501';
  end if;
  if p_content is null or jsonb_typeof(p_content) <> 'object' or p_content = '{}'::jsonb then
    raise exception '报告内容为空' using errcode = '22023';
  end if;

  v_data := public._class_ai_data(p_paper_id, p_class_id);
  v_fp := md5((v_data -> 'payload')::text);

  if p_fingerprint is distinct from v_fp then
    raise exception '成绩数据已经变了，请重新生成' using errcode = 'PT409';
  end if;

  insert into public.class_ai_reports
    (paper_id, paper_version_id, class_id, fingerprint, content, model, created_by)
  values
    (p_paper_id, (v_data -> 'paper' ->> 'version_id')::uuid, p_class_id, v_fp,
     p_content, nullif(btrim(coalesce(p_model, '')), ''), v_uid)
  on conflict (paper_version_id, class_id) do update
    set fingerprint = excluded.fingerprint,
        content = excluded.content,
        model = excluded.model,
        created_by = excluded.created_by,
        updated_at = now()
  returning id into v_id;

  perform public.audit('save_class_ai_report', null, null,
    jsonb_build_object('paper_id', p_paper_id, 'class_id', p_class_id,
                       'model', p_model, 'report_id', v_id));
  return v_id;
end;
$$;

create or replace function public.save_class_lesson_plan(
  p_paper_id uuid,
  p_class_id uuid,
  p_fingerprint text,
  p_content jsonb,
  p_model text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_data jsonb;
  v_fp record;
  v_id uuid;
begin
  if not public.can_view_class(p_class_id) then
    raise exception '你不能为这个班级保存讲评教案' using errcode = '42501';
  end if;
  if p_content is null or jsonb_typeof(p_content) <> 'object' or p_content = '{}'::jsonb then
    raise exception '教案内容为空' using errcode = '22023';
  end if;

  v_data := public._class_ai_data(p_paper_id, p_class_id);
  select * into v_fp from public._class_lesson_plan_fp(p_paper_id, p_class_id);
  if v_fp.report_fingerprint is null then
    raise exception '请先生成 AI 分析，再生成讲评教案' using errcode = '22023';
  end if;
  if p_fingerprint is distinct from v_fp.fingerprint then
    raise exception '成绩数据已经变了，请重新生成教案' using errcode = 'PT409';
  end if;

  insert into public.class_ai_lesson_plans
    (paper_id, paper_version_id, class_id, fingerprint, content, model, created_by)
  values
    (p_paper_id, v_fp.version_id, p_class_id, v_fp.fingerprint,
     p_content, nullif(btrim(coalesce(p_model, '')), ''), v_uid)
  on conflict (paper_version_id, class_id) do update
    set fingerprint = excluded.fingerprint,
        content = excluded.content,
        model = excluded.model,
        created_by = excluded.created_by,
        updated_at = now()
  returning id into v_id;

  perform public.audit('save_class_lesson_plan', null, null,
    jsonb_build_object('paper_id', p_paper_id, 'class_id', p_class_id,
                       'model', p_model, 'lesson_plan_id', v_id));
  return v_id;
end;
$$;

create or replace function public.save_class_error_diagnosis(
  p_paper_id uuid,
  p_class_id uuid,
  p_fingerprint text,
  p_content jsonb,
  p_model text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_ver uuid;
  v_fp text;
  v_id uuid;
begin
  if not public.can_view_class(p_class_id) then
    raise exception '你不能为这个班级保存错因诊断' using errcode = '42501';
  end if;
  if p_content is null or jsonb_typeof(p_content) <> 'object' then
    raise exception '诊断内容为空' using errcode = '22023';
  end if;
  if jsonb_typeof(p_content -> 'diagnosis') is distinct from 'object' then
    raise exception '诊断内容缺少 diagnosis' using errcode = '22023';
  end if;
  if jsonb_typeof(p_content -> 'questions') is distinct from 'array' then
    raise exception '诊断内容缺少 questions' using errcode = '22023';
  end if;

  select current_published_version_id into v_ver from public.papers where id = p_paper_id;
  if v_ver is null then
    raise exception '这份试卷还没有入库的版本，没有可分析的成绩';
  end if;
  v_fp := public._class_error_fingerprint(p_paper_id, p_class_id);
  if p_fingerprint is distinct from v_fp then
    raise exception '成绩数据已经变了，请重新诊断' using errcode = 'PT409';
  end if;

  insert into public.class_error_diagnoses
    (paper_id, paper_version_id, class_id, fingerprint, content, model, created_by)
  values
    (p_paper_id, v_ver, p_class_id, v_fp,
     p_content, nullif(btrim(coalesce(p_model, '')), ''), v_uid)
  on conflict (paper_version_id, class_id) do update
    set fingerprint = excluded.fingerprint,
        content = excluded.content,
        model = excluded.model,
        created_by = excluded.created_by,
        updated_at = now()
  returning id into v_id;

  perform public.audit('save_class_error_diagnosis', null, null,
    jsonb_build_object('paper_id', p_paper_id, 'class_id', p_class_id,
                       'model', p_model, 'diagnosis_id', v_id));
  return v_id;
end;
$$;

comment on function public.save_class_ai_report(uuid, uuid, text, jsonb, text) is
  '保存班级 AI 报告；指纹不一致抛 PT409（不要用 40001，PostgREST 14 会无限重试）。';
comment on function public.save_class_lesson_plan(uuid, uuid, text, jsonb, text) is
  '保存讲评教案；指纹不一致抛 PT409（不要用 40001，PostgREST 14 会无限重试）。';
comment on function public.save_class_error_diagnosis(uuid, uuid, text, jsonb, text) is
  '保存班级逐题错因诊断；指纹不一致抛 PT409（不要用 40001，PostgREST 14 会无限重试）。';

notify pgrst, 'reload schema';
