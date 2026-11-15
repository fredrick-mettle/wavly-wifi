create table t (id int, name text);
insert into t (id, name) values (1,'y') on conflict (name) do nothing;
