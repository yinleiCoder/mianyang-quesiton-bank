-- 0134: 逐题错因诊断的缓存（P0-4 最后一项）
--
-- 沿用 class_ai_reports 的指纹模式：
--   · 一条记录 = 一个「卷面版本 + 班级」，content 里存 { diagnosis, questions }；
--   · 读取时用当前 _class_ai_data 的 payload 重算指纹，和存下来的不一致就标 stale；
--   · 保存时再由服务端重算一次，生成期间有人交卷/判分就抛 40001，不覆盖新数据。
-- diagnosis 是校验后的模型输出，questions 是生成时用的题目快照（题干/选项/样本），
-- 只用于回显，不含学生姓名。
--
-- 权限：表启用 RLS 且不建策略，authenticated 无表权限；读写只走两个 definer RPC，
-- RPC 内部用 can_view_class（与班级 AI 报告同一条门禁）。

create table if not exists public.class_error_diagnoses (
  id uuid primary key default gen_random_uuid(),
  paper_id uuid not null references public.papers(id) on delete cascade,
  paper_version_id uuid not null references public.paper_versions(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  fingerprint text not null,
  content jsonb not null,
  model text,
  created_by uuid references public.profiles(user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (paper_version_id, class_id)
);

alter table public.class_error_diagnoses enable row level security;
revoke all on table public.class_error_diagnoses from public, anon, authenticated;

comment on table public.class_error_diagnoses is
  '逐题错因诊断缓存；一条记录对应一个卷面版本 + 班级，content={diagnosis,questions}；definer-only。';

create or replace function public.class_error_diagnosis(p_paper_id uuid, p_class_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_data jsonb;
  v_fp text;
  v_row public.class_error_diagnoses%rowtype;
  v_has boolean;
  v_author text;
begin
  if not public.can_view_class(p_class_id) then
    raise exception '你不能查看这个班级的错因诊断' using errcode = '42501';
  end if;

  v_data := public._class_ai_data(p_paper_id, p_class_id);
  v_fp := md5((v_data -> 'payload')::text);

  select * into v_row
  from public.class_error_diagnoses
  where paper_version_id = (v_data -> 'paper' ->> 'version_id')::uuid
    and class_id = p_class_id;
  v_has := found;
  if v_has then
    select name into v_author from public.profiles where user_id = v_row.created_by;
  end if;

  return jsonb_build_object(
    'paper', v_data -> 'paper',
    'class', v_data -> 'class',
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
  v_data jsonb;
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

  v_data := public._class_ai_data(p_paper_id, p_class_id);
  v_fp := md5((v_data -> 'payload')::text);
  if p_fingerprint is distinct from v_fp then
    raise exception '成绩数据已经变了，请重新诊断' using errcode = '40001';
  end if;

  insert into public.class_error_diagnoses
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

  perform public.audit('save_class_error_diagnosis', null, null,
    jsonb_build_object('paper_id', p_paper_id, 'class_id', p_class_id,
                       'model', p_model, 'diagnosis_id', v_id));
  return v_id;
end;
$$;

comment on function public.class_error_diagnosis(uuid, uuid) is
  '读取班级逐题错因诊断；返回当前指纹与 stale 标记；无缓存时 content=null。';
comment on function public.save_class_error_diagnosis(uuid, uuid, text, jsonb, text) is
  '保存班级逐题错因诊断；指纹不一致（生成期间数据变化）抛 40001。';

revoke execute on function public.class_error_diagnosis(uuid, uuid) from public, anon;
grant execute on function public.class_error_diagnosis(uuid, uuid) to authenticated;
revoke execute on function public.save_class_error_diagnosis(uuid, uuid, text, jsonb, text) from public, anon;
grant execute on function public.save_class_error_diagnosis(uuid, uuid, text, jsonb, text) to authenticated;

notify pgrst, 'reload schema';
