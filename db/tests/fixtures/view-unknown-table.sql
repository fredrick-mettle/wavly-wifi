create table t (id int);
create or replace view v as select x.id from t x join ghost g on g.id = x.id;
