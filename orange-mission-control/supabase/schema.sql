-- Orange Mission Control (pilot) - schema v1
-- Run this in Supabase SQL Editor.

-- Extensions
create extension if not exists pgcrypto;

-- Enums
do $$ begin
  create type public.app_role as enum ('OWNER','COORD','AGENT');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.mission_status as enum ('INBOX','ASSIGNED','IN_PROGRESS','REVIEW','DONE');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.event_type as enum ('MISSION_CREATED','STATUS_CHANGED','ASSIGNED','COMMENT','DECISION','DOC','STATUS');
exception when duplicate_object then null; end $$;

-- Core tables
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

-- Pilot: single workspace by name
create unique index if not exists workspaces_name_uq on public.workspaces(name);
insert into public.workspaces(name) values ('Orange Videos')
on conflict (name) do nothing;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  display_name text,
  role public.app_role not null default 'OWNER',
  created_at timestamptz not null default now()
);

create table if not exists public.missions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  title text not null,
  description text,
  tags text[] not null default '{}',
  status public.mission_status not null default 'INBOX',
  assignee_profile_id uuid references public.profiles(id) on delete set null,
  priority int not null default 0,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists missions_workspace_status_idx on public.missions(workspace_id, status);

create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  type public.event_type not null,
  mission_id uuid references public.missions(id) on delete set null,
  actor_profile_id uuid references public.profiles(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists events_workspace_created_idx on public.events(workspace_id, created_at desc);

create table if not exists public.pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  "order" int not null default 0
);

create unique index if not exists pipeline_stage_unique_order on public.pipeline_stages(workspace_id, "order");

create table if not exists public.deals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  stage_id uuid references public.pipeline_stages(id) on delete set null,
  value numeric,
  source text,
  owner_profile_id uuid references public.profiles(id) on delete set null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Updated_at triggers
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$ begin
  create trigger missions_set_updated_at
  before update on public.missions
  for each row execute procedure public.set_updated_at();
exception when duplicate_object then null; end $$;

do $$ begin
  create trigger deals_set_updated_at
  before update on public.deals
  for each row execute procedure public.set_updated_at();
exception when duplicate_object then null; end $$;

-- RLS
alter table public.workspaces enable row level security;
alter table public.profiles enable row level security;
alter table public.missions enable row level security;
alter table public.events enable row level security;
alter table public.pipeline_stages enable row level security;
alter table public.deals enable row level security;

-- Helper: current workspace id for logged-in user
create or replace function public.current_workspace_id()
returns uuid as $$
  select workspace_id from public.profiles where id = auth.uid();
$$ language sql stable security definer;

-- Policies (pilot: single workspace; still enforce tenancy)

do $$ begin
  create policy "workspaces: read own" on public.workspaces
  for select to authenticated
  using (id = public.current_workspace_id());
exception when duplicate_object then null; end $$;


do $$ begin
  create policy "profiles: read own workspace" on public.profiles
  for select to authenticated
  using (workspace_id = public.current_workspace_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "profiles: insert self" on public.profiles
  for insert to authenticated
  with check (id = auth.uid());
exception when duplicate_object then null; end $$;


do $$ begin
  create policy "missions: read own workspace" on public.missions
  for select to authenticated
  using (workspace_id = public.current_workspace_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "missions: write own workspace" on public.missions
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());
exception when duplicate_object then null; end $$;


do $$ begin
  create policy "events: read own workspace" on public.events
  for select to authenticated
  using (workspace_id = public.current_workspace_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "events: insert own workspace" on public.events
  for insert to authenticated
  with check (workspace_id = public.current_workspace_id());
exception when duplicate_object then null; end $$;


do $$ begin
  create policy "pipeline_stages: read own workspace" on public.pipeline_stages
  for select to authenticated
  using (workspace_id = public.current_workspace_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "pipeline_stages: write own workspace" on public.pipeline_stages
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());
exception when duplicate_object then null; end $$;


do $$ begin
  create policy "deals: read own workspace" on public.deals
  for select to authenticated
  using (workspace_id = public.current_workspace_id());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "deals: write own workspace" on public.deals
  for all to authenticated
  using (workspace_id = public.current_workspace_id())
  with check (workspace_id = public.current_workspace_id());
exception when duplicate_object then null; end $$;

-- Auto-create profile on signup (pilot: single workspace)
create or replace function public.handle_new_user()
returns trigger as $$
declare
  ws_id uuid;
begin
  select id into ws_id from public.workspaces where name = 'Orange Videos' limit 1;

  insert into public.profiles (id, workspace_id, display_name, role)
  values (
    new.id,
    ws_id,
    coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
    'OWNER'
  )
  on conflict (id) do nothing;

  return new;
end;
$$ language plpgsql security definer;

-- Trigger (idempotent)
do $$ begin
  create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
exception when duplicate_object then null; end $$;
