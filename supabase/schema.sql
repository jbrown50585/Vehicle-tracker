-- Vehicle Project Tracker — Supabase schema
-- Run this in the Supabase dashboard: SQL Editor -> New query -> paste all -> Run
-- Safe to run more than once (uses IF NOT EXISTS / DROP ... IF EXISTS everywhere).

create extension if not exists "pgcrypto";

create table if not exists vehicles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  vin text,
  make text not null,
  model text not null,
  year int not null,
  trim text,
  start_date date,
  target_date date,
  cover_photo_path text,
  vehicle_type text not null default 'project',
  current_mileage int,
  purchase_price numeric,
  sale_price numeric,
  owner_email text,
  created_at timestamptz not null default now()
);
alter table vehicles add column if not exists cover_photo_path text;
alter table vehicles add column if not exists vehicle_type text not null default 'project';
alter table vehicles add column if not exists current_mileage int;
alter table vehicles add column if not exists purchase_price numeric;
alter table vehicles add column if not exists sale_price numeric;
alter table vehicles add column if not exists owner_email text;
update vehicles set owner_email = (select email from auth.users where id = vehicles.user_id) where owner_email is null;

create table if not exists phases (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  name text not null,
  budget numeric not null default 0
);

create table if not exists parts (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  phase_id uuid references phases(id) on delete set null,
  name text not null,
  category text not null default 'Other',
  cost numeric not null default 0,
  status text not null default 'needed',
  vendor text,
  notes text,
  photo_path text,
  part_number text,
  created_at timestamptz not null default now()
);
alter table parts add column if not exists part_number text;

create table if not exists labor (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  date date,
  description text,
  hours numeric not null default 0,
  paid boolean not null default false,
  amount numeric not null default 0
);

create table if not exists credits (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  date date,
  amount numeric not null default 0,
  reason text
);

create table if not exists journal_entries (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  date date,
  text text not null,
  photo_paths text[] not null default '{}',
  created_at timestamptz not null default now()
);

create table if not exists vehicle_notes (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  text text not null,
  created_by uuid references auth.users(id),
  author_email text,
  edited_at timestamptz,
  created_at timestamptz not null default now()
);
alter table vehicle_notes add column if not exists created_by uuid references auth.users(id);
alter table vehicle_notes add column if not exists author_email text;
alter table vehicle_notes add column if not exists edited_at timestamptz;

create table if not exists vehicle_views (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  last_viewed_at timestamptz not null default now(),
  unique (vehicle_id, user_id)
);

create table if not exists fuel_logs (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  date date,
  mileage int not null,
  gallons numeric not null,
  total_cost numeric not null default 0,
  full_tank boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists maintenance_items (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  task text not null,
  interval_days int,
  interval_miles int,
  last_done_date date,
  last_done_mileage int,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists favorite_parts (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  name text not null,
  part_number text,
  vendor text,
  category text not null default 'Other',
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists checklist_items (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  category text not null default 'Other',
  task text not null,
  done boolean not null default false,
  done_date date,
  position int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists known_collaborators (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  email text not null,
  nickname text,
  created_at timestamptz not null default now(),
  unique (owner_id, email)
);
alter table known_collaborators enable row level security;
drop policy if exists "own contacts select" on known_collaborators;
drop policy if exists "own contacts insert" on known_collaborators;
drop policy if exists "own contacts update" on known_collaborators;
drop policy if exists "own contacts delete" on known_collaborators;
create policy "own contacts select" on known_collaborators for select using (owner_id = auth.uid());
create policy "own contacts insert" on known_collaborators for insert with check (owner_id = auth.uid());
create policy "own contacts update" on known_collaborators for update using (owner_id = auth.uid());
create policy "own contacts delete" on known_collaborators for delete using (owner_id = auth.uid());

create table if not exists vehicle_collaborators (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  email text not null,
  invited_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  unique (vehicle_id, email)
);

-- Row Level Security: every user can see/touch their own vehicles, plus any
-- vehicle they've been added to as a collaborator (matched by their login
-- email). has_vehicle_access() is the single source of truth for that check —
-- every child table's policies call it instead of repeating the logic.

create or replace function has_vehicle_access(vid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    exists (select 1 from vehicles where id = vid and user_id = auth.uid())
    or exists (
      select 1 from vehicle_collaborators
      where vehicle_id = vid and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    );
$$;
grant execute on function has_vehicle_access(uuid) to authenticated;

alter table vehicles enable row level security;
alter table vehicle_collaborators enable row level security;
alter table phases enable row level security;
alter table parts enable row level security;
alter table labor enable row level security;
alter table credits enable row level security;
alter table journal_entries enable row level security;
alter table checklist_items enable row level security;
alter table favorite_parts enable row level security;
alter table maintenance_items enable row level security;
alter table fuel_logs enable row level security;
alter table vehicle_notes enable row level security;
alter table vehicle_views enable row level security;

drop policy if exists "own views select" on vehicle_views;
drop policy if exists "own views insert" on vehicle_views;
drop policy if exists "own views update" on vehicle_views;
create policy "own views select" on vehicle_views for select using (user_id = auth.uid());
create policy "own views insert" on vehicle_views for insert with check (user_id = auth.uid() and has_vehicle_access(vehicle_id));
create policy "own views update" on vehicle_views for update using (user_id = auth.uid());

drop policy if exists "own vehicles select" on vehicles;
drop policy if exists "own vehicles insert" on vehicles;
drop policy if exists "own vehicles update" on vehicles;
drop policy if exists "own vehicles delete" on vehicles;
drop policy if exists "vehicles select" on vehicles;
drop policy if exists "vehicles insert" on vehicles;
drop policy if exists "vehicles update" on vehicles;
drop policy if exists "vehicles delete" on vehicles;
-- Owner or collaborator can view; only the owner can rename/delete the vehicle
-- itself (collaborators get full access to everything they work on inside it).
-- NOTE: this policy checks ownership/collaboration directly instead of calling
-- has_vehicle_access(), because that function itself queries vehicles — going
-- through it here would make the policy check its own table circularly, which
-- Postgres resolves as "no access" instead of erroring. Child tables (parts,
-- phases, etc.) don't have this problem, since for them has_vehicle_access()
-- queries a *different* table (vehicles) than the one the policy is on.
create policy "vehicles select" on vehicles for select using (
  user_id = auth.uid()
  or exists (
    select 1 from vehicle_collaborators
    where vehicle_id = vehicles.id and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
);
create policy "vehicles insert" on vehicles for insert with check (user_id = auth.uid());
create policy "vehicles update" on vehicles for update using (user_id = auth.uid());
create policy "vehicles delete" on vehicles for delete using (user_id = auth.uid());

drop policy if exists "collaborators select" on vehicle_collaborators;
drop policy if exists "collaborators insert" on vehicle_collaborators;
drop policy if exists "collaborators delete" on vehicle_collaborators;
-- Inlined instead of calling has_vehicle_access(), same reason as the vehicles
-- select policy: that function's collaborator-matching branch queries this
-- exact table, so calling it from this table's own policy is circular and
-- Postgres silently resolves it as "no access" for the collaborator branch.
create policy "collaborators select" on vehicle_collaborators for select using (
  vehicle_id in (select id from vehicles where user_id = auth.uid())
  or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
);
create policy "collaborators insert" on vehicle_collaborators for insert with check (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "collaborators delete" on vehicle_collaborators for delete using (vehicle_id in (select id from vehicles where user_id = auth.uid()));

drop policy if exists "own phases select" on phases;
drop policy if exists "own phases insert" on phases;
drop policy if exists "own phases update" on phases;
drop policy if exists "own phases delete" on phases;
drop policy if exists "phases select" on phases;
drop policy if exists "phases insert" on phases;
drop policy if exists "phases update" on phases;
drop policy if exists "phases delete" on phases;
create policy "phases select" on phases for select using (has_vehicle_access(vehicle_id));
create policy "phases insert" on phases for insert with check (has_vehicle_access(vehicle_id));
create policy "phases update" on phases for update using (has_vehicle_access(vehicle_id));
create policy "phases delete" on phases for delete using (has_vehicle_access(vehicle_id));

drop policy if exists "own parts select" on parts;
drop policy if exists "own parts insert" on parts;
drop policy if exists "own parts update" on parts;
drop policy if exists "own parts delete" on parts;
drop policy if exists "parts select" on parts;
drop policy if exists "parts insert" on parts;
drop policy if exists "parts update" on parts;
drop policy if exists "parts delete" on parts;
create policy "parts select" on parts for select using (has_vehicle_access(vehicle_id));
create policy "parts insert" on parts for insert with check (has_vehicle_access(vehicle_id));
create policy "parts update" on parts for update using (has_vehicle_access(vehicle_id));
create policy "parts delete" on parts for delete using (has_vehicle_access(vehicle_id));

drop policy if exists "own labor select" on labor;
drop policy if exists "own labor insert" on labor;
drop policy if exists "own labor update" on labor;
drop policy if exists "own labor delete" on labor;
drop policy if exists "labor select" on labor;
drop policy if exists "labor insert" on labor;
drop policy if exists "labor update" on labor;
drop policy if exists "labor delete" on labor;
create policy "labor select" on labor for select using (has_vehicle_access(vehicle_id));
create policy "labor insert" on labor for insert with check (has_vehicle_access(vehicle_id));
create policy "labor update" on labor for update using (has_vehicle_access(vehicle_id));
create policy "labor delete" on labor for delete using (has_vehicle_access(vehicle_id));

drop policy if exists "own credits select" on credits;
drop policy if exists "own credits insert" on credits;
drop policy if exists "own credits update" on credits;
drop policy if exists "own credits delete" on credits;
drop policy if exists "credits select" on credits;
drop policy if exists "credits insert" on credits;
drop policy if exists "credits update" on credits;
drop policy if exists "credits delete" on credits;
create policy "credits select" on credits for select using (has_vehicle_access(vehicle_id));
create policy "credits insert" on credits for insert with check (has_vehicle_access(vehicle_id));
create policy "credits update" on credits for update using (has_vehicle_access(vehicle_id));
create policy "credits delete" on credits for delete using (has_vehicle_access(vehicle_id));

drop policy if exists "own journal select" on journal_entries;
drop policy if exists "own journal insert" on journal_entries;
drop policy if exists "own journal update" on journal_entries;
drop policy if exists "own journal delete" on journal_entries;
drop policy if exists "journal select" on journal_entries;
drop policy if exists "journal insert" on journal_entries;
drop policy if exists "journal update" on journal_entries;
drop policy if exists "journal delete" on journal_entries;
create policy "journal select" on journal_entries for select using (has_vehicle_access(vehicle_id));
create policy "journal insert" on journal_entries for insert with check (has_vehicle_access(vehicle_id));
create policy "journal update" on journal_entries for update using (has_vehicle_access(vehicle_id));
create policy "journal delete" on journal_entries for delete using (has_vehicle_access(vehicle_id));

drop policy if exists "own checklist select" on checklist_items;
drop policy if exists "own checklist insert" on checklist_items;
drop policy if exists "own checklist update" on checklist_items;
drop policy if exists "own checklist delete" on checklist_items;
drop policy if exists "checklist select" on checklist_items;
drop policy if exists "checklist insert" on checklist_items;
drop policy if exists "checklist update" on checklist_items;
drop policy if exists "checklist delete" on checklist_items;
create policy "checklist select" on checklist_items for select using (has_vehicle_access(vehicle_id));
create policy "checklist insert" on checklist_items for insert with check (has_vehicle_access(vehicle_id));
create policy "checklist update" on checklist_items for update using (has_vehicle_access(vehicle_id));
create policy "checklist delete" on checklist_items for delete using (has_vehicle_access(vehicle_id));

drop policy if exists "own favorites select" on favorite_parts;
drop policy if exists "own favorites insert" on favorite_parts;
drop policy if exists "own favorites update" on favorite_parts;
drop policy if exists "own favorites delete" on favorite_parts;
drop policy if exists "favorites select" on favorite_parts;
drop policy if exists "favorites insert" on favorite_parts;
drop policy if exists "favorites update" on favorite_parts;
drop policy if exists "favorites delete" on favorite_parts;
create policy "favorites select" on favorite_parts for select using (has_vehicle_access(vehicle_id));
create policy "favorites insert" on favorite_parts for insert with check (has_vehicle_access(vehicle_id));
create policy "favorites update" on favorite_parts for update using (has_vehicle_access(vehicle_id));
create policy "favorites delete" on favorite_parts for delete using (has_vehicle_access(vehicle_id));

drop policy if exists "own maintenance select" on maintenance_items;
drop policy if exists "own maintenance insert" on maintenance_items;
drop policy if exists "own maintenance update" on maintenance_items;
drop policy if exists "own maintenance delete" on maintenance_items;
drop policy if exists "maintenance select" on maintenance_items;
drop policy if exists "maintenance insert" on maintenance_items;
drop policy if exists "maintenance update" on maintenance_items;
drop policy if exists "maintenance delete" on maintenance_items;
create policy "maintenance select" on maintenance_items for select using (has_vehicle_access(vehicle_id));
create policy "maintenance insert" on maintenance_items for insert with check (has_vehicle_access(vehicle_id));
create policy "maintenance update" on maintenance_items for update using (has_vehicle_access(vehicle_id));
create policy "maintenance delete" on maintenance_items for delete using (has_vehicle_access(vehicle_id));

drop policy if exists "own fuel select" on fuel_logs;
drop policy if exists "own fuel insert" on fuel_logs;
drop policy if exists "own fuel update" on fuel_logs;
drop policy if exists "own fuel delete" on fuel_logs;
drop policy if exists "fuel select" on fuel_logs;
drop policy if exists "fuel insert" on fuel_logs;
drop policy if exists "fuel update" on fuel_logs;
drop policy if exists "fuel delete" on fuel_logs;
create policy "fuel select" on fuel_logs for select using (has_vehicle_access(vehicle_id));
create policy "fuel insert" on fuel_logs for insert with check (has_vehicle_access(vehicle_id));
create policy "fuel update" on fuel_logs for update using (has_vehicle_access(vehicle_id));
create policy "fuel delete" on fuel_logs for delete using (has_vehicle_access(vehicle_id));

drop policy if exists "own notes select" on vehicle_notes;
drop policy if exists "own notes insert" on vehicle_notes;
drop policy if exists "own notes update" on vehicle_notes;
drop policy if exists "own notes delete" on vehicle_notes;
drop policy if exists "notes select" on vehicle_notes;
drop policy if exists "notes insert" on vehicle_notes;
drop policy if exists "notes update" on vehicle_notes;
drop policy if exists "notes delete" on vehicle_notes;
create policy "notes select" on vehicle_notes for select using (has_vehicle_access(vehicle_id));
create policy "notes insert" on vehicle_notes for insert with check (has_vehicle_access(vehicle_id));
create policy "notes update" on vehicle_notes for update using (has_vehicle_access(vehicle_id));
create policy "notes delete" on vehicle_notes for delete using (has_vehicle_access(vehicle_id));

-- Storage bucket for part/journal photos. Private bucket; files are stored under
-- <uploader's user id>/<vehicle id>/<filename>. Access is based on whether you
-- have access to that vehicle (owner or collaborator), not on whose folder it's
-- physically under — so collaborators can see and add photos too.

insert into storage.buckets (id, name, public) values ('vehicle-photos', 'vehicle-photos', false)
  on conflict (id) do nothing;

drop policy if exists "own photos select" on storage.objects;
drop policy if exists "own photos insert" on storage.objects;
drop policy if exists "own photos update" on storage.objects;
drop policy if exists "own photos delete" on storage.objects;
drop policy if exists "shared photos select" on storage.objects;
drop policy if exists "shared photos insert" on storage.objects;
drop policy if exists "shared photos update" on storage.objects;
drop policy if exists "shared photos delete" on storage.objects;
create policy "shared photos select" on storage.objects for select
  using (bucket_id = 'vehicle-photos' and has_vehicle_access(((storage.foldername(name))[2])::uuid));
create policy "shared photos insert" on storage.objects for insert
  with check (bucket_id = 'vehicle-photos' and has_vehicle_access(((storage.foldername(name))[2])::uuid));
create policy "shared photos update" on storage.objects for update
  using (bucket_id = 'vehicle-photos' and has_vehicle_access(((storage.foldername(name))[2])::uuid));
create policy "shared photos delete" on storage.objects for delete
  using (bucket_id = 'vehicle-photos' and has_vehicle_access(((storage.foldername(name))[2])::uuid));
