-- Défense en profondeur : même si la Data API était réactivée par erreur,
-- aucun rôle Data API n'a de chemin de GRANT vers le schéma taply.
-- service_role contourne RLS par défaut sur Supabase ; en lui retirant tout
-- accès au schéma, il n'a tout simplement pas de chemin pour y entrer.
revoke all on schema taply from public;
revoke all on schema taply from anon;
revoke all on schema taply from authenticated;
revoke all on schema taply from service_role;

grant usage on schema taply to taply_app;
grant usage on schema taply to taply_owner;
