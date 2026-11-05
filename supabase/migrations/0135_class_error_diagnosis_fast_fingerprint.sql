-- 0135: 错因诊断缓存改用廉价指纹（0134 的性能修正）
--
-- 0134 用 md5(_class_ai_data(...)->'payload') 当指纹。实测这个 payload 要 3–8 秒：
--   · 页面加载多花一次 6 秒；
--   · 保存时再算一次，且「指纹不一致」的报错路径经 api.myquiz.cn 代理会挂到 120 秒
--     （现有 save_class_ai_report 的同一路径也一样，属于既有问题）。
--
-- 诊断真正依赖的是：卷面版本、班级人数、本班官方考试的作答/判分情况。题干与选项
-- 在同一版本内不变，所以用这些聚合值做指纹就够了（实测 75ms）：
--   · paper_version_id
--   · 班级可见学生数
--   · 官方考试 attempts 数 / graded 数 / max(submitted_at)
--   · 已判分作答数 / 正确数（重新判分会改变它）
--
-- 读取与保存都用同一个 _class_error_fingerprint；客户端保存时用读取返回的 fingerprint
-- （不再用 class_ai_payload 的 payload 指纹）。其余逻辑与 0134 一致。

create or replace function public._class_error_fingerprint(p_paper_id uuid, p_class_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_ver uuid;
  v_students int := 0;
  v_attempts int := 0;
  v_graded int := 0;
  v_last timestamptz;
  v_answers int := 0;
  v_correct int := 0;
begin
  select current_published_version_id into v_ver from public.papers where id = p_paper_id;
  if v_ver is null then
    raise exception '这份试卷还没有入库的版本，没有可分析的成绩';
  end if;

  select count(*)::int into v_students
  from public.profiles p
  where p.class_id = p_class_id and public.can_view_student(p.user_id);

  select count(*)::int,
         count(*) filter (where a.status = 'graded')::int,
         max(a.submitted_at)
    into v_attempts, v_graded, v_last
  from public.exam_attempts a
  join public.profiles p on p.user_id = a.user_id
  where a.paper_id = p_paper_id
    and a.paper_version_id = v_ver
    and p.class_id = p_class_id
    and public.can_view_student(p.user_id)
    and a.is_official
    and a.status in ('submitted', 'grading', 'graded');

  select count(*)::int,
         count(*) filter (where aa.is_correct)::int
    into v_answers, v_correct
  from public.exam_answers aa
  join public.exam_attempts a on a.id = aa.attempt_id
  join public.profiles p on p.user_id = a.user_id
  where a.paper_id = p_paper_id
    and a.paper_version_id = v_ver
    and p.class_id = p_class_id
    and public.can_view_student(p.user_id)
    and a.is_official
    and a.status = 'graded';

  return md5(
    v_ver::text || ':' || v_students || ':' || v_attempts || ':' || v_graded || ':' ||
    coalesce(v_last::text, '') || ':' || v_answers || ':' || v_correct);
end;
$$;

create or replace function public.class_error_diagnosis(p_paper_id uuid, p_class_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_ver uuid;
  v_fp text;
  v_row public.class_error_diagnoses%rowtype;
  v_has boolean;
  v_author text;
begin
  if not public.can_view_class(p_class_id) then
    raise exception '你不能查看这个班级的错因诊断' using errcode = '42501';
  end if;

  select current_published_version_id into v_ver from public.papers where id = p_paper_id;
  if v_ver is null then
    raise exception '这份试卷还没有入库的版本，没有可分析的成绩';
  end if;
  v_fp := public._class_error_fingerprint(p_paper_id, p_class_id);

  select * into v_row
  from public.class_error_diagnoses
  where paper_version_id = v_ver and class_id = p_class_id;
  v_has := found;
  if v_has then
    select name into v_author from public.profiles where user_id = v_row.created_by;
  end if;

  return jsonb_build_object(
    'fingerprint', v_fp,
    'content', case when not v_has then null else v_row.content end,
    'model', case when v_has then v_row.model else null end,
    'created_at', case when v_has then v_row.created_at else null end,
    'created_by_name', v_author,
    'author_left', v_has and v_row.created_by is not null and v_author is null,
    'stale', v_has and v_row.fingerprint <> v_fp);
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
    raise exception '成绩数据已经变了，请重新诊断' using errcode = '40001';
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

comment on function public._class_error_fingerprint(uuid, uuid) is
  '错因诊断缓存的廉价指纹：卷面版本 + 班级人数 + 考试 attempts/answers 聚合；约 75ms。';
comment on function public.class_error_diagnosis(uuid, uuid) is
  '读取班级逐题错因诊断；返回当前指纹与 stale 标记；无缓存时 content=null。';
comment on function public.save_class_error_diagnosis(uuid, uuid, text, jsonb, text) is
  '保存班级逐题错因诊断；指纹不一致（生成期间数据变化）抛 40001。';

revoke execute on function public._class_error_fingerprint(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.class_error_diagnosis(uuid, uuid) from public, anon;
grant execute on function public.class_error_diagnosis(uuid, uuid) to authenticated;
revoke execute on function public.save_class_error_diagnosis(uuid, uuid, text, jsonb, text) from public, anon;
grant execute on function public.save_class_error_diagnosis(uuid, uuid, text, jsonb, text) to authenticated;

notify pgrst, 'reload schema';
