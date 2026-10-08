-- QR V1 provisioning. This migration is intentionally additive and stages all QR links
-- as inactive until the merchant explicitly publishes a complete program.
--
-- The trigger is SECURITY DEFINER because original table grants remain read-only
-- for taply_app; no public caller can choose a merchant ID or QR token.
create function taply.provision_program_enrollment_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  location_uuid uuid;
  token_text text;
begin
  -- Stable primary location per merchant; new merchant has none.
  insert into taply.locations (merchant_id, name, slug, status)
    select new.merchant_id, m.name, 'principal', 'active'
      from taply.merchants m where m.id=new.merchant_id
    on conflict (merchant_id, slug) do nothing;
  select id into location_uuid from taply.locations
    where merchant_id=new.merchant_id and slug='principal';
  if location_uuid is null then
    raise sqlstate 'P0001' using message='Location provisioning failed';
  end if;

  -- Two independent random UUID v4 values, encoded as base64url and
  -- truncated to 24 bytes. >=180 bits of effective random entropy.
  -- No dependency on pgcrypto extension/schema.
  token_text := pg_catalog.substr(pg_catalog.translate(
    pg_catalog.encode(pg_catalog.decode(
      pg_catalog.replace(pg_catalog.gen_random_uuid()::text,'-','') ||
      pg_catalog.replace(pg_catalog.gen_random_uuid()::text,'-',''), 'hex'), 'base64'),
    '+/', '-_'), 1, 32);
  insert into taply.public_enrollment_links
      (public_token, merchant_id, location_id, program_id, status)
    select token_text, new.merchant_id, location_uuid, new.id, 'inactive'
    where not exists (
      select 1 from taply.public_enrollment_links
      where merchant_id=new.merchant_id and program_id=new.id
    );
  return new;
end
$$;

revoke all on function taply.provision_program_enrollment_v1() from public;
revoke all on function taply.provision_program_enrollment_v1() from anon;
revoke all on function taply.provision_program_enrollment_v1() from authenticated;

create trigger provision_program_enrollment_v1
  after insert on taply.loyalty_programs
  for each row execute function taply.provision_program_enrollment_v1();

-- Existing merchants are backfilled without modifying any existing QR token.
-- This occurs inside the migration transaction and is idempotent.
insert into taply.locations (merchant_id, name, slug, status)
  select m.id, m.name, 'principal', 'active'
  from taply.merchants m
  where exists (select 1 from taply.loyalty_programs p where p.merchant_id=m.id)
  on conflict (merchant_id, slug) do nothing;

insert into taply.public_enrollment_links
    (public_token, merchant_id, location_id, program_id, status)
select pg_catalog.substr(pg_catalog.translate(
         pg_catalog.encode(pg_catalog.decode(
           pg_catalog.replace(pg_catalog.gen_random_uuid()::text,'-','') ||
           pg_catalog.replace(pg_catalog.gen_random_uuid()::text,'-',''), 'hex'), 'base64'),
         '+/', '-_'), 1, 32), p.merchant_id, l.id, p.id, 'inactive'
  from taply.loyalty_programs p
  join taply.locations l on l.merchant_id=p.merchant_id and l.slug='principal'
 where not exists (
   select 1 from taply.public_enrollment_links old
   where old.merchant_id=p.merchant_id and old.program_id=p.id
 );

-- Owner-only API runs as taply_app under a verified tenant session.
-- Separate SELECT policy allows retrieving only the tenant's own QR link.
create policy public_token_owner_lookup on taply.public_enrollment_links
  for select to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);

grant update (status, updated_at) on taply.public_enrollment_links to taply_app;
create policy public_link_update_tenant on taply.public_enrollment_links
  for update to taply_app
  using (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid)
  with check (merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid);
