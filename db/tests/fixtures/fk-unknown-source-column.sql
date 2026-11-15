create table a (id uuid primary key);
create table b (id uuid primary key);
alter table b add constraint b_a_fk foreign key (nope) references a(id);
