-- Taply onboarding V1 (STAGING): autonome, SEULEMENT après validation email Supabase.
-- Le caller doit fournir un JWT Supabase Auth valide : auth.uid() est la
-- seule source d'identité; aucun authUserId transmis depuis le navigateur.
-- Les tables métier restent privées avec FORCE RLS : pas de GRANT INSERT
-- pour anon/authenticated/taply_app. La fonction est le seul passage borné.
-- À soumettre à audit et protection anti-bot avant usage production.

create function public.taply_complete_merchant_signup_v1()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  user_record record;
  merchant_uuid uuid;
  program_uuid uuid;
  business text;
begin
  if caller is null then
    raise sqlstate '28000' using message='Sign-in required';
  end if;

  -- Empêche deux connexions simultanées du même compte de créer deux commerces.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(caller::text, 20261008));

  select email_confirmed_at, raw_user_meta_data
    into user_record from auth.users where id=caller;
  if not found or user_record.email_confirmed_at is null then
    raise sqlstate '28000' using message='Email confirmation required';
  end if;
  if user_record.raw_user_meta_data->>'taply_onboarding_v1' is distinct from 'true' then
    raise sqlstate '28000' using message='Onboarding not requested';
  end if;

  select merchant_id into merchant_uuid from taply.merchant_users
     where auth_user_id=caller;
  if found then
    -- L'auth user est déjà lié : NE JAMAIS re-provisionner ni activer
    -- un mapping disabled, et ne pas modifier un commerçant existant.
    raise sqlstate '23505' using message='Account already provisioned';
  end if;

  business := pg_catalog.btrim(user_record.raw_user_meta_data->>'taply_business_name');
  if business is null or pg_catalog.char_length(business) < 2 or
     pg_catalog.char_length(business) > 80 or business ~ '[[:cntrl:]]' then
    raise sqlstate '22023' using message='Invalid business name';
  end if;

  insert into taply.merchants (name, slug)
    values (business, 'taply-' || pg_catalog.replace(caller::text, '-', ''))
    returning id into merchant_uuid;

  insert into taply.merchant_users (merchant_id, auth_user_id, role, status)
    values (merchant_uuid, caller, 'owner', 'active');

  insert into taply.loyalty_programs (merchant_id, name, status)
    values (merchant_uuid, 'Carte de fidélité', 'active')
    returning id into program_uuid;

  insert into taply.program_rule_versions
     (merchant_id, program_id, version_no, rules, is_active)
     values (merchant_uuid, program_uuid, 1, '{"threshold":5}'::jsonb, true);

  return merchant_uuid;
end
$$;

revoke all on function public.taply_complete_merchant_signup_v1() from public;
revoke all on function public.taply_complete_merchant_signup_v1() from anon;
grant execute on function public.taply_complete_merchant_signup_v1() to authenticated;
