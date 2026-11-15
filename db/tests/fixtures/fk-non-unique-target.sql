create table a (id uuid primary key, label text not null);
create table b (id uuid primary key, a_label text references a(label));
