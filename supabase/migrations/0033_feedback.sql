-- 0033: 意见反馈（应用内表单 + 系统管理员收件箱）。
-- 场景：任意登录用户（学生 / 待审核教师 / 教师 / 管理员）在使用网页端或刷题客户端时
-- 遇到问题、想提建议，需要一条不依赖外部渠道的反馈通路。产品决策：
--   · 只收文本，不做附件（不触碰 OSS 直传链路）；
--   · 只做「待处理 / 已处理」两态，**没有回复流**——需要跟进时由管理员按行上的提交人
--     资料（姓名/学校/邮箱）与选填联系方式线下联系；
--   · 因此本表只对系统管理员开放读：提交人自己也不读（行里有管理员内部处理说明，
--     且本期客户端没有「我的反馈」入口，开放读只有副作用）；
--   · 客户端无 DML：提交走 submit_feedback，改状态走 admin_set_feedback_status。
-- 行上只记两个可排查的上下文——platform（两端界面差异大，是管理员第一条线索）与
-- client_version（仅移动端上报，网页端恒为最新部署传 null）；不记页面路径 / 机型 / UA，
-- 路径里带 session、题目 uuid，归一化是独立一件工程，收益不够。

create table public.feedback (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  category       text not null check (category in ('bug', 'feature', 'usage', 'other')),
  content        text not null check (char_length(content) between 5 and 2000),
  contact        text check (contact is null or char_length(contact) between 1 and 60),
  platform       text not null default 'web'
                   check (platform in ('web', 'android', 'windows', 'ios', 'other')),
  client_version text check (client_version is null or char_length(client_version) <= 32),
  status         text not null default 'open' check (status in ('open', 'resolved')),
  resolve_note   text check (resolve_note is null or char_length(resolve_note) <= 200),
  resolved_by    uuid references auth.users(id) on delete set null,
  resolved_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.feedback is '意见反馈：任意登录用户提交，系统管理员处理（open/resolved，无回复流）';
-- 与 0021「题目类外键 SET NULL」口径不同的理由：反馈是个人数据，且没有提交人的反馈
-- 无法跟进（不知道找谁核实），因此随账号删除，而不是留一条无主的行。
comment on column public.feedback.user_id is '提交人；账号注销随行删除（没有提交人的反馈无法跟进）';
comment on column public.feedback.category is '反馈类型：bug 问题反馈 / feature 功能建议 / usage 使用咨询 / other 其他';
comment on column public.feedback.content is '反馈正文（5~2000 字，入库前 trim）';
comment on column public.feedback.contact is '选填联系方式（手机号/微信/QQ），管理员线下跟进用';
comment on column public.feedback.platform is '来源平台：web 网页端 / android 安卓端 / windows 桌面端 / ios / other';
comment on column public.feedback.client_version is '客户端版本（仅移动端上报；网页端恒为 null）';
comment on column public.feedback.status is '处理状态：open 待处理 / resolved 已处理';
comment on column public.feedback.resolve_note is '管理员处理说明（内部记录，不对提交人展示）';
comment on column public.feedback.resolved_by is '处理人；重新打开时清空';
comment on column public.feedback.resolved_at is '处理时间；重新打开时清空';

create index idx_feedback_status on public.feedback (status, created_at desc);
create index idx_feedback_user_time on public.feedback (user_id, created_at desc);

create trigger trg_feedback_touch before update on public.feedback
  for each row execute function public.touch_updated_at();

-- ============ RLS + 授权：仅系统管理员可读 ============
alter table public.feedback enable row level security;
drop policy if exists select_admin on public.feedback;
create policy select_admin on public.feedback for select to authenticated
  using ((select public.is_admin()));

revoke all on public.feedback from anon, authenticated;
grant select on public.feedback to authenticated;

-- ============ 提交（任意登录用户，含学生） ============
create or replace function public.submit_feedback(
  p_category text,
  p_content text,
  p_contact text default null,
  p_platform text default 'web',
  p_client_version text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_content text := trim(coalesce(p_content, ''));
  v_contact text := nullif(trim(coalesce(p_contact, '')), '');
  v_platform text := coalesce(nullif(trim(coalesce(p_platform, '')), ''), 'web');
  v_version text := nullif(trim(coalesce(p_client_version, '')), '');
  v_recent int;
  v_today int;
  v_id uuid;
begin
  -- 不调用 is_teacher()：学生、待审核教师、教师、管理员都可以提意见
  if p_category is null or p_category not in ('bug', 'feature', 'usage', 'other') then
    raise exception '反馈类型不合法';
  end if;
  if length(v_content) < 5 then
    raise exception '请把问题描述得再具体一些（至少 5 个字）';
  end if;
  if length(v_content) > 2000 then
    raise exception '反馈内容过长（不超过 2000 字）';
  end if;
  if length(coalesce(v_contact, '')) > 60 then
    raise exception '联系方式过长（不超过 60 字）';
  end if;
  if v_platform not in ('web', 'android', 'windows', 'ios', 'other') then
    raise exception '来源平台不合法';
  end if;
  if length(coalesce(v_version, '')) > 32 then
    raise exception '客户端版本号过长（不超过 32 字）';
  end if;

  -- 轻量限流：同一账号 1 分钟内至多 1 条、每日至多 20 条（客户端只有按钮禁用，不能当约束）
  select count(*) filter (where created_at > now() - interval '1 minute'),
         count(*) filter (where created_at >= date_trunc('day', now()))
    into v_recent, v_today
  from public.feedback
  where user_id = v_uid;
  if v_recent > 0 then
    raise exception '提交太频繁了，请稍后再试';
  end if;
  if v_today >= 20 then
    raise exception '今天提交的反馈已达上限（20 条），请明天再试';
  end if;

  insert into public.feedback (user_id, category, content, contact, platform, client_version)
  values (v_uid, p_category, v_content, v_contact, v_platform, v_version)
  returning id into v_id;

  perform public.audit('submit_feedback', null, null,
    jsonb_build_object('feedback_id', v_id, 'category', p_category, 'platform', v_platform));

  return v_id;
end;
$$;

revoke execute on function public.submit_feedback(text, text, text, text, text) from public, anon;
grant execute on function public.submit_feedback(text, text, text, text, text) to authenticated;

-- ============ 处理 / 重新打开（仅系统管理员） ============
-- 允许退回 open：误点「已处理」否则就死锁了；两种状态共用一个审计动作，状态记在 detail 里。
create or replace function public.admin_set_feedback_status(
  p_feedback_id uuid,
  p_status text,
  p_note text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_note text := nullif(trim(coalesce(p_note, '')), '');
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可处理意见反馈' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('open', 'resolved') then
    raise exception '处理状态不合法（仅支持 open / resolved）';
  end if;
  if length(coalesce(v_note, '')) > 200 then
    raise exception '处理说明过长（不超过 200 字）';
  end if;
  if not exists (select 1 from public.feedback where id = p_feedback_id) then
    raise exception '反馈不存在或已被删除';
  end if;

  update public.feedback
  set status = p_status,
      resolve_note = v_note,
      resolved_by = case when p_status = 'resolved' then v_uid end,
      resolved_at = case when p_status = 'resolved' then now() else null end
  where id = p_feedback_id;

  perform public.audit('handle_feedback', null, null,
    jsonb_build_object('feedback_id', p_feedback_id, 'status', p_status));
end;
$$;

revoke execute on function public.admin_set_feedback_status(uuid, text, text) from public, anon;
grant execute on function public.admin_set_feedback_status(uuid, text, text) to authenticated;
