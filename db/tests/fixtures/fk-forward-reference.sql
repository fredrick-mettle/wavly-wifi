create table child (id uuid primary key, parent_id uuid references parent(id));
create table parent (id uuid primary key);
