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
  created_at timestamptz not null default now()
);
alter table vehicles add column if not exists cover_photo_path text;
alter table vehicles add column if not exists vehicle_type text not null default 'project';
alter table vehicles add column if not exists current_mileage int;

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

-- Row Level Security: every user can only ever see/touch their own rows.

alter table vehicles enable row level security;
alter table phases enable row level security;
alter table parts enable row level security;
alter table labor enable row level security;
alter table credits enable row level security;
alter table journal_entries enable row level security;
alter table checklist_items enable row level security;
alter table favorite_parts enable row level security;
alter table maintenance_items enable row level security;
alter table fuel_logs enable row level security;

drop policy if exists "own vehicles select" on vehicles;
drop policy if exists "own vehicles insert" on vehicles;
drop policy if exists "own vehicles update" on vehicles;
drop policy if exists "own vehicles delete" on vehicles;
create policy "own vehicles select" on vehicles for select using (user_id = auth.uid());
create policy "own vehicles insert" on vehicles for insert with check (user_id = auth.uid());
create policy "own vehicles update" on vehicles for update using (user_id = auth.uid());
create policy "own vehicles delete" on vehicles for delete using (user_id = auth.uid());

drop policy if exists "own phases select" on phases;
drop policy if exists "own phases insert" on phases;
drop policy if exists "own phases update" on phases;
drop policy if exists "own phases delete" on phases;
create policy "own phases select" on phases for select using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own phases insert" on phases for insert with check (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own phases update" on phases for update using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own phases delete" on phases for delete using (vehicle_id in (select id from vehicles where user_id = auth.uid()));

drop policy if exists "own parts select" on parts;
drop policy if exists "own parts insert" on parts;
drop policy if exists "own parts update" on parts;
drop policy if exists "own parts delete" on parts;
create policy "own parts select" on parts for select using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own parts insert" on parts for insert with check (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own parts update" on parts for update using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own parts delete" on parts for delete using (vehicle_id in (select id from vehicles where user_id = auth.uid()));

drop policy if exists "own labor select" on labor;
drop policy if exists "own labor insert" on labor;
drop policy if exists "own labor update" on labor;
drop policy if exists "own labor delete" on labor;
create policy "own labor select" on labor for select using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own labor insert" on labor for insert with check (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own labor update" on labor for update using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own labor delete" on labor for delete using (vehicle_id in (select id from vehicles where user_id = auth.uid()));

drop policy if exists "own credits select" on credits;
drop policy if exists "own credits insert" on credits;
drop policy if exists "own credits update" on credits;
drop policy if exists "own credits delete" on credits;
create policy "own credits select" on credits for select using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own credits insert" on credits for insert with check (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own credits update" on credits for update using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own credits delete" on credits for delete using (vehicle_id in (select id from vehicles where user_id = auth.uid()));

drop policy if exists "own journal select" on journal_entries;
drop policy if exists "own journal insert" on journal_entries;
drop policy if exists "own journal update" on journal_entries;
drop policy if exists "own journal delete" on journal_entries;
create policy "own journal select" on journal_entries for select using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own journal insert" on journal_entries for insert with check (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own journal update" on journal_entries for update using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own journal delete" on journal_entries for delete using (vehicle_id in (select id from vehicles where user_id = auth.uid()));

drop policy if exists "own checklist select" on checklist_items;
drop policy if exists "own checklist insert" on checklist_items;
drop policy if exists "own checklist update" on checklist_items;
drop policy if exists "own checklist delete" on checklist_items;
create policy "own checklist select" on checklist_items for select using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own checklist insert" on checklist_items for insert with check (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own checklist update" on checklist_items for update using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own checklist delete" on checklist_items for delete using (vehicle_id in (select id from vehicles where user_id = auth.uid()));

drop policy if exists "own favorites select" on favorite_parts;
drop policy if exists "own favorites insert" on favorite_parts;
drop policy if exists "own favorites update" on favorite_parts;
drop policy if exists "own favorites delete" on favorite_parts;
create policy "own favorites select" on favorite_parts for select using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own favorites insert" on favorite_parts for insert with check (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own favorites update" on favorite_parts for update using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own favorites delete" on favorite_parts for delete using (vehicle_id in (select id from vehicles where user_id = auth.uid()));

drop policy if exists "own maintenance select" on maintenance_items;
drop policy if exists "own maintenance insert" on maintenance_items;
drop policy if exists "own maintenance update" on maintenance_items;
drop policy if exists "own maintenance delete" on maintenance_items;
create policy "own maintenance select" on maintenance_items for select using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own maintenance insert" on maintenance_items for insert with check (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own maintenance update" on maintenance_items for update using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own maintenance delete" on maintenance_items for delete using (vehicle_id in (select id from vehicles where user_id = auth.uid()));

drop policy if exists "own fuel select" on fuel_logs;
drop policy if exists "own fuel insert" on fuel_logs;
drop policy if exists "own fuel update" on fuel_logs;
drop policy if exists "own fuel delete" on fuel_logs;
create policy "own fuel select" on fuel_logs for select using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own fuel insert" on fuel_logs for insert with check (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own fuel update" on fuel_logs for update using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own fuel delete" on fuel_logs for delete using (vehicle_id in (select id from vehicles where user_id = auth.uid()));

-- Storage bucket for part/journal photos. Private bucket; files are stored under
-- a path starting with the owning user's id, and the policies below only allow
-- a user to touch objects under their own folder.

insert into storage.buckets (id, name, public) values ('vehicle-photos', 'vehicle-photos', false)
  on conflict (id) do nothing;

drop policy if exists "own photos select" on storage.objects;
drop policy if exists "own photos insert" on storage.objects;
drop policy if exists "own photos update" on storage.objects;
drop policy if exists "own photos delete" on storage.objects;
create policy "own photos select" on storage.objects for select
  using (bucket_id = 'vehicle-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own photos insert" on storage.objects for insert
  with check (bucket_id = 'vehicle-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own photos update" on storage.objects for update
  using (bucket_id = 'vehicle-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own photos delete" on storage.objects for delete
  using (bucket_id = 'vehicle-photos' and (storage.foldername(name))[1] = auth.uid()::text);
