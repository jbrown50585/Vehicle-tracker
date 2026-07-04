-- Vehicle Project Tracker — Supabase schema
-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste all -> Run

create extension if not exists "pgcrypto";

create table vehicles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  vin text,
  make text not null,
  model text not null,
  year int not null,
  trim text,
  start_date date,
  target_date date,
  created_at timestamptz not null default now()
);

create table phases (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  name text not null,
  budget numeric not null default 0
);

create table parts (
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
  created_at timestamptz not null default now()
);

create table labor (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  date date,
  description text,
  hours numeric not null default 0,
  paid boolean not null default false,
  amount numeric not null default 0
);

create table credits (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  date date,
  amount numeric not null default 0,
  reason text
);

create table journal_entries (
  id uuid primary key default gen_random_uuid(),
  vehicle_id uuid not null references vehicles(id) on delete cascade,
  date date,
  text text not null,
  photo_paths text[] not null default '{}',
  created_at timestamptz not null default now()
);

-- Row Level Security: every user can only ever see/touch their own rows.

alter table vehicles enable row level security;
alter table phases enable row level security;
alter table parts enable row level security;
alter table labor enable row level security;
alter table credits enable row level security;
alter table journal_entries enable row level security;

create policy "own vehicles select" on vehicles for select using (user_id = auth.uid());
create policy "own vehicles insert" on vehicles for insert with check (user_id = auth.uid());
create policy "own vehicles update" on vehicles for update using (user_id = auth.uid());
create policy "own vehicles delete" on vehicles for delete using (user_id = auth.uid());

create policy "own phases select" on phases for select using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own phases insert" on phases for insert with check (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own phases update" on phases for update using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own phases delete" on phases for delete using (vehicle_id in (select id from vehicles where user_id = auth.uid()));

create policy "own parts select" on parts for select using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own parts insert" on parts for insert with check (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own parts update" on parts for update using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own parts delete" on parts for delete using (vehicle_id in (select id from vehicles where user_id = auth.uid()));

create policy "own labor select" on labor for select using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own labor insert" on labor for insert with check (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own labor update" on labor for update using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own labor delete" on labor for delete using (vehicle_id in (select id from vehicles where user_id = auth.uid()));

create policy "own credits select" on credits for select using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own credits insert" on credits for insert with check (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own credits update" on credits for update using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own credits delete" on credits for delete using (vehicle_id in (select id from vehicles where user_id = auth.uid()));

create policy "own journal select" on journal_entries for select using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own journal insert" on journal_entries for insert with check (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own journal update" on journal_entries for update using (vehicle_id in (select id from vehicles where user_id = auth.uid()));
create policy "own journal delete" on journal_entries for delete using (vehicle_id in (select id from vehicles where user_id = auth.uid()));

-- Storage bucket for part/journal photos. Private bucket; files are stored under
-- a path starting with the owning user's id, and the policies below only allow
-- a user to touch objects under their own folder.

insert into storage.buckets (id, name, public) values ('vehicle-photos', 'vehicle-photos', false);

create policy "own photos select" on storage.objects for select
  using (bucket_id = 'vehicle-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own photos insert" on storage.objects for insert
  with check (bucket_id = 'vehicle-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own photos update" on storage.objects for update
  using (bucket_id = 'vehicle-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own photos delete" on storage.objects for delete
  using (bucket_id = 'vehicle-photos' and (storage.foldername(name))[1] = auth.uid()::text);
