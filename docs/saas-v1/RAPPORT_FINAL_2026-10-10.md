# Taply SaaS V1 — rapport final de mission (10 oct. 2026)

Branche `feat/taply-saas-v1-20261009` (dépôt `louisonb4-arch/TAPLY`), non fusionnée dans `main`.
Préproduction (staging) : https://taply-staging-louisondu44000-7822.vercel.app — base Supabase `taply-staging` (`jfkcrpbrdrzwhjtkdmxx`).
**La production n'a pas été touchée** : `taply-theta.vercel.app` sert toujours le site vitrine ; aucune base de production n'existe.

Règle appliquée partout : une fonctionnalité n'est dite « opérationnelle » que si elle a été testée ; les résultats ci-dessous sont ceux réellement obtenus.

---

## 1. Matrice d'état

| Domaine | État | Preuve |
|---|---|---|
| Inscription / connexion commerçant (Supabase Auth, cookie de session opaque) | Opérationnel | E2E PGlite, smoke staging, recette réelle antérieure (e-mail réel) |
| Mot de passe oublié / réinitialisation / renvoi de confirmation | Opérationnel en code | E2E ; recette réelle à faire (`RECETTE_STAGING.md` §1.6) |
| Assistant de démarrage (5 étapes : commerce, seuil 3–10, récompenses, couleurs, publication) | Opérationnel | E2E + navigateur (banc local) |
| Contrat versionné, changement ≤ 1 fois / 30 jours, cycles en cours conservés | Opérationnel | E2E + PostgreSQL 17 réel (trigger `contract_locked`) |
| Carte client anonyme (aucune donnée personnelle), plusieurs cartes / commerces | Opérationnel | E2E + navigateur |
| Code de secours (haché, usage unique, limité en débit, révocable) | Opérationnel | E2E (11e/12e essai → 429) |
| Mode A : QR personnel validé au comptoir (scanner caméra réel, jsQR) | Opérationnel | Navigateur (décodage réel), E2E |
| Mode B : NFC NTAG 424 DNA SUN, crédit dès le premier passage | Opérationnel côté serveur | 72 tests crypto (vecteurs NXP), smoke staging avec la vraie clé de staging ; **aucune puce réelle testée** |
| Délai de 2 h par carte et par commerce, horloge base, commun QR/NFC | Opérationnel | E2E, PG17 réel (6 lectures concurrentes → 1 passage) |
| Aucun GET ne crédite | Opérationnel | Smoke staging (route GET absente → 404) |
| Récompenses multiples, choix client, remise confirmée, nouveau cycle, historique | Opérationnel | E2E + navigateur + PG17 (remises concurrentes → 1) |
| Tableau de bord (statistiques réelles, clients, récompenses, supports, abonnement) | Opérationnel | Navigateur (desktop + mobile) ; aucune statistique fictive |
| Abonnement Stripe 20 €/mois (Checkout, webhooks signés, portail, statuts) | **Opérationnel en staging, mode Test** | Paiement réel en mode Test le 10 oct. (voir §5) |
| Outil de programmation NTAG 424 (plan, NDEF, EV2, clés) | Prêt, vérifié hors ligne | 92 tests (vecteurs AN12196 octet pour octet, puce simulée) ; transport lecteur PC/SC non écrit (matériel absent) |
| Apple / Google Wallet | Préparé, non livré | `WALLET_ET_NOTIFICATIONS.md` (comptes développeur requis) |
| Notifications Web Push | Préparé, non livré | File `notification_outbox` alimentée et dédoublonnée ; envoi non actif (clés VAPID, tâche planifiée) |
| Invitations d'employés (comptes distincts) | Non livré | Rôle `staff` en base, pas de parcours |

## 2. Ce qui a été fait

- **Audit initial** et réconciliation d'une dérive de schéma sur staging (migration `100001`).
- **Moteur de fidélité unifié** (`creditVisitAsActor`) pour QR comptoir et NFC : verrous `FOR UPDATE`, idempotence en base, horloge de la base, file de notifications dans la même transaction.
- **Contrat de programme versionné** (`program_rule_versions.rules`), verrou 30 jours applicatif + trigger, réclamations de récompense (`reward_claims`), journal de remise avec la récompense choisie.
- **Identités clients anonymes** (cookie + nonce, sessions hachées, adhésions), code de secours, limitation de débit (`public_rate_buckets`).
- **NFC NTAG 424 DNA** : AES-CMAC (RFC 4493), déchiffrement PICCData, MAC de session SDM, clés diversifiées par UID (HKDF), anti-rejeu atomique par compteur, appairage par première lecture valide, contrôles de vélocité, désactivation / signalement / remplacement d'une puce.
- **Facturation Stripe** : client HTTP minimal (version d'API figée `2026-09-30.endive`), vérification HMAC des webhooks (tolérance 300 s), état toujours relu par l'API, dédoublonnage `stripe_events`, politique d'accès `full / grace / setup_only / read_only`, refus des doublons d'abonnement.
- **Interface** : tableau de bord commerçant complet (dont scanner caméra), carte client, page de tap NFC `/t`, pages mot de passe oublié / réinitialisation.
- **Outil de programmation NTAG 424** et procédure opérateur (`docs/nfc/NTAG424_PROVISIONING.md`).
- **Revue Stripe** (bonnes pratiques officielles) : pas de `payment_method_types`, exécution sur webhooks signés, clés d'idempotence, clé **restreinte** recommandée ; nettoyage des espaces collés dans les variables et diagnostic sans fuite.

## 3. Migrations

Exécutées sur **staging uniquement** (`supabase db push`, après sauvegarde logique JSON de toutes les tables dans `../taply-staging-audit-backups/pre-saas-v1-2026-10-09/`, droits 700/600) :

| Migration | Contenu |
|---|---|
| `20261009100001_reconcile_staging_drift` | Réconciliation de la dérive staging, suppression des politiques pilotes |
| `20261009100002_program_contract_and_rewards` | Contrat versionné, verrou 30 jours, `reward_claims`, ville, expiration des jetons QR, déverrouillage d'appareil |
| `20261009100003_customer_identities` | Identités anonymes, sessions, adhésions, compteurs de débit |
| `20261009100004_nfc_tags` | Puces, appairages, journal des taps, contrainte d'acteur du journal de passages |
| `20261009100005_billing_and_notifications` | Abonnements, événements Stripe, abonnements push, file de notifications |

Après migration : 36 tables `taply`, RLS activée **et forcée** sur 36/36, données existantes intactes, `db lint` sans erreur, advisors sans ERROR.
Retour arrière d'urgence (destructif, **non exécuté**) : `supabase/rollback/20261009_saas_v1_down.sql`.

## 4. Services connectés

| Service | Environnement | État |
|---|---|---|
| Vercel (projet `taply`) | Preview / staging | Déploiement `taply-pxsynh21w` derrière l'alias staging |
| Supabase `taply-staging` | Staging | PostgreSQL 17, rôle applicatif `taply_app` sans BYPASSRLS |
| Stripe, compte « taply » (`acct_1UOwPoA2Tvsebt17`), **mode Test** | Staging | Produit + prix 20 €/mois, webhook (12 événements), portail, clé restreinte (4 autorisations) ; bas de page « TVA non applicable, art. 293 B du CGI » |
| GitHub Actions | Branche | Certification PostgreSQL 17 à chaque push |

Variables Preview présentes (valeurs jamais affichées) : `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `TAPLY_BILLING_MODE=enforced`, `TAPLY_NFC_MASTER_KEY`, `TAPLY_STAFF_PIN_PEPPER`, plus les variables existantes.

## 5. Tests et résultats

| Suite | Résultat |
|---|---|
| `npm run check` (types + unitaires + intégration, dont E2E SaaS PGlite 14 scénarios) | **729 / 729** (45 fichiers) |
| Certification PostgreSQL 17.10 réel (`db:loyalty:cert`, concurrence, RLS) | **36 / 36** |
| GitHub Actions (PostgreSQL 17 isolé) | Succès sur le dernier commit de code `3e73896` (run 38043690957) et les 4 précédents |
| Smoke staging (`STAGING_STRIPE=configured`) | **24 / 24** : pages, portes d'API, CSRF, GET NFC inerte, webhook non signé / mal signé → 401, SUN authentique / falsifié / autre clé |
| NFC hors ligne | 164 tests : vecteurs RFC 4493 et NXP AN12196 reproduits octet pour octet, parcours sur puce simulée |
| Parcours navigateur complet (banc local) | Réussi : assistant, carte 0/4, QR décodé par la caméra, validation, délai 2 h, appairage NFC, NFC après QR refusé (délai), rejeu « Déjà enregistré », choix de récompense, remise, cycle 2, vues mobiles |
| **Paiement Stripe réel en mode Test** (carte 4242 saisie par le titulaire) | Abonnement Stripe actif 20 €/mois ; en base `active`, bon prix, fin de période 10 nov. 2026 ; 4 événements reçus et appliqués **une fois chacun** ; aucun doublon |

Non testé : vraies puces et lecteurs NFC, téléphones réels sur staging (recette manuelle), échec de renouvellement / résiliation / renvoi d'événement Stripe, charge élevée.

## 6. Problèmes corrigés en cours de mission (sélection)

- Dérive de schéma staging ≠ dépôt → migration de réconciliation.
- `SELECT … FOR UPDATE` invisible sous RLS sur `customer_identities` → verrou consultatif + lecture simple.
- Statistiques du tableau de bord figées après navigation → rechargement par vue.
- Lectures NFC concurrentes avec compteurs obsolètes → refus `replay` attendu et testé.
- Variables Stripe : espaces collés tolérés, journal indiquant la variable fautive sans sa valeur ; version d'API alignée sur le compte (`endive`).
- Une quinzaine de défauts d'interface relevés en revue navigateur (chevauchements, débordements, libellés, accessibilité des interrupteurs, ordre mobile).

## 7. Limites de sécurité connues

Détail dans `docs/saas-v1/SECURITY.md`. Principales :
1. NFC : SUN prouve qu'une puce authentique a produit l'URL, pas que le téléphone est au comptoir ; une URL capturée non consommée reste utilisable jusqu'à une lecture plus récente (atténuations : délai 2 h, vélocité, désactivation en un clic).
2. Une puce programmée **non appairée** peut être appairée par n'importe quel commerçant ayant une URL non consommée : appairer dès l'installation.
3. Perte d'identité client sans code de secours.
4. Fraude interne (employé sur appareil approuvé) détectable seulement au journal.
5. Limitation de débit par IP (IP partagées), pas de WAF / anti-robot.
6. Advisors Supabase : `auth_rls_initplan` (performance), protection des mots de passe divulgués **désactivée**.
7. Pas de PITR vérifié ni de `pg_dump` sur staging ; aucun test d'intrusion externe.

## 8. Déploiements et versions

| Élément | Valeur |
|---|---|
| Staging actuel | `taply-pxsynh21w-louisondu44000-7822.vercel.app` (alias `taply-staging-…`) |
| Cible de retour arrière staging | `taply-phywngggb` (même code sans le diagnostic Stripe), puis `taply-bejj6cq25`, puis `taply-lgy5dc9x4` (avant SaaS V1) |
| Production | Inchangée (`taply-theta.vercel.app`) |
| Dernier commit | voir `git log` de la branche (rapport rédigé après `e08554d`) |

## 9. Blocages nécessitant une intervention humaine

1. **Décision produit en cours : paiement avant création de compte** (demande du titulaire le 10 oct.) — conception proposée, à valider avant développement.
2. Recette manuelle sur vrais téléphones (`RECETTE_STAGING.md`) et URL de redirection Supabase pour la réinitialisation du mot de passe.
3. Activer la protection des mots de passe divulgués (Supabase → Authentication).
4. Stripe : compléter les informations d'entreprise (nom + « EI », adresse, SIRET) ; recette §6.3–6.5 ; refaire produit, webhook, portail, clé restreinte et bas de page **en mode production** le moment venu.
5. Choisir le **domaine de production définitif** (il est gravé dans les puces).
6. Réception des puces NTAG 424 DNA et d'un lecteur PC/SC (ACR1252U ou équivalent) ; écrire le transport PC/SC.
7. Mise en production : projet Supabase de production (plan avec PITR), `TAPLY_PRODUCTION_RELEASE=v1-approved`, fusion dans `main`, **sur accord explicite uniquement**.
8. Wallet / notifications : comptes Apple Developer et Google Wallet, clés VAPID.

## 10. Programmer les NTAG 424 DNA à réception (résumé)

Procédure complète : `docs/nfc/NTAG424_PROVISIONING.md`.

1. **Contrôler une puce** (TagInfo) : NTAG 424 DNA, UID 7 octets commençant par `04` ; réglages du fichier 02 = `0000E0EE000100` ; authentification clé 0 usine (`00…00`) acceptée. Sinon : ne rien forcer, contacter le fournisseur.
2. **Préparer le secret maître** sur le poste (fichier `~/.config/taply/nfc-master-v1.hex`, droits 600, même valeur que `TAPLY_NFC_MASTER_KEY` de l'environnement visé ; `--key-version` = `TAPLY_NFC_KEY_VERSION`).
3. **Générer le plan** : `node --import ./scripts/dev-ts-hooks.mjs scripts/nfc/provision.ts --uid <UID> --host <domaine> --master-file <fichier> --key-version 1` (ajouter `--show-keys` seulement dans un terminal, pour une saisie manuelle).
4. **Programmer** (NXP TagXplorer en attendant le transport PC/SC) dans un lieu maîtrisé : écrire le NDEF, `ChangeFileSettings` (SDM, offsets affichés), `ChangeKey` 1→4 puis **clé 0 en dernier**.
5. **Vérifier au téléphone** : deux taps = deux URL différentes ; la page `/t` doit dire « Présentoir non reconnu » (puce authentique, pas encore appairée).
6. **Appairer** : tableau de bord → QR & NFC → « Associer une puce » → taper la puce dans les 10 minutes avec le téléphone du propriétaire connecté.
7. **Première puce = test** (idéalement sur staging : `--host taply-staging-louisondu44000-7822.vercel.app` + clé de staging), 20 taps d'affilée, puis seulement le lot.
