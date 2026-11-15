-- ON CONFLICT arbitrated by a UNIQUE INDEX rather than a table constraint.
create table t (id int primary key, code text not null);
create unique index t_code_idx on t (code);
insert into t (id, code) values (1,'a') on conflict (code) do update set code = excluded.code;
