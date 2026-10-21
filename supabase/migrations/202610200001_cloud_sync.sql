-- SlashTasks v1 sync protocol. All versions are issued by the database.
-- Clients may read their rows, but all writes go through the atomic CAS RPC.
begin;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create table public.sync_heads (
  user_id uuid primary key references auth.users(id) on delete cascade,
  version bigint not null default 1 check(version > 0)
);
create table public.profiles (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  data jsonb not null check(jsonb_typeof(data) = 'object'),
  version bigint not null,
  field_versions jsonb not null default '{}',
  deleted_at timestamptz,
  primary key(user_id,id),
  check(id = user_id::text),
  check(deleted_at is null)
);
create table public.lists (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null check(length(id) between 1 and 200),
  data jsonb not null check(jsonb_typeof(data) = 'object'),
  version bigint not null,
  field_versions jsonb not null default '{}',
  deleted_at timestamptz,
  primary key(user_id,id)
);
create table public.tasks (like public.lists including all);
alter table public.tasks add foreign key(user_id) references auth.users(id) on delete cascade;
create table public.subtasks (like public.lists including all);
alter table public.subtasks add foreign key(user_id) references auth.users(id) on delete cascade;
alter table public.subtasks add column parent_id text generated always as (data->>'taskId') stored not null;
alter table public.subtasks add foreign key(user_id,parent_id) references public.tasks(user_id,id) on delete cascade;
create table public.sync_receipts (
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id uuid not null,
  response jsonb not null,
  request_hash text not null,
  created_at timestamptz not null default now(),
  primary key(user_id,batch_id)
);
create index tasks_sync_version on public.tasks(user_id,version);
create index subtasks_sync_version on public.subtasks(user_id,version);
create index subtasks_parent on public.subtasks(user_id,parent_id);
create index lists_sync_version on public.lists(user_id,version);
create unique index one_followup_per_occurrence on public.tasks(user_id,(data->>'sourceOccurrenceId'))
  where deleted_at is null and data->>'sourceOccurrenceId' is not null;

do $$
declare tab text;
begin
  foreach tab in array array['profiles','lists','tasks','subtasks','sync_heads','sync_receipts'] loop
    execute format('alter table public.%I enable row level security',tab);
    execute format('revoke all on public.%I from anon, authenticated',tab);
    execute format('create policy own_rows on public.%I for select to authenticated using ((select auth.uid()) = user_id)',tab);
  end loop;
end $$;
grant select on public.profiles,public.lists,public.tasks,public.subtasks to authenticated;

create function private.ensure_account(uid uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.sync_heads(user_id,version) values(uid,1) on conflict do nothing;
  insert into public.profiles(user_id,id,data,version,field_versions) values
    (uid,uid::text,'{"displayName":"","timezone":"UTC","reminderTime":"09:00"}',1,'{"displayName":1,"timezone":1,"reminderTime":1}')
    on conflict do nothing;
  insert into public.lists(user_id,id,data,version,field_versions)
    select uid,'list:'||name,jsonb_build_object('name',name),1,'{"name":1}'
    from unnest(array['Personal','Work','Home']) name
    on conflict do nothing;
end $$;
create function private.on_signup() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.ensure_account(new.id); return new;
end $$;
create trigger slashtasks_new_user after insert on auth.users for each row execute function private.on_signup();

create function private.record_json(kind text, row_data jsonb) returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('kind',kind,'id',row_data->'id','data',row_data->'data','version',row_data->'version',
    'fieldVersions',row_data->'field_versions','deleted',row_data->'deleted_at' is not null and row_data->'deleted_at' <> 'null'::jsonb);
$$;
create function private.changes_since(uid uuid, since_version bigint) returns jsonb language plpgsql security definer set search_path = '' as $$
declare tab text; rows jsonb; result jsonb := '[]';
begin
  foreach tab in array array['profiles','lists','tasks','subtasks'] loop
    execute format('select coalesce(jsonb_agg(private.record_json($3,to_jsonb(r))),''[]''::jsonb) from public.%I r where user_id=$1 and version>$2',tab)
      into rows using uid,since_version,tab;
    result := result || rows;
  end loop;
  return result;
end $$;

create function private.validate_record(kind text, payload jsonb) returns void language plpgsql set search_path = '' as $$
declare key text; allowed text[]; value jsonb;
begin
  if jsonb_typeof(payload) <> 'object' or octet_length(payload::text)>65536 then raise exception 'Invalid record'; end if;
  allowed := case kind
    when 'profiles' then array['displayName','timezone','reminderTime']
    when 'lists' then array['name']
    when 'tasks' then array['title','list','energy','dueDate','reminderDate','reminderTime','remindersEnabled','repeat','done','priority','completedAt','seriesId','nextOccurrenceId','sourceOccurrenceId','snoozedUntil']
    when 'subtasks' then array['taskId','title','dueDate','dueTime','done','position','seriesStepId']
    else null end;
  if allowed is null then raise exception 'Invalid entity'; end if;
  for key,value in select * from jsonb_each(payload) loop
    if not key = any(allowed) then raise exception 'Unknown field %',key; end if;
    if value = 'null'::jsonb then
      if key not in ('completedAt','nextOccurrenceId','seriesId','sourceOccurrenceId','snoozedUntil') then raise exception 'Null field %',key; end if;
    elsif key in ('done','remindersEnabled') then
      if jsonb_typeof(value)<>'boolean' then raise exception 'Expected boolean'; end if;
    elsif key in ('priority','position') then
      if jsonb_typeof(value)<>'number' or abs((value::text)::numeric)>1e16 then raise exception 'Invalid number'; end if;
    else
      if jsonb_typeof(value)<>'string' or length(payload->>key)>200 then raise exception 'Invalid text'; end if;
      if key in ('dueDate','reminderDate') and payload->>key<>'' then perform (payload->>key)::date; end if;
      if key in ('dueTime','reminderTime') and payload->>key<>'' and payload->>key !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then raise exception 'Invalid time'; end if;
      if key in ('completedAt','snoozedUntil') and payload->>key<>'' then perform (payload->>key)::timestamptz; end if;
    end if;
  end loop;
  if kind in ('tasks','subtasks') and (coalesce(length(btrim(payload->>'title')),0) not between 1 and 120) then raise exception 'Task needs a title'; end if;
  if kind='subtasks' and coalesce(payload->>'taskId','')='' then raise exception 'Step needs a task'; end if;
  if kind='lists' and coalesce(length(btrim(payload->>'name')),0) not between 1 and 40 then raise exception 'Invalid list name'; end if;
  if kind='profiles' and (length(coalesce(payload->>'displayName',''))>80 or coalesce(payload->>'timezone','')='') then raise exception 'Invalid profile'; end if;
  if kind='tasks' then
    if coalesce(payload->>'list','')='' or length(payload->>'list')>40 then raise exception 'Invalid list'; end if;
    if coalesce(payload->>'energy','') not in ('small','medium','big') or coalesce(payload->>'repeat','') not in ('none','daily','weekdays','weekly','after1day') then raise exception 'Invalid task options'; end if;
  end if;
end $$;

create function public.sync_pull(p_cursor bigint default 0) returns jsonb language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); head bigint;
begin
  if uid is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  perform private.ensure_account(uid);
  select version into head from public.sync_heads where user_id=uid;
  if p_cursor<0 or p_cursor>head then raise exception 'Invalid sync cursor'; end if;
  return jsonb_build_object('cursor',head,'changes',private.changes_since(uid,p_cursor));
end $$;

create function public.apply_sync_batch(p_batch_id uuid, p_mutations jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); mutation jsonb; kind text; record_id text; current_row jsonb; merged jsonb;
  patch jsonb; base jsonb; key text; conflicts jsonb := '[]'; reason text; fields jsonb;
  head bigint; next_version bigint; versions jsonb; result jsonb; parent text; parent_row jsonb; planned_parent jsonb;
  deleting boolean; restoring boolean; exists_row boolean; seen text[] := '{}';
begin
  if uid is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_batch_id is null or jsonb_typeof(p_mutations)<>'array' or jsonb_array_length(p_mutations) not between 1 and 200 or octet_length(p_mutations::text)>262144 then
    raise exception 'Invalid sync batch';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,0));
  select response into result from public.sync_receipts where user_id=uid and batch_id=p_batch_id;
  if result is not null then
    if not exists(select 1 from public.sync_receipts where user_id=uid and batch_id=p_batch_id and request_hash=md5(p_mutations::text)) then raise exception 'Batch id was reused with different changes'; end if;
    return result;
  end if;
  perform private.ensure_account(uid);
  select version into head from public.sync_heads where user_id=uid;
  -- Preflight every row before writing any row, so a task + steps mutation is atomic.
  for mutation in select * from jsonb_array_elements(p_mutations) loop
    kind := mutation->>'kind'; record_id := mutation->>'id'; patch := coalesce(mutation->'patch','{}'); base := coalesce(mutation->'baseFields','{}');
    if kind not in ('profiles','lists','tasks','subtasks') or record_id is null or length(record_id) not between 1 and 200 or jsonb_typeof(patch)<>'object' or jsonb_typeof(base)<>'object' then raise exception 'Invalid mutation'; end if;
    if kind||':'||record_id = any(seen) then raise exception 'Duplicate mutation'; end if;
    seen := array_append(seen,kind||':'||record_id);
    if kind='profiles' and record_id<>uid::text then raise exception 'Profile ownership mismatch' using errcode='42501'; end if;
    deleting := coalesce((mutation->>'delete')::boolean,false); restoring := coalesce((mutation->>'restore')::boolean,false);
    if patch ? 'completedAt' then raise exception 'Completion time is managed by the server'; end if;
    if kind='profiles' and deleting then raise exception 'Cannot delete profile through sync'; end if;
    execute format('select to_jsonb(r) from public.%I r where user_id=$1 and id=$2',kind) into current_row using uid,record_id;
    exists_row := current_row is not null;
    reason := null; fields := '[]';
    if exists_row and current_row->>'deleted_at' is not null and not restoring and not deleting then reason := 'deleted';
    elsif (deleting or restoring) and coalesce((current_row->>'version')::bigint,0)<>coalesce((mutation->>'baseVersion')::bigint,0) then reason := 'record_changed';
    elsif not exists_row and coalesce((mutation->>'baseVersion')::bigint,0)>0 then reason := 'missing';
    else
      for key in select jsonb_object_keys(patch) loop
        if coalesce((current_row->'field_versions'->>key)::bigint,0)<>coalesce((base->>key)::bigint,0)
          and (current_row->'data'->key) is distinct from (patch->key) then fields := fields||to_jsonb(key); end if;
      end loop;
      if jsonb_array_length(fields)>0 then reason := 'field_conflict'; end if;
    end if;
    if not deleting then
      merged := coalesce(current_row->'data','{}')||patch;
      perform private.validate_record(kind,merged);
      if kind='lists' and record_id<>'list:'||(merged->>'name') then raise exception 'Invalid list identity'; end if;
      if kind='tasks' and merged->>'sourceOccurrenceId' is not null then
        select to_jsonb(t) into parent_row from public.tasks t where user_id=uid and id<>record_id and deleted_at is null and data->>'sourceOccurrenceId'=merged->>'sourceOccurrenceId';
        if parent_row is not null then reason:='recurrence_changed'; end if;
      end if;
      if kind='subtasks' then
        parent := merged->>'taskId';
        select m into planned_parent from jsonb_array_elements(p_mutations) m where m->>'kind'='tasks' and m->>'id'=parent;
        select to_jsonb(t) into parent_row from public.tasks t where user_id=uid and id=parent;
        if (planned_parent is not null and coalesce((planned_parent->>'delete')::boolean,false))
           or (planned_parent is null and (parent_row is null or parent_row->>'deleted_at' is not null)) then reason := 'parent_deleted'; end if;
      end if;
    end if;
    if reason is not null then conflicts := conflicts||jsonb_build_array(jsonb_build_object('kind',kind,'id',record_id,'reason',reason,'fields',fields,
      'remote',case when exists_row then private.record_json(kind,current_row) else null end)); end if;
  end loop;
  if jsonb_array_length(conflicts)>0 then return jsonb_build_object('ok',false,'conflicts',conflicts); end if;
  next_version := head+1;
  -- Parents before children, and child removals before parent removals.
  for mutation in select m from jsonb_array_elements(p_mutations) m order by
    case when coalesce((m->>'delete')::boolean,false) and m->>'kind'='tasks' then 9 when m->>'kind'='subtasks' then 5 else 1 end loop
    kind:=mutation->>'kind'; record_id:=mutation->>'id'; patch:=coalesce(mutation->'patch','{}');
    deleting:=coalesce((mutation->>'delete')::boolean,false);
    execute format('select to_jsonb(r) from public.%I r where user_id=$1 and id=$2',kind) into current_row using uid,record_id;
    merged:=coalesce(current_row->'data','{}')||patch; versions:=coalesce(current_row->'field_versions','{}');
    if kind='tasks' and patch ? 'done' then
      if merged->>'done'='true' and coalesce(current_row->'data'->>'done','false')<>'true' then
        merged:=merged||jsonb_build_object('completedAt',now());versions:=versions||jsonb_build_object('completedAt',next_version);
      elsif merged->>'done'='false' then merged:=merged||'{"completedAt":null}'::jsonb; end if;
    end if;
    for key in select jsonb_object_keys(patch) loop versions:=jsonb_set(versions,array[key],to_jsonb(next_version)); end loop;
    versions:=jsonb_set(versions,array['_deleted'],to_jsonb(next_version));
    if deleting and current_row is null then continue; end if;
    execute format('insert into public.%I(user_id,id,data,version,field_versions,deleted_at) values($1,$2,$3,$4,$5,$6)
      on conflict(user_id,id) do update set data=excluded.data,version=excluded.version,field_versions=excluded.field_versions,deleted_at=excluded.deleted_at',kind)
      using uid,record_id,merged,next_version,versions,case when deleting then now() else null end;
    if kind='tasks' and deleting then
      update public.subtasks set deleted_at=now(),version=next_version,field_versions=field_versions||jsonb_build_object('_deleted',next_version)
        where user_id=uid and parent_id=record_id and deleted_at is null;
    end if;
  end loop;
  update public.sync_heads set version=next_version where user_id=uid;
  result:=jsonb_build_object('ok',true,'changes',private.changes_since(uid,head));
  insert into public.sync_receipts(user_id,batch_id,response,request_hash) values(uid,p_batch_id,result,md5(p_mutations::text));
  return result;
end $$;
revoke all on all functions in schema private from public, anon, authenticated;
revoke all on function public.sync_pull(bigint),public.apply_sync_batch(uuid,jsonb) from public,anon;
grant execute on function public.sync_pull(bigint),public.apply_sync_batch(uuid,jsonb) to authenticated;
commit;

begin;
grant select on public.sync_heads to authenticated;
do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') and not exists(
    select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='sync_heads'
  ) then alter publication supabase_realtime add table public.sync_heads; end if;
end $$;
create table private.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null, count integer not null default 0,
  minute timestamptz not null default now(), minute_count integer not null default 0,
  primary key(user_id,day)
);
alter table private.ai_usage enable row level security;
revoke all on private.ai_usage from public,anon,authenticated;
create function public.reserve_ai_request() returns jsonb language plpgsql security definer set search_path='' as $$
declare uid uuid:=auth.uid(); usage private.ai_usage; current_day date:=(now() at time zone 'UTC')::date;
begin
  if uid is null then raise exception 'Authentication required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text,1));
  insert into private.ai_usage(user_id,day) values(uid,current_day) on conflict do nothing;
  select * into usage from private.ai_usage where user_id=uid and day=current_day for update;
  if usage.count>=20 then return '{"allowed":false,"reason":"daily_limit"}'; end if;
  if usage.minute>now()-interval '1 minute' and usage.minute_count>=3 then return '{"allowed":false,"reason":"minute_limit","retryAfter":60}'; end if;
  update private.ai_usage set count=count+1,minute_count=case when minute<=now()-interval '1 minute' then 1 else minute_count+1 end,
    minute=case when minute<=now()-interval '1 minute' then now() else minute end where user_id=uid and day=current_day;
  return '{"allowed":true}';
end $$;
revoke all on function public.reserve_ai_request() from public,anon;
grant execute on function public.reserve_ai_request() to authenticated;
commit;
