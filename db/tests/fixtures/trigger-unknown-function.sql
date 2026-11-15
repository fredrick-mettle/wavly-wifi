create table t (id int);
create trigger t_trig before update on t for each row execute function nonexistent_fn();
