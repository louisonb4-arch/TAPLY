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
-- est notre rôle administratif/migration (CREATEROLE, pas SUPERUSER) ;
-- `taply_owner` est NOLOGIN et propriétaire de tous les objets métier.
--
-- `postgres` reçoit une appartenance explicite à `taply_owner` :
--   - SET TRUE     : nécessaire pour CREATE SCHEMA ... AUTHORIZATION et
--                    ALTER TABLE ... OWNER TO dans cette migration et les
--                    suivantes — aucun SET ROLE explicite n'est écrit
--                    nulle part, PostgreSQL vérifie l'option SET lui-même.
--   - INHERIT TRUE : pour que postgres continue, SANS SET ROLE explicite,
--                    à pouvoir CREATE des tables dans le schéma taply
--                    (propriété de taply_owner), référencer/modifier des
--                    objets déjà possédés par taply_owner (FK, index) et
--                    poursuivre les migrations suivantes sur ces mêmes
--                    objets. Sans INHERIT TRUE, la seule capacité SET
--                    n'accorde pas automatiquement les privilèges objets
--                    de taply_owner à la session postgres — risque direct
--                    de 42501 dans toute migration ultérieure qui touche
--                    un objet déjà transféré à taply_owner.
--
-- PostgreSQL accorde EN PLUS, automatiquement, à tout rôle CREATEROLE
-- non-superuser qui crée un nouveau rôle (ici `postgres` créant
-- `taply_owner`), une appartenance ADMIN TRUE sur ce rôle nouvellement
-- créé — documenté, pas une fuite. Notre GRANT explicite ci-dessous ne
-- mentionne pas ADMIN : il ne fait que préciser SET et INHERIT, sans
-- toucher à l'ADMIN déjà accordé automatiquement. On n'affirme donc
-- JAMAIS que `postgres` a ADMIN FALSE sur `taply_owner` — l'inverse est
-- vrai et documenté ici explicitement.
--
-- Ceci N'EST PAS une frontière de sécurité runtime : `postgres` est le
-- rôle de migration, pas le rôle applicatif. La frontière qui compte est
-- ailleurs, et reste intacte : `taply_app` ne reçoit AUCUNE appartenance
-- à `taply_owner`, ni à aucun autre rôle privilégié — voir plus bas.

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

-- taply_app ne reçoit cette appartenance ni aucune autre appartenance
-- privilégiée — c'est la frontière de sécurité runtime qui compte.
grant taply_owner to postgres with set true, inherit true;

create schema if not exists taply authorization taply_owner;
