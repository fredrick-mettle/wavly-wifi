create table t (id int);
create index t_bad on t (missing_col);
