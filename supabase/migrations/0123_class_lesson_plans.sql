-- 0123: AI 讲评教案（卷面 + 班唯一）。
--
-- 教案是**从已存的 AI 班级报告**加工出来的课堂产物，所以指纹要同时绑定两件事：
--   · 当前 _class_ai_data 的 payload 指纹；
--   · class_ai_reports 那份报告的指纹。
-- 只绑报告、不绑数据，会在"报告已过期"时把旧教案当成新学情的结论；只绑数据、不绑报告，
-- 则重新生成报告后教案不会提示过期。两者都绑，任何一边变了都 stale。
--
-- 表只给 definer 函数用（与 class_ai_reports 同一套权限论证），不建 RLS 策略。
create table public.class_ai_lesson_plans (
  id uuid primary key default gen_random_uuid(),
  paper_id uuid not null references public.papers(id) on delete cascade,
  paper_version_id uuid not null references public.paper_versions(id) on delete cascade,
  class_id uuid not null references public.classes(id) on delete cascade,
  fingerprint text not null,
  content jsonb not null,
  model text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (paper_version_id, class_id)
);

comment on table public.class_ai_lesson_plans is
  'AI 讲评教案的缓存：按「卷面 + 班」唯一；指纹同时绑定当前 payload 与已存报告的指纹；只经 definer RPC 读写';

create trigger trg_class_ai_lesson_plans_touch before update on public.class_ai_lesson_plans
  for each row execute function public.touch_updated_at();

alter table public.class_ai_lesson_plans enable row level security;
revoke all on public.class_ai_lesson_plans from public, anon, authenticated;

-- 内部：当前教案指纹（data payload + 已存报告指纹）。raw report fingerprint 也一起返回，
-- 页面据此判断"报告还没有生成"。
create or replace function public._class_lesson_plan_fp(p_paper_id uuid, p_class_id uuid)
returns table (version_id uuid, report_fingerprint text, fingerprint text)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_data jsonb;
  v_ver uuid;
  v_report_fp text;
begin
  v_data := public._class_ai_data(p_paper_id, p_class_id);
  v_ver := (v_data -> 'paper' ->> 'version_id')::uuid;
  select r.fingerprint into v_report_fp
  from public.class_ai_reports r
  where r.paper_version_id = v_ver and r.class_id = p_class_id;
  return query select
    v_ver,
    v_report_fp,
    md5(md5((v_data -> 'payload')::text) || '|' || coalesce(v_report_fp, ''));
end;
$$;

revoke execute on function public._class_lesson_plan_fp(uuid, uuid) from public, anon, authenticated;

create or replace function public.class_lesson_plan(p_paper_id uuid, p_class_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_data jsonb;
  v_fp record;
  v_row class_ai_lesson_plans%rowtype;
  v_has boolean;
begin
  if not public.can_view_class(p_class_id) then
    raise exception '你不能查看这个班级的讲评教案' using errcode = '42501';
  end if;

  v_data := public._class_ai_data(p_paper_id, p_class_id);
  select * into v_fp from public._class_lesson_plan_fp(p_paper_id, p_class_id);
  if not found then
    raise exception '这份试卷还没有可用的班级数据';
  end if;

  select * into v_row
  from public.class_ai_lesson_plans
  where paper_version_id = v_fp.version_id and class_id = p_class_id;
  v_has := found;

  return jsonb_build_object(
    'paper', v_data -> 'paper',
    'class', v_data -> 'class',
    'summary', v_data -> 'summary',
    'fingerprint', v_fp.fingerprint,
    'report_fingerprint', v_fp.report_fingerprint,
    'report_missing', v_fp.report_fingerprint is null,
    'stale', v_has and v_row.fingerprint <> v_fp.fingerprint,
    'plan', case when v_has then v_row.content else null end,
    'model', case when v_has then v_row.model else null end,
    'updated_at', case when v_has then v_row.updated_at else null end
  );
end;
$$;

revoke execute on function public.class_lesson_plan(uuid, uuid) from public, anon;
grant execute on function public.class_lesson_plan(uuid, uuid) to authenticated;

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
    raise exception '成绩数据已经变了，请重新生成教案' using errcode = '40001';
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

revoke execute on function public.save_class_lesson_plan(uuid, uuid, text, jsonb, text) from public, anon;
grant execute on function public.save_class_lesson_plan(uuid, uuid, text, jsonb, text) to authenticated;

notify pgrst, 'reload schema';
