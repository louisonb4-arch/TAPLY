-- Rôles applicatifs + schéma privé taply.
--
-- taply_owner : NOLOGIN, propriétaire de tous les objets du schéma taply.
-- taply_app   : LOGIN, rôle runtime (Transaction Pooler). Non-propriétaire,
--               NOSUPERUSER, NOBYPASSRLS → toujours soumis à RLS, jamais de
--               bypass implicite.
--
-- Pas de rôle « migrator » séparé. Ownership géré explicitement, sans
-- SET ROLE / RESET ROLE et sans dépendre de CURRENT_USER : `postgres` est
-- le rôle stable et documenté avec lequel le CLI Supabase applique les
-- migrations (mot de passe Dashboard). On lui accorde l'appartenance à
-- taply_owner une fois ici ; chaque migration de table transfère ensuite
-- l'ownership explicitement via ALTER TABLE ... OWNER TO taply_owner —
-- jamais via un changement de rôle courant.
--
-- taply_system : différé. Pas créé ici — aucun besoin réel identifié en
-- Phase 2 ; le créer sans grant ne servirait à rien et ouvrirait une porte
-- qu'on n'a pas encore besoin d'ouvrir.
--
-- Aucun mot de passe dans cette migration. taply_app reste sans mot de
-- passe jusqu'à ce qu'il soit défini plus tard, par une méthode
-- interactive sûre — jamais via le SQL Editor du Dashboard (un mot de
-- passe collé là survit dans l'historique de requêtes). Jamais dans Git,
-- jamais dans un message à une IA/Claude, jamais dans une migration,
-- jamais dans l'historique du SQL Editor.
--
-- On ne touche à aucun attribut des rôles internes Supabase : `postgres`
-- ne fait que recevoir une appartenance à un rôle qu'on vient de créer.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'taply_owner') then
    create role taply_owner nologin;
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'taply_app') then
    create role taply_app login nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end
$$;

-- Déterminisme : que le rôle vienne d'être créé ci-dessus ou qu'il existait
-- déjà (ex. créé manuellement avant cette migration), on réaffirme
-- explicitement l'ensemble des attributs de sécurité attendus. Aucune
-- clause PASSWORD ici : un mot de passe déjà défini sur taply_app n'est
-- jamais touché par cet ALTER ROLE.
alter role taply_owner with nologin nosuperuser nocreatedb nocreaterole nobypassrls noreplication;
alter role taply_app with login nosuperuser nocreatedb nocreaterole nobypassrls noreplication;

grant taply_owner to postgres;

create schema if not exists taply authorization taply_owner;
