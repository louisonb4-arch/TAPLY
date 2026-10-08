# Taply — Test réel e-mail, création de compte et connexion (2026-10-08)

## Portée

Projet Supabase **taply-staging** uniquement, URL de préproduction Vercel préexistante.
Compte de test aléatoire sur une boîte e-mail temporaire de réception **Mail.tm**.
Aucun identifiant, PIN, jeton, lien de confirmation ou mot de passe n'est consigné dans ce rapport.
Aucun déploiement en production, aucune migration et aucune modification de `main`.

## Résultats vérifiés en conditions réelles

| Étape | Preuve | Verdict |
|---|---|---|
| Création d'une vraie boîte e-mail de réception | API mail.tm 201, session inbox 200 | PASS |
| Inscription sur Supabase Auth hébergé via `/auth/v1/signup` | HTTP 200, user ID créé, aucune session avant confirmation | PASS |
| Livraison réelle du courriel de confirmation | Boîte reçue : expéditeur `mail.app.supabase.io`, objet « Confirm your email address » | PASS |
| Confirmation e-mail via lien provenant de Supabase | `/auth/v1/verify` HTTP 303 | PASS |
| Connexion Supabase Auth par email + mot de passe | `/auth/v1/token?grant_type=password` HTTP 200, session/access token émis, e-mail confirmé | PASS |
| Création d'un commerce de test et mapping propriétaire | Deux INSERT administratifs **uniquement staging** dans `taply.merchants` et `taply.merchant_users` | PASS (MANUEL, pas self-service) |
| Connexion au Taply **déployé** sur l'URL de staging | `POST /api/auth/login` 200, rôle `owner` | PASS |
| Sécurité cookie session | Cookie `taply_session` présent, Secure + HttpOnly | PASS |
| Vérification identité post-login | `GET /api/auth/me` 200, rôle owner et merchantId attendus | PASS |
| Logout et révocation | `POST /api/auth/logout` 200, puis `GET /api/auth/me` 401 | PASS |

## Problèmes détectés

1. **Inscription de commerce non automatisée.** Le formulaire public Taply ne crée ni commerce ni mapping `merchant_users`. L'inscription fonctionne au niveau Supabase Auth, mais un nouveau compte non rattaché ne peut pas se connecter à Taply. Le mapping a été créé manuellement et provisoirement *pour prouver le backend existant*, pas pour contourner une sécurité.
2. **Après confirmation, Supabase redirige vers `localhost`.** Le lien de vérification a produit HTTP 303 avec une `Location` dont le domaine est `localhost`. Corriger l'URL de retour / configuration Auth pour la vraie origin de staging avant un parcours client public. Aucun jeton de cette redirection n'est enregistré.
3. **Adresse e-mail de test jetable.** Sa réception a fonctionné, mais elle ne convient pas pour un vrai propriétaire, la récupération d'accès ou la production. Utiliser un e-mail durable contrôlé par le commerçant.
4. **Le test a uniquement validé Auth V1.** Les 8 migrations Loyalty manquantes ne sont toujours pas poussées (13/21). Aucune affirmation sur un vrai Wallet, scan NFC, récompense ni notifications.

## Nettoyage vérifié

- Les **sessions Taply de test**, l'enregistrement `taply.merchant_users` et le commerce `taply.merchants` ont été supprimés via une transaction SQL bornée par les identifiants exacts créés durant ce test. Vérification de la base hébergée : **0 merchant, 0 merchant_user, 0 session**.
- **À supprimer manuellement** : l'utilisateur Supabase Auth de test et la boîte mail temporaire. Les opérations de suppression de ces deux comptes externes n'ont pas pu être effectuées avec les outils autorisés, donc leur suppression **n'est pas revendiquée**.
- Compte à retrouver dans **Supabase → Authentication → Users** : adresse du compte QA communiquée dans la conversation, également enregistrée uniquement dans le fichier local privé de test mentionné ci-dessous. Supprimer cet utilisateur après vérification du présent rapport.
- Le matériel de test / identifiants ont été conservés hors dépôt dans un fichier local privé temporaire sur le Mac : `/tmp/taply_mail_auth_qa_20261008.json`. Il doit être effacé une fois le nettoyage terminé. Ne jamais publier ou transmettre son contenu.

## Verdict

**PASS** pour le trajet e-mail réel → confirmation → authentification Supabase → login/logout déployé avec mapping préprovisionné.
**NO-GO** pour une inscription SaaS commerçant autonome, et pour la production, avant correction du provisioning, du redirect, et de la certification des migrations Loyalty sur staging.
