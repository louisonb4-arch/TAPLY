# TAPLY — Audit d'intégration et de sécurité (8 octobre 2026)

## Décision

**PRÉPRODUCTION EN COURS — NO-GO PRODUCTION.**
Audit technique effectué sur le dépôt de travail `feature/roll-in-love-loyalty-qr-v1`, sans modifier `main`, le site en production ni les paiements.

Cet audit vérifie les protections et interfaces accessibles dans ce dépôt, mais **ne constitue pas un pentest indépendant exhaustif** ni une certification réglementaire. Les conclusions de la certification GitHub n'autorisent pas à déclarer Supabase distant ou Wallet en production opérationnels.

## Preuves recueillies

- Projet CLI lié : Supabase `taply-staging` (réf. `jfkcrpbrdrzwhjtkdmxx`).
- `supabase migration list --linked` : **13 migrations installées à distance sur 21 locales**.
- `supabase db push --dry-run` : exactement les 8 migrations `20261008100001` à `20261008100008` à appliquer ; **aucun SQL poussé**.
- `supabase db lint --linked --schema taply --fail-on error` : **aucune erreur de schéma** pour la version déployée (13 migrations).
- `npm audit --omit=dev` : **0 vulnérabilité connue** des dépendances de production à la date de l'audit.
- `npm run check` : TypeScript + Vitest (résultat exact dans le workflow GitHub associé au commit final).
- Playwright réel en Chromium (desktop 1440, mobile 390) : **22 scénarios PASS** pour session, login, absence de fallback démo, données API mockées, paramètres, rôle staff, anti-XSS, pré-inscription QR public et confirmation manuelle par l'employé. Les réponses API de ces scénarios navigateur sont **simulées**.
- Certification CI PostgreSQL 17 : migrations locales complètes, rôle applicatif RLS, scan/credit/redeem, concurrence, HTTP E2E et lecture client. Voir le run lié à la PR #1.

## Constatations, gravité et traitement

| ID | Gravité | Constat | Mesure / état |
|---|---|---|---|
| A-01 | HAUTE | Ancien `connexion.html` ouvrait le dashboard avec n'importe quel email/mot de passe sans vérifier le serveur | **Corrigé dans la branche** : POST authentifié, échec visible, pas de redirection sans 200. Tests navigateur. Le déploiement public existant ne change pas tant que non déployé. |
| A-02 | HAUTE | Ancien dashboard utilisait localStorage + chiffres fictifs, pouvant tromper l'exploitant | **Corrigé dans la branche** : lecture uniquement depuis API réelle, vérification `auth/me`, vue erreur si preview désactivée, ancien code démo mis hors build public. |
| A-03 | HAUTE | Préproduction Supabase : 8 migrations backend Fidelity absentes, donc parcours réel **non compatible** avec la base hébergée actuelle | **OUVERT** : migrations prévalidées en PG17 local isolé ; mise à jour distante interdite avant sauvegarde/restauration vérifiée. |
| A-04 | HAUTE | Pas de passes natives Apple Wallet/Google Wallet ni de signature et mise à jour garantie en moins de 10 s | **OUVERT** : nécessite comptes émetteurs, certificats et tests physiques. |
| A-05 | HAUTE | Anti-abus de préinscription publique limité à un quota par commerce : épuisement volontaire possible ; pas de WAF/anti-bot complet | **OUVERT** : maintien du flag preview uniquement et NO-GO prod. |
| A-06 | MOYENNE | Pas de vrai scanner caméra NFC, pas de notifications envoyées, pas de preuve d'achat caisse | **OUVERT** : interface distingue les boutons opérationnels des fonctionnalités encore absentes. |
| A-07 | MOYENNE | Cycle RGPD (export/suppression, consentement horodaté, rétention) incomplet | **OUVERT** : exigence préalable au lancement commercial. |
| A-08 | MOYENNE | Pas d'audit offensif indépendant final ni de restauration après panne validée | **OUVERT** : faire un audit autorisé et un exercice de récupération avant production. |
| A-09 | MOYENNE | Ancien rapport `README.md` et runbook affirmaient encore que l'UI était une démo après correction | **Corrigé dans la branche** : docs actualisées, protections et limitations explicites. |
| A-10 | INFORMATION | 0 CVE de dépendances détectée ; insuffisant pour conclure absence de faille applicative | **VÉRIFIÉ** : séparé des tests SQL/auth et du futur pentest. |

## Frontend livré dans la branche

- Connexion réelle et déconnexion via session serveur (cookie HttpOnly, non manipulé par JS).
- Refus des comptes non authentifiés ; ne montre jamais Roll in Love fictif si le backend est indisponible.
- Tableaux programmes/clients (maximum 50)/récompenses, activité employés et anomalies de scans, tous à partir des API RLS.
- `join.html?code=...` : pré-inscription client 10 minutes, aucun passage autonome. Confirmation au comptoir avec code, PIN, présence et achat ; interface de test sans pass Wallet ni scanner caméra. **Pas prête pour un usage commercial**.
- Paramètres fidélité sous code PIN et rôle propriétaire ; activation d'appareils et workflow employé ; saisie manuelle QR **réservée aux tests en attendant scanner physique**.
- Prénoms et champs renvoyés par API échappés avant insertion HTML.
- Aucune clé, PIN ou jeton de session stocké en localStorage ; QR client affiché une seule fois au moment de la création, sans persistance.

## Critère de reprise des migrations Supabase

La tentative `supabase db dump --linked --schema taply` a échoué **uniquement car aucun Docker/Podman n'est installé sur le Mac**. Il n'y a donc actuellement **aucune preuve d'une sauvegarde/restauration utilisable** pour cette opération.

**NE PAS exécuter `supabase db push`** avant :
1. confirmer la cible `taply-staging` (pas production), et vérifier sauvegarde/point de restauration ou export complet des schémas + données ;
2. conserver un moyen testé de revenir en arrière ;
3. revalider le dry-run des 8 fichiers en ordre ;
4. appliquer une seule fois sur staging ;
5. recertifier l'authentification, le tenant RLS, les opérations Fidelity et la mise à jour du dashboard sur la **vraie** base distante ;
6. conserver les secrets de test hors Git et hors des logs.

## Liste des étapes restantes par priorité

1. **Sauvegarde Supabase préproduction et migration des 8 DDL**, puis certification live ; point de blocage actuel.
2. Créer un commerce et compte pilote de test séparés, déployer la PR uniquement en Vercel Preview avec `TAPLY_LOYALTY_PREVIEW=enabled`, en excluant absolument la production ; tester les parcours réels et les rôles owner/staff.
3. Finaliser acquisition client via QR public + anti-bot, scanner par caméra, émission de QR transmis correctement au client, récupération de carte ; tester le nouvel écran de pré-inscription/validation sur tablette et smartphone.
4. Créer les passes natives Apple Wallet et Google Wallet une fois les identifiants / certificats d'émission disponibles ; mesurer les mises à jour et notifications réelles.
5. Tester la puce NFC physique et les protections anti-fraude (copies, transactions successives, client hors-comptoir, collusion employé).
6. Réaliser RGPD, monitoring, sauvegarde/restauration, vérification de SSL enforcement, SMTP et pentest externe avant le go-live.
7. Ne fusionner `main`, activer des paiements ni déployer prod sans contrôle explicite.

**Contact utilisateur nécessaire pour la suite** : moyen de sauvegarde/restauration Supabase, validation des comptes Apple Developer et Google Wallet, smartphones + puces NFC, puis décision de mise en production. Aucun secret ne doit être copié dans la conversation.

## Ce qui n'a pas été fait

- Pas de migration Supabase distante : 13/21 y restent présentes.
- Pas de déploiement ni de changement de `main`.
- Pas de tests sur vrais téléphones, NFC, vrai commerce pilote ou vraie caisse.
- Pas de Wallet signé ou de notification réelle.
- Pas de transaction Stripe ou autre paiement.
