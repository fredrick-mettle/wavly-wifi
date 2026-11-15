-- A correct schema. The checker must report ZERO errors here, otherwise it is
-- crying wolf and nobody will read its output when it finds a real bug.
create table sites (
  id   uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint sites_code_ck check (code ~ '^[a-z0-9-]{2,40}$')
);
create or replace function touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end; $$;
create trigger sites_touch before update on sites for each row execute function touch();

create table users (
  id       uuid primary key default gen_random_uuid(),
  site_id  uuid references sites(id) on delete set null,
  phone    text not null unique,
  status   text not null default 'active' check (status in ('active','banned')),
  bytes    bigint not null default 0
);
create index users_site_idx on users (site_id) where status = 'active';
create unique index users_one_active on users (site_id) where status = 'active';

-- circular FK resolved with ALTER after both tables exist
create table orders (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete restrict,
  plan_id uuid,
  total   bigint not null check (total >= 0)
);
create table plans (id uuid primary key, name text not null, price bigint not null);
alter table orders add constraint orders_plan_fk foreign key (plan_id) references plans(id) on delete restrict;

create or replace view v_users as
  select u.id, u.phone, s.name as site from users u left join sites s on s.id = u.site_id;

insert into sites (code, name) values ('nkawie-01', 'Nkawie Main')
on conflict (code) do update set name = excluded.name;
insert into plans (id, name, price) values (gen_random_uuid(), 'Daily', 500);
insert into orders (user_id, plan_id, total) select id, (select id from plans limit 1), 500 from users;
