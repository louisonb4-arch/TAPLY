-- Rôles applicatifs + schéma privé taply.
--
-- taply_owner : NOLOGIN, propriétaire de tous les objets du schéma taply.
-- taply_app   : LOGIN, rôle runtime (Transaction Pooler). Non-propriétaire,
--               NOSUPERUSER, NOBYPASSRLS → toujours soumis à RLS, jamais de
--               bypass implicite.
--
-- Pas de rôle « migrator » séparé. Le CLI Supabase applique les migrations
-- avec son propre rôle (`postgres` sur le projet géré — CREATEROLE, mais
-- PAS SUPERUSER). PostgreSQL refuse qu'un rôle CREATEROLE non-superuser
-- NOMME EXPLICITEMENT les attributs SUPERUSER/REPLICATION/BYPASSRLS dans
-- un ALTER ROLE — même pour les réaffirmer à leur valeur par défaut
-- (confirmé empiriquement : « Only roles with the SUPERUSER attribute may
-- alter roles with the SUPERUSER attribute », SQLSTATE 42501, sur un
-- simple `ALTER ROLE ... NOSUPERUSER`). Par prudence, ces trois attributs
-- ne sont nommés EXPLICITEMENT nulle part ici non plus en CREATE ROLE —
-- ce sont déjà les défauts PostgreSQL pour un rôle neuf, et on vérifie
-- ensuite par une simple lecture de pg_roles (jamais par un second ALTER
-- ROLE) que c'est bien le cas. NOCREATEDB/NOCREATEROLE ne sont pas dans
-- cette catégorie restreinte et peuvent être nommés sans risque.
--
-- Principe pour un rôle déjà existant : VERIFY, DON'T SILENTLY REPAIR.
-- Si taply_owner/taply_app existent déjà avec des attributs inattendus,
-- la migration échoue explicitement (RAISE EXCEPTION) plutôt que de
-- tenter une réparation automatique.
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
-- ne fait que recevoir une appartenance explicite à un rôle qu'on vient
-- de créer, avec SET TRUE (nécessaire pour CREATE SCHEMA ... AUTHORIZATION
-- et ALTER TABLE ... OWNER TO dans les migrations suivantes) et INHERIT
-- FALSE (postgres n'hérite jamais ambiante des privilèges de taply_owner
-- en dehors de ces opérations de propriété — pas de SET ROLE explicite
-- nécessaire, PostgreSQL vérifie l'option SET de l'appartenance lui-même).

do $$
declare
  existing record;
begin
  select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    into existing
    from pg_roles where rolname = 'taply_owner';

  if existing is null then
    create role taply_owner nologin nocreatedb nocreaterole;
  elsif existing.rolcanlogin or existing.rolsuper or existing.rolcreatedb
     or existing.rolcreaterole or existing.rolreplication or existing.rolbypassrls then
    raise exception
      'taply_owner existe déjà avec des attributs inattendus (rolcanlogin=%, rolsuper=%, rolcreatedb=%, rolcreaterole=%, rolreplication=%, rolbypassrls=%) — vérification manuelle requise avant de rejouer cette migration',
      existing.rolcanlogin, existing.rolsuper, existing.rolcreatedb, existing.rolcreaterole, existing.rolreplication, existing.rolbypassrls;
  end if;
end
$$;

do $$
declare
  existing record;
begin
  select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
    into existing
    from pg_roles where rolname = 'taply_app';

  if existing is null then
    create role taply_app login nocreatedb nocreaterole;
  elsif not existing.rolcanlogin or existing.rolsuper or existing.rolcreatedb
     or existing.rolcreaterole or existing.rolreplication or existing.rolbypassrls then
    raise exception
      'taply_app existe déjà avec des attributs inattendus (rolcanlogin=%, rolsuper=%, rolcreatedb=%, rolcreaterole=%, rolreplication=%, rolbypassrls=%) — vérification manuelle requise avant de rejouer cette migration',
      existing.rolcanlogin, existing.rolsuper, existing.rolcreatedb, existing.rolcreaterole, existing.rolreplication, existing.rolbypassrls;
  end if;
end
$$;

-- Appartenance explicite, pas d'héritage ambiant : postgres peut SET ROLE
-- taply_owner implicitement (via l'option SET) le temps des opérations de
-- propriété (CREATE SCHEMA ... AUTHORIZATION, ALTER TABLE ... OWNER TO),
-- jamais au-delà. taply_app ne reçoit cette appartenance ni aucune autre.
grant taply_owner to postgres with set true, inherit false;

create schema if not exists taply authorization taply_owner;
