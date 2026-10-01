create extension if not exists pgcrypto;

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists categories_name_ci_idx on public.categories (lower(name));

create table if not exists public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  created_at timestamptz not null default now()
);

create unique index if not exists suppliers_name_ci_idx on public.suppliers (lower(name));

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique,
  name text not null,
  category_id uuid references public.categories(id) on delete set null,
  supplier_id uuid references public.suppliers(id) on delete set null,
  unit text not null default 'pcs',
  current_stock integer not null default 0 check (current_stock >= 0),
  min_stock integer not null default 5 check (min_stock >= 0),
  cost_price numeric(14, 2) not null default 0 check (cost_price >= 0),
  selling_price numeric(14, 2) not null default 0 check (selling_price >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists products_name_idx on public.products (name);
create index if not exists products_category_id_idx on public.products (category_id);
create index if not exists products_supplier_id_idx on public.products (supplier_id);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  movement_type text not null check (movement_type in ('IN', 'OUT', 'ADJUST')),
  quantity integer not null check (quantity >= 0),
  stock_before integer not null check (stock_before >= 0),
  stock_after integer not null check (stock_after >= 0),
  note text,
  created_at timestamptz not null default now()
);

alter table public.stock_movements drop constraint if exists stock_movements_product_id_fkey;
alter table public.stock_movements
  add constraint stock_movements_product_id_fkey
  foreign key (product_id) references public.products(id) on delete cascade;

create index if not exists stock_movements_product_created_idx on public.stock_movements (product_id, created_at desc);

create or replace function public.create_product(product_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  new_product public.products;
  category_value text := nullif(btrim(product_data->>'category_name'), '');
  supplier_value text := nullif(btrim(product_data->>'supplier_name'), '');
  category_key uuid;
  supplier_key uuid;
  initial_stock integer := coalesce((product_data->>'initial_stock')::integer, 0);
begin
  if nullif(btrim(product_data->>'sku'), '') is null or nullif(btrim(product_data->>'name'), '') is null then
    raise exception 'SKU dan nama produk wajib diisi.' using errcode = '22023';
  end if;
  if initial_stock < 0 then
    raise exception 'Stok awal tidak boleh negatif.' using errcode = '22023';
  end if;

  if category_value is not null then
    insert into public.categories (name) values (category_value)
    on conflict (lower(name)) do update set name = excluded.name
    returning id into category_key;
  end if;

  if supplier_value is not null then
    insert into public.suppliers (name) values (supplier_value)
    on conflict (lower(name)) do update set name = excluded.name
    returning id into supplier_key;
  end if;

  insert into public.products (
    sku, name, category_id, supplier_id, unit, current_stock, min_stock, cost_price, selling_price
  ) values (
    upper(btrim(product_data->>'sku')),
    btrim(product_data->>'name'),
    category_key,
    supplier_key,
    coalesce(nullif(btrim(product_data->>'unit'), ''), 'pcs'),
    initial_stock,
    coalesce((product_data->>'min_stock')::integer, 5),
    coalesce((product_data->>'cost_price')::numeric, 0),
    coalesce((product_data->>'selling_price')::numeric, 0)
  ) returning * into new_product;

  if initial_stock > 0 then
    insert into public.stock_movements (product_id, movement_type, quantity, stock_before, stock_after, note)
    values (new_product.id, 'IN', initial_stock, 0, initial_stock, 'Stok awal');
  end if;

  return to_jsonb(new_product);
end;
$$;

create or replace function public.delete_product(product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  deleted_id uuid;
begin
  delete from public.products where id = product_id returning id into deleted_id;
  if deleted_id is null then
    raise exception 'Produk tidak ditemukan.' using errcode = 'P0002';
  end if;
  return jsonb_build_object('ok', true, 'product_id', deleted_id);
end;
$$;

create or replace function public.record_stock_movement(movement_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  product_row public.products;
  new_movement public.stock_movements;
  movement_kind text := upper(coalesce(movement_data->>'movement_type', ''));
  movement_quantity integer := (movement_data->>'quantity')::integer;
  next_stock integer;
begin
  if movement_kind not in ('IN', 'OUT', 'ADJUST')
    or movement_quantity is null
    or movement_quantity < 0
    or (movement_kind in ('IN', 'OUT') and movement_quantity = 0) then
    raise exception 'Jenis dan jumlah mutasi tidak valid.' using errcode = '22023';
  end if;

  select * into product_row from public.products
  where id = (movement_data->>'product_id')::uuid
  for update;

  if not found then
    raise exception 'Produk tidak ditemukan.' using errcode = 'P0002';
  end if;

  next_stock := case
    when movement_kind = 'IN' then product_row.current_stock + movement_quantity
    when movement_kind = 'OUT' then product_row.current_stock - movement_quantity
    else movement_quantity
  end;

  if next_stock < 0 then
    raise exception 'Stok tidak mencukupi. Tersedia: %.', product_row.current_stock using errcode = '22023';
  end if;

  update public.products set current_stock = next_stock, updated_at = now()
  where id = product_row.id;

  insert into public.stock_movements (product_id, movement_type, quantity, stock_before, stock_after, note)
  values (product_row.id, movement_kind, movement_quantity, product_row.current_stock, next_stock, nullif(btrim(movement_data->>'note'), ''))
  returning * into new_movement;

  return to_jsonb(new_movement);
end;
$$;

create or replace function public.update_product(product_id uuid, product_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  product_row public.products;
  category_value text := nullif(btrim(product_data->>'category_name'), '');
  supplier_value text := nullif(btrim(product_data->>'supplier_name'), '');
  category_key uuid;
  supplier_key uuid;
begin
  if nullif(btrim(product_data->>'sku'), '') is null or nullif(btrim(product_data->>'name'), '') is null then
    raise exception 'SKU dan nama produk wajib diisi.' using errcode = '22023';
  end if;

  select * into product_row from public.products where id = product_id for update;
  if not found then
    raise exception 'Produk tidak ditemukan.' using errcode = 'P0002';
  end if;

  if category_value is not null then
    insert into public.categories (name) values (category_value)
    on conflict (lower(name)) do update set name = excluded.name
    returning id into category_key;
  end if;

  if supplier_value is not null then
    insert into public.suppliers (name) values (supplier_value)
    on conflict (lower(name)) do update set name = excluded.name
    returning id into supplier_key;
  end if;

  update public.products set
    sku = upper(btrim(product_data->>'sku')),
    name = btrim(product_data->>'name'),
    category_id = category_key,
    supplier_id = supplier_key,
    unit = coalesce(nullif(btrim(product_data->>'unit'), ''), 'pcs'),
    min_stock = coalesce((product_data->>'min_stock')::integer, 5),
    cost_price = coalesce((product_data->>'cost_price')::numeric, 0),
    selling_price = coalesce((product_data->>'selling_price')::numeric, 0),
    updated_at = now()
  where id = product_row.id returning * into product_row;

  return to_jsonb(product_row);
end;
$$;

create or replace function public.update_stock_movement(movement_id uuid, movement_data jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  movement_row public.stock_movements;
  product_row public.products;
  movement_kind text := upper(coalesce(movement_data->>'movement_type', ''));
  movement_quantity integer := (movement_data->>'quantity')::integer;
  next_stock integer;
begin
  select * into movement_row from public.stock_movements where id = movement_id for update;
  if not found then
    raise exception 'Mutasi tidak ditemukan.' using errcode = 'P0002';
  end if;

  select * into product_row from public.products where id = movement_row.product_id for update;
  if exists (
    select 1 from public.stock_movements later
    where later.product_id = movement_row.product_id
      and (later.created_at > movement_row.created_at or (later.created_at = movement_row.created_at and later.id > movement_row.id))
  ) then
    raise exception 'Hanya mutasi terbaru produk yang dapat diedit.' using errcode = '22023';
  end if;
  if product_row.current_stock <> movement_row.stock_after then
    raise exception 'Stok produk sudah berubah; muat ulang data sebelum mengedit.' using errcode = '22023';
  end if;
  if movement_kind not in ('IN', 'OUT', 'ADJUST')
    or movement_quantity is null
    or movement_quantity < 0
    or (movement_kind in ('IN', 'OUT') and movement_quantity = 0) then
    raise exception 'Jenis dan jumlah mutasi tidak valid.' using errcode = '22023';
  end if;

  next_stock := case
    when movement_kind = 'IN' then movement_row.stock_before + movement_quantity
    when movement_kind = 'OUT' then movement_row.stock_before - movement_quantity
    else movement_quantity
  end;
  if next_stock < 0 then
    raise exception 'Stok tidak mencukupi untuk perubahan mutasi.' using errcode = '22023';
  end if;

  update public.products set current_stock = next_stock, updated_at = now() where id = product_row.id;
  update public.stock_movements set
    movement_type = movement_kind,
    quantity = movement_quantity,
    stock_before = movement_row.stock_before,
    stock_after = next_stock,
    note = nullif(btrim(movement_data->>'note'), '')
  where id = movement_row.id returning * into movement_row;

  return to_jsonb(movement_row);
end;
$$;

create or replace function public.delete_stock_movement(movement_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  movement_row public.stock_movements;
  product_row public.products;
begin
  select * into movement_row from public.stock_movements where id = movement_id for update;
  if not found then
    raise exception 'Mutasi tidak ditemukan.' using errcode = 'P0002';
  end if;

  select * into product_row from public.products where id = movement_row.product_id for update;
  if exists (
    select 1 from public.stock_movements later
    where later.product_id = movement_row.product_id
      and (later.created_at > movement_row.created_at or (later.created_at = movement_row.created_at and later.id > movement_row.id))
  ) then
    raise exception 'Hanya mutasi terbaru produk yang dapat dihapus.' using errcode = '22023';
  end if;
  if product_row.current_stock <> movement_row.stock_after then
    raise exception 'Stok produk sudah berubah; muat ulang data sebelum menghapus.' using errcode = '22023';
  end if;

  update public.products set current_stock = movement_row.stock_before, updated_at = now() where id = product_row.id;
  delete from public.stock_movements where id = movement_row.id;
  return jsonb_build_object('ok', true, 'product_id', product_row.id, 'stock_after', movement_row.stock_before);
end;
$$;

alter table public.categories enable row level security;
alter table public.suppliers enable row level security;
alter table public.products enable row level security;
alter table public.stock_movements enable row level security;

revoke all on schema public from anon;
revoke all on public.categories, public.suppliers, public.products, public.stock_movements from anon;
grant usage on schema public to authenticated, service_role;
grant select on public.categories, public.suppliers, public.products, public.stock_movements to authenticated;
grant insert, update, delete on public.categories, public.suppliers to authenticated;
grant usage on schema public to service_role;
grant all on public.categories, public.suppliers, public.products, public.stock_movements to service_role;

drop policy if exists categories_authenticated_access on public.categories;
create policy categories_authenticated_access on public.categories
  for all to authenticated using (true) with check (true);
drop policy if exists suppliers_authenticated_access on public.suppliers;
create policy suppliers_authenticated_access on public.suppliers
  for all to authenticated using (true) with check (true);
drop policy if exists products_authenticated_access on public.products;
create policy products_authenticated_access on public.products
  for all to authenticated using (true) with check (true);
drop policy if exists stock_movements_authenticated_access on public.stock_movements;
create policy stock_movements_authenticated_access on public.stock_movements
  for all to authenticated using (true) with check (true);

revoke all on function public.create_product(jsonb) from public, anon;
revoke all on function public.delete_product(uuid) from public, anon;
revoke all on function public.record_stock_movement(jsonb) from public, anon;
grant execute on function public.delete_product(uuid) to authenticated, service_role;
grant execute on function public.create_product(jsonb) to authenticated, service_role;
grant execute on function public.record_stock_movement(jsonb) to authenticated, service_role;
revoke all on function public.update_product(uuid, jsonb) from public, anon;
revoke all on function public.update_stock_movement(uuid, jsonb) from public, anon;
revoke all on function public.delete_stock_movement(uuid) from public, anon;
grant execute on function public.update_product(uuid, jsonb) to authenticated, service_role;
grant execute on function public.update_stock_movement(uuid, jsonb) to authenticated, service_role;
grant execute on function public.delete_stock_movement(uuid) to authenticated, service_role;
