# Taply — test opérationnel sans paiement (PR draft)

**Date :** 2026-10-08. **Aucun déploiement/aucune migration sur la production.**

## Ce qui est implémenté et testable en environnement isolé

- Connexion commerçant existante via Supabase Auth ; session HttpOnly.
- Invitation d'un appareil approuvé par un propriétaire connecté qui ressaisit
  son mot de passe ; activation sur la session propre de l'employé.
- PIN personnel 6–10 chiffres, `scrypt` + sel + pepper serveur, 5 erreurs
  → verrouillage 15 minutes ; révocation irréversible dans le flux applicatif.
- Inscription **au comptoir par un employé approuvé**, avec prénom,
  consentement, QR Wallet personnel et compteur initial à zéro.
- Lecture de carte par QR, scan du passage, fenêtre de 2 h entre passages,
  vérification des programmes, idempotence, plafonds et verrou SQL.
- Récompense remise une seule fois par cycle, compteur remis à zéro, délai de
  2 h conservé, règle active applicable au prochain cycle seulement.
- Vue agrégée des programmes ; activation/pause ; seuil 3–10 modifiable
  après 30 jours ; indicateur de préférence « notifications ».
- Remplacement d'un QR, invalidation immédiate de l'ancien, journal immuable.
- Tests d'accès inter-commerces et requêtes sans Origin, cookie ou approbation.

## Préparation de l'environnement de test

Ne pas réutiliser une base production ou partagée. Créer et inspecter un
environnement staging isolé, avec rôles `taply_app` et `taply_owner` et migrations
dans l'ordre. Le job GitHub Actions utilise PostgreSQL 17 jetable et n'a
aucun besoin de secrets Supabase. Le test manuel complet, lui, exige de
configurer **dans un staging séparé** des comptes Supabase Auth de test,
leurs liens `taply.merchant_users`, un commerce, un programme et une
version de règles actifs.

Configurer le serveur sans jamais partager les valeurs de :
`DATABASE_URL_APP`, `DATABASE_CA_CERT`, `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY`, `APP_ORIGIN`. Ajouter un pepper aléatoire
privé `TAPLY_STAFF_PIN_PEPPER` (au moins 32 caractères, distinct de CI) et
`TAPLY_LOYALTY_PREVIEW=enabled` uniquement sur le serveur de test.
`APP_ENV=production` refuse systématiquement ces nouvelles routes.

**Ne pas activer** ce flag sur la production. Ne pas exécuter `db:push` vers
Supabase existant sans revue des migrations et de l'environnement cible.

## Séquence de test manuelle — même origine, cookies HttpOnly

Les exemples ci-dessous décrivent les corps JSON des requêtes HTTP.
Chaque mutation est un POST avec `Content-Type: application/json`,
`Origin` **exactement égal à APP_ORIGIN**, cookies gérés par le navigateur,
et `credentials: 'same-origin'` dans `fetch`.

1. `POST /api/auth/login` — email et mot de passe du propriétaire.
   `GET /api/auth/me` doit renvoyer son rôle.
2. `POST /api/loyalty/devices/approve` — `targetMerchantUserId`,
   `ownerEmail`, `ownerPassword`. L'invitation brute expire en cinq
   minutes. Pour tester avec un seul compte, le propriétaire peut
   approuver son propre identifiant `merchant_user` issu du seed.
3. `POST /api/loyalty/devices/activate` — `pairingToken`, `pin`.
   Un cookie `taply_staff_device` HttpOnly est créé. L'activation
   sur un autre compte est refusée.
4. `GET /api/loyalty/overview` — propriétaire, programmes, seuil,
   nombre d'inscrits, cadeaux en attente, options de notification.
5. `POST /api/loyalty/customers/register` — `firstName`,
   `programId`, `privacyAccepted: true`, `customerPresent: true`,
   `idempotencyKey` (UUID), `pin`. Résultat : identifiants et un
   `qrToken` unique. Stocker ce QR uniquement dans la carte remise
   au client, **jamais dans des logs, URLs ou emails non chiffrés**.

   **Variante QR public :** le client envoie `publicToken`, `firstName`,
   `privacyAccepted: true` à `POST /api/loyalty/enrollment/prepare`.
   Il reçoit un `claimToken` de dix minutes, mais aucun passage.
   L'employé connecté et sur appareil approuvé envoie `claimToken`,
   `idempotencyKey`, `pin`, `customerPresent: true`,
   `purchaseConfirmed: true` à `POST /api/loyalty/enrollment/confirm`.
   Cette transaction crée la carte personnelle et crédite le **premier**
   passage, une seule fois. Une tentative répétée est refusée.
6. `POST /api/loyalty/card/status` — `qrToken`, `pin`. Le compteur doit
   être 0 et la récompense non débloquée.
7. `POST /api/loyalty/scan` — `qrToken`, `pin`,
   `purchaseConfirmed: true`, `idempotencyKey` (UUID).
   Le premier passage passe à 1. Rejouer **la même clé** : aucun
   double crédit. Rejouer avec une autre clé immédiatement : refus
   pour cooldown. QR d'un autre marchand : refus générique.
8. Une fois le seuil atteint, `POST /api/loyalty/redeem` —
   `qrToken`, `pin`, `giftHandedOver: true`,
   `expectedCycleNumber`, `idempotencyKey`. Le cadeau ne doit
   être remis qu'une fois ; un second appel distinct est refusé.
9. `POST /api/loyalty/programs/update` — propriétaire seulement ;
   `programId`, `status: active|paused`,
   `notificationsEnabled`, `threshold` facultatif, `pin`.
   Le seuil ne change pas plus souvent que tous les 30 jours et
   ne réécrit pas le cycle de fidélité en cours.
10. `POST /api/loyalty/cards/rotate` — `membershipId`,
    `idempotencyKey`, `customerPresent: true`,
    `identityVerifiedInPerson: true`, `pin`. L'ancien QR
    est immédiatement refusé ; le nouveau fonctionne.
11. `POST /api/loyalty/devices/revoke` — propriétaire,
    `deviceId`, `pin`. Toute nouvelle action avec le cookie
    révoqué échoue.

Ne pas attendre deux heures pour le test automatisé : la
certification PG17 utilise un changement d'horodatage **administrateur
uniquement sur la fixture jetable** afin de simuler l'écoulement du temps.
L'interface normale n'autorise pas de modifier cette date.

## Preuves automatisées

`npm run check` : TypeScript + tests unitaires. Le workflow
`.github/workflows/loyalty-postgres.yml` installe PostgreSQL 17
sur le runner GitHub, exécute toutes les migrations puis lance les
scénarios transactionnels avec `taply_app` non privilégié.

Exiger le PASS GitHub Actions après chaque modification. La PR reste
**draft**, non fusionnable en production.

## Ce qui n'est PAS terminé et bloque une utilisation commerciale

- Le dashboard visuel existant (`dashboard/app.js`) est encore une
  **démo localStorage** : il ne reflète pas les données PostgreSQL.
- Le QR public possède maintenant un flux de **pré-inscription** :
  `POST /api/loyalty/enrollment/prepare` produit un code de 10 minutes
  (maximum 20 inscriptions en attente / 10 minutes par commerce).
  Aucune carte et aucun passage ne sont créés avant
  `POST /api/loyalty/enrollment/confirm` par l'employé autorisé avec PIN,
  appareil approuvé et achat confirmé. Le premier passage est alors crédité
  dans la transaction qui crée la carte. Ce flux reste **preview-only** :
  il manque un challenge anti-bot/WAF fiable en production et la purge
  planifiée des pré-inscriptions expirées (nettoyage actuellement opportuniste).
- Les passes **Apple Wallet/Google Wallet** officielles, l'actualisation
  en moins de dix secondes et les notifications réelles nécessitent les
  comptes, certificats, clés et services adéquats ; le présent backend
  conserve un identifiant QR mais ne crée pas encore les passes natives.
- Le processus de création/révocation des comptes employés dans Supabase
  Auth, les emails transactionnels et le cycle de vie RGPD
  (export/suppression des données, rétention) doivent être terminés.
- Pas d'intégration anti-fraude avec un logiciel de caisse : la case
  « achat confirmé » est une attestation humaine, pas une preuve
  cryptographique de transaction.
- Pas encore de certification offensive DAST/SAST finale, ni de
  validation de charge multi-tenant et de récupération après panne.
- Aucune fonctionnalité de paiement n'est construite ni activée.

Ne jamais présenter un de ces points comme testé en production.
