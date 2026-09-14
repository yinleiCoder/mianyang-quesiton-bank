-- 修复 42883 "operator does not exist: text ->> unknown"（提交/校验题目时报错）。
-- 根因：Postgres 运算符优先级表中 `||` 与 `->>` 同属 "(any other operator)" 且左结合，
-- `out_text || b ->> 'text'` 被解析为 `(out_text || b) ->> 'text'` —— 先对 text 结果做 jsonb 取值。
-- 修复：对 jsonb 取值表达式显式加括号。v_choice/v_simple_question/validate 均调用此函数，一处修复全链路恢复。

create or replace function public.v_blocks_text(blocks jsonb)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  b jsonb;
  out_text text := '';
begin
  if blocks is null or jsonb_typeof(blocks) <> 'array' then
    raise exception '块列表必须是数组';
  end if;
  for b in select * from jsonb_array_elements(blocks) loop
    if b ->> 't' = 'text' then
      if (b ->> 'text') is null then
        raise exception '文本块缺少 text 字段';
      end if;
      out_text := out_text || (b ->> 'text') || ' ';
    elsif b ->> 't' = 'media' then
      if b ->> 'key' is null or b ->> 'kind' is null then
        raise exception '媒体块缺少 key/kind 字段';
      end if;
    else
      raise exception '未知块类型 %', b ->> 't';
    end if;
  end loop;
  return out_text;
end;
$$;
