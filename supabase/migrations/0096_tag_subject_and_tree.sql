-- 0096：知识点标签的**学科隔离**与**层级**（2026-10-09 用户拍板）
--
-- 问题：`tags` 从 0003 起就是一张扁平表——没有学科、没有父级，而且
-- `name citext unique` 让「安全用电」这种名字**全库只能存在一个**。
-- 线上 8 个标签正好是这个毛病的样本：学科名（计算机/信息技术）、课程名（办公应用基础）
-- 与真正的知识点（excel/word/ppt/access）混在同一层，谁也说不清哪个属于哪一层。
--
-- 四条口径（用户逐条拍板）：
--   1. 知识点挂到**任意科目节点**（与 0075 起「题可挂任意层级」同口径），
--      筛选时含该节点的整棵子树；
--   2. 知识点自己是一棵**任意深度的树**（parent_id 自引用，复用科目树的模式）；
--   3. 唯一性从「全库唯一」改成「**同一学科、同一父级下唯一**」——这正是学科隔离的落点；
--   4. 存量：access/word/excel/ppt 归到「办公应用」这个课程节点；
--      其余四个（计算机/信息技术/办公应用基础/计算机网络）**留空**——
--      它们是学科名或课程名，不是知识点，留给人指派，不猜。
--
-- **不动 `version_tags`**：它存的是 `tag_name` 快照（改名/合并不影响历史展示），
-- 那是整个标签体系里最不能碰的约定，加层级不需要动它。
--
-- 与 subject_nodes 的关系：只借它的**节点**做挂载点，不合并两张表。
-- 注意「知识点」一词在本库里是**重载**的：出题侧指 tags，学情侧（0079/0080/0088）
-- 指 subject_nodes 的课程节点。这次只动出题侧。

-- =====================================================================
-- 1) 加列
-- =====================================================================
alter table public.tags
  add column if not exists subject_node_id uuid
    references public.subject_nodes(id) on delete set null,
  add column if not exists parent_id uuid
    references public.tags(id) on delete restrict,
  add column if not exists sort_order integer not null default 0;

comment on column public.tags.subject_node_id is
  '这个知识点属于哪个科目节点（任意层级，筛选含其子树）。null = 未归类，等人指派（2026-10-09 / 0096）';
comment on column public.tags.parent_id is
  '父知识点，自引用成树。null = 顶层。子与父必须同学科，由 trg_validate_tag 守着';
comment on column public.tags.sort_order is
  '同层排序，小的在前。与 subject_nodes.sort_order 同义';

create index if not exists idx_tags_subject on public.tags (subject_node_id);
create index if not exists idx_tags_parent on public.tags (parent_id);

-- =====================================================================
-- 2) 树的完整性：父级存在、同学科、不成环
-- =====================================================================
-- **必须做成 DEFERRABLE 的约束触发器，不能用普通的 BEFORE 行触发器。**
-- 理由：admin_move_tag 要把一棵子树整体换学科，那是一条 UPDATE 改多行。
-- BEFORE 行触发器逐行检查，而多行 UPDATE 的行序不保证——某个子节点可能在父节点
-- 还没更新时就被检查，于是"子与父同学科"这条在中间态必然不成立。
-- 约束触发器推迟到**事务提交时**才检查，中间态随便过，最终必须合法。
-- PostgREST 每次 RPC 调用就是一个事务，所以检查点正好落在一次操作结束时。
--
-- （另一条老规矩仍然适用：BEFORE DELETE 的守卫要 `return old`，
-- 在这里不涉及——本函数只挂在 INSERT/UPDATE 上，一律 `return new`。）
create or replace function public.validate_tag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_parent tags%rowtype;
begin
  if new.parent_id is null then
    return new;
  end if;

  if new.parent_id = new.id then
    raise exception '知识点不能以自己为父级';
  end if;

  select * into v_parent from tags where id = new.parent_id;
  if not found then
    raise exception '父知识点不存在';
  end if;

  -- 子必须与父同学科。父未归类（null）时子也必须未归类——
  -- 否则会出现"挂在未归类父级下、却属于某学科"的孤儿：按学科筛时一会儿看得见一会儿看不见。
  if v_parent.subject_node_id is distinct from new.subject_node_id then
    raise exception '子知识点的学科必须与父级一致';
  end if;

  -- 成环：从自己往上走，若能走到新父级链里的自己，说明把父级设到了自己的后代上
  if exists (
    with recursive up as (
      select id, parent_id from tags where id = new.parent_id
      union all
      select t.id, t.parent_id from tags t join up on t.id = up.parent_id
    )
    select 1 from up where id = new.id
  ) then
    raise exception '不能把一个知识点移到它自己的子节点下';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_tag on public.tags;
create constraint trigger trg_validate_tag
  after insert or update on public.tags
  deferrable initially deferred
  for each row execute function public.validate_tag();

-- =====================================================================
-- 3) 唯一性：全库唯一 → 同一学科 + 同一父级下唯一
-- =====================================================================
-- 这一步是学科隔离的核心：不换掉这个约束，「安全用电」就永远只能属于一个学科。
alter table public.tags drop constraint if exists tags_name_key;

-- 与 uq_subject_nodes_sibling_name 同款：null 先用零 uuid 归一化——
-- 否则 Postgres 的唯一索引**不约束 null**，两行 (null, null, 'excel') 会同时存在。
create unique index if not exists uq_tags_sibling_name
  on public.tags (
    coalesce(subject_node_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(name)
  );

-- =====================================================================
-- 4) 建知识点：带上父级与学科
-- =====================================================================
-- 先 drop 旧的单参版本：留着就是两个重载并存，PostgREST 会因歧义报错
-- （与 0069 处理 start_practice_session 同一手法）。
-- 新版两个参数都有默认值，所以**只传 p_name 的旧客户端照常可用**——
-- 线上跑的 Flutter/网页端不必跟着这次一起发。
drop function if exists public.create_tag(text);

create or replace function public.create_tag(
  p_name text,
  p_parent_id uuid default null,
  p_subject_node_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_id uuid;
  v_subject uuid := p_subject_node_id;
  v_parent tags%rowtype;
begin
  if not public.is_teacher() then
    raise exception '仅审核通过的教师可执行该操作';
  end if;
  if trim(p_name) = '' then
    raise exception '标签名不能为空';
  end if;

  if p_parent_id is not null then
    select * into v_parent from tags where id = p_parent_id;
    if not found then
      raise exception '父知识点不存在';
    end if;
    -- 子继承父的学科：调用方不必两处都传，也就不会传出个不一致的组合
    v_subject := v_parent.subject_node_id;
  end if;

  if v_subject is not null
     and not exists (select 1 from subject_nodes where id = v_subject) then
    raise exception '学科节点不存在';
  end if;

  begin
    insert into tags (name, created_by, parent_id, subject_node_id)
    values (trim(p_name), v_uid, p_parent_id, v_subject)
    returning id into v_id;
  exception when unique_violation then
    raise exception '同一学科下已有同名知识点';
  end;
  return v_id;
end;
$$;

comment on function public.create_tag(text, uuid, uuid) is
  '新建知识点。p_parent_id 非空时学科继承父级；同名限定在"同一学科同一父级"下（2026-10-09 / 0096）';

revoke execute on function public.create_tag(text, uuid, uuid) from public, anon;
grant execute on function public.create_tag(text, uuid, uuid) to authenticated;

-- =====================================================================
-- 5) 管理员指派：改学科 / 改父级（存量归位与日常整理都走它）
-- =====================================================================
create or replace function public.admin_move_tag(
  p_tag_id uuid,
  p_subject_node_id uuid default null,
  p_new_parent_id uuid default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_subject uuid := p_subject_node_id;
  v_parent tags%rowtype;
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可管理知识点';
  end if;
  if not exists (select 1 from tags where id = p_tag_id) then
    raise exception '知识点不存在';
  end if;

  if p_new_parent_id is not null then
    select * into v_parent from tags where id = p_new_parent_id;
    if not found then
      raise exception '父知识点不存在';
    end if;
    v_subject := v_parent.subject_node_id;
  end if;

  if v_subject is not null
     and not exists (select 1 from subject_nodes where id = v_subject) then
    raise exception '学科节点不存在';
  end if;

  -- 整棵子树跟着换学科：子与父必须同学科，只改自己会让子孙全部变成非法状态。
  -- 两条 UPDATE 之间必然存在"中间态不合法"的瞬间，所以校验做成了推迟到提交时的
  -- 约束触发器（见第 2 节）——普通 BEFORE 行触发器在这里一定会误报。
  with recursive sub as (
    select id from tags where id = p_tag_id
    union all
    select t.id from tags t join sub on t.parent_id = sub.id
  )
  update tags set subject_node_id = v_subject
  where id in (select id from sub);

  update tags set parent_id = p_new_parent_id where id = p_tag_id;

  perform public.audit('admin_move_tag', null, null,
    jsonb_build_object('tag_id', p_tag_id, 'subject_node_id', v_subject,
                       'parent_id', p_new_parent_id));
end;
$$;

comment on function public.admin_move_tag(uuid, uuid, uuid) is
  '把知识点（及其整棵子树）移到某个学科节点下，并可同时改父级。传 null 学科 = 退回未归类';

revoke execute on function public.admin_move_tag(uuid, uuid, uuid) from public, anon;
grant execute on function public.admin_move_tag(uuid, uuid, uuid) to authenticated;

-- =====================================================================
-- 6) 合并：补两道守卫（跨学科、带子节点）
-- =====================================================================
create or replace function public.admin_merge_tag(p_from_tag uuid, p_to_tag uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := public.require_uid();
  v_from tags%rowtype;
  v_to tags%rowtype;
begin
  if not public.is_admin() then
    raise exception '仅系统管理员可管理标签';
  end if;
  if p_from_tag = p_to_tag then
    raise exception '不能合并到自己';
  end if;

  select * into v_to from tags where id = p_to_tag;
  if not found then
    raise exception '目标标签不存在';
  end if;
  select * into v_from from tags where id = p_from_tag;
  if not found then
    raise exception '源标签不存在';
  end if;

  -- 加了学科之后，合并**不再是无条件安全**的：跨学科合并会把两个学科的知识点揉进一个，
  -- 而 version_tags 是全表重指、不会报错——又是一次静默串科。
  if v_from.subject_node_id is distinct from v_to.subject_node_id then
    raise exception '不能跨学科合并知识点（源：%，目标：%）',
      coalesce(v_from.subject_node_id::text, '未归类'),
      coalesce(v_to.subject_node_id::text, '未归类');
  end if;

  -- 带子节点的不能合并掉：parent_id 是 on delete restrict，硬删会抛外键错。
  -- 先拦下来是为了给人话，而不是把 23503 甩给管理员。
  if exists (select 1 from tags where parent_id = p_from_tag) then
    raise exception '该知识点下还有子知识点，先把它们移走再合并';
  end if;

  update version_tags set tag_id = p_to_tag where tag_id = p_from_tag;
  update version_tags vt set tag_name = v_to.name
  where vt.tag_id = p_to_tag and vt.version_id in (
    select id from question_versions where status in ('draft','pending_group','pending_city','returned'));

  -- 源标签若已无引用则删除，否则保留
  delete from tags where id = p_from_tag
    and not exists (select 1 from version_tags where tag_id = p_from_tag);

  perform public.audit('admin_merge_tag', null, null,
    jsonb_build_object('from', p_from_tag, 'to', p_to_tag));
end;
$$;

-- =====================================================================
-- 7) 存量归位：access / word / excel / ppt → 办公应用（课程）
-- =====================================================================
-- 只归这四个：它们是真正的知识点。计算机 / 信息技术 / 办公应用基础 / 计算机网络
-- 留 subject_node_id = null（未归类）等人工指派——它们本就是学科名或课程名，
-- 自动推断只会把「计算机」压成某一个课程下的知识点。
do $$
declare
  -- 计算机(专业大类) → 计算机(专业) → 办公应用(课程)；全库 599 道题都挂在这个课程下
  v_node uuid := '0428b9e9-e5ba-4f99-ba07-f352e042c6fc';
  v_moved int;
begin
  if not exists (select 1 from public.subject_nodes where id = v_node) then
    raise exception '回填目标「办公应用」节点不存在，0096 的存量归位需要人工确认';
  end if;

  update public.tags
  set subject_node_id = v_node
  where lower(name::text) in ('excel', 'word', 'ppt', 'access')
    and subject_node_id is null;

  get diagnostics v_moved = row_count;
  raise notice '0096：已归位 % 个知识点到「办公应用」', v_moved;
end $$;
