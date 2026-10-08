-- Création contrôlée du lien d'inscription publique d'un commerçant.
-- Preview uniquement côté API. RLS reste activée et FORCÉE pour les deux
-- tables ; aucun rôle Supabase (anon/authenticated) n'obtient de GRANT.
-- taply_app peut créer l'emplacement et son lien UNIQUEMENT si le contexte
-- transactionnel appartient à un owner authentifié de ce même commerce.
-- L'identity GUC app.auth_user_id est issue de withAuthenticatedTx, jamais du navigateur.

grant insert on taply.locations to taply_app;
grant insert on taply.public_enrollment_links to taply_app;

create policy insert_owner_location on taply.locations
  for insert to taply_app
  with check (
    merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid
    and exists (
      select 1 from taply.merchant_users mu
      where mu.merchant_id = locations.merchant_id
        and mu.auth_user_id = nullif(current_setting('app.auth_user_id', true), '')::uuid
        and mu.role = 'owner' and mu.status = 'active'
    )
  );

-- La lecture tenant est réservée au propriétaire authentifié.
-- La policy SELECT publique originale reste strictement inchangée pour
-- les appels anonymes ; le lien n'est pas énumérable sans session.
create policy select_owner_public_link on taply.public_enrollment_links
  for select to taply_app
  using (
    merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid
    and exists (
      select 1 from taply.merchant_users mu
      where mu.merchant_id = public_enrollment_links.merchant_id
        and mu.auth_user_id = nullif(current_setting('app.auth_user_id', true), '')::uuid
        and mu.role = 'owner' and mu.status = 'active'
    )
  );

create policy insert_owner_public_link on taply.public_enrollment_links
  for insert to taply_app
  with check (
    merchant_id = nullif(current_setting('app.merchant_id', true), '')::uuid
    and exists (
      select 1 from taply.merchant_users mu
      where mu.merchant_id = public_enrollment_links.merchant_id
        and mu.auth_user_id = nullif(current_setting('app.auth_user_id', true), '')::uuid
        and mu.role = 'owner' and mu.status = 'active'
    )
  );

-- Reste sans GRANT UPDATE/DELETE pour taply_app : un employé ne peut ni
-- désactiver un lien, ni falsifier une adresse de destination.
