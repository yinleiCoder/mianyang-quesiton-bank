-- 0094b：给源码表补一个"内置模板"的位置
--
-- 0094 把 teaching_animation_sources.source 定成了 NOT NULL —— 那是按"AI 写的源码"设的。
-- 但最小闭环（M2）走的是**内置模板**：教师从 remotion/animations/ 里挑一个、填参数，
-- 没有源码文本可言。所以：
--   · source 放开为可空（AI 那条路仍然写它）；
--   · 增加 template_id，指向 remotion/animations/index.js 里登记的 id。
-- 两者必须有且只有一个 —— 用一条 CHECK 钉住，免得将来出现"既没模板又没源码"的空行。
--
-- M4（AI 创作环）落地时不需要再改这里：那时 template_id 为空、source 有值。

alter table public.teaching_animation_sources
  alter column source drop not null;

alter table public.teaching_animation_sources
  add column if not exists template_id text;

-- 原来那条长度约束是给非空 source 用的，现在要容忍 NULL
alter table public.teaching_animation_sources
  drop constraint if exists teaching_animation_sources_len;
alter table public.teaching_animation_sources
  add constraint teaching_animation_sources_len
  check (source is null or char_length(source) between 1 and 20000);

alter table public.teaching_animation_sources
  drop constraint if exists teaching_animation_sources_origin_check;
alter table public.teaching_animation_sources
  add constraint teaching_animation_sources_origin_check
  check ((source is null) <> (template_id is null));

comment on column public.teaching_animation_sources.template_id is
  '内置模板 id（remotion/animations/index.js 里登记的）。与 source 二选一：模板产的没有源码文本。';

-- create_teaching_animation 跟着放开：允许只给 template_id
create or replace function public.create_teaching_animation(
  p_title text,
  p_description text,
  p_course_node_id uuid,
  p_source text default null,
  p_fps integer default 30,
  p_width integer default 1920,
  p_height integer default 1080,
  p_duration_in_frames integer default 0,
  p_input_props jsonb default '{}'::jsonb,
  p_template_id text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_id uuid;
  v_school uuid;
  v_title text := btrim(coalesce(p_title, ''));
begin
  if not public.is_teacher() then
    raise exception '只有教师可以创建教学动画' using errcode = '42501';
  end if;

  if char_length(v_title) < 1 or char_length(v_title) > 120 then
    raise exception '标题需在 1~120 字之间';
  end if;
  if p_course_node_id is null then
    raise exception '请选择所属学科';
  end if;
  if (p_source is null) = (p_template_id is null) then
    raise exception '要么给源码、要么给内置模板 id，二选一';
  end if;

  select school_id into v_school from profiles where user_id = v_uid;

  insert into teaching_animations (
    title, description, course_node_id, creator_id, school_id,
    fps, width, height, duration_in_frames)
  values (
    v_title, nullif(btrim(coalesce(p_description, '')), ''), p_course_node_id, v_uid, v_school,
    coalesce(p_fps, 30), coalesce(p_width, 1920), coalesce(p_height, 1080),
    greatest(coalesce(p_duration_in_frames, 0), 0))
  returning id into v_id;

  insert into teaching_animation_sources (animation_id, source, template_id, input_props)
  values (v_id, p_source, p_template_id, coalesce(p_input_props, '{}'::jsonb));

  perform public.audit('create_teaching_animation', null, null,
    jsonb_build_object('animation_id', v_id, 'title', v_title,
                       'template_id', p_template_id));

  return v_id;
end;
$$;

-- 新的入参表变了（多了 p_template_id），签名收口照重来一遍
revoke all on function public.create_teaching_animation(text, text, uuid, text, integer, integer, integer, integer, jsonb, text) from public, anon;
grant execute on function public.create_teaching_animation(text, text, uuid, text, integer, integer, integer, integer, jsonb, text) to authenticated;

-- 旧签名（9 参）已无人调用，但 PostgREST 会把它当成一个重载 → 歧义。
-- 保留会造成"两个都能匹配"的报错，所以显式删掉。
drop function if exists public.create_teaching_animation(text, text, uuid, text, integer, integer, integer, integer, jsonb);

notify pgrst, 'reload schema';
