# Accueil commerçant — backend V1 (préproduction)

Endpoint : `GET /api/loyalty/home`, protégé par session HttpOnly, propriétaire seulement, `Cache-Control: no-store`.
Même verrou `checkPreview` que les autres routes fidélité : interdit en production.
Exécuté dans `withAuthenticatedTx` ; chaque lecture SQL filtre explicitement `merchant_id` en plus de FORCE RLS.

## Réponse

- `program` : programme actif préféré, sinon premier programme réel, sinon `null`.
- `stats` : nombre **réel** de cartes, visites validées, récompenses en attente, récompenses remises, programmes actifs.
- `onboarding` : 4 états dérivés en lecture seule :
  1. programme actif avec seuil valable ;
  2. au moins un appareil approuvé, non révoqué et non verrouillé ;
  3. première adhésion créée ;
  4. première visite enregistrée dans le ledger.
- `devices` : nombres d'appareils approuvés / utilisables ; `presenterStatus: not_tracked` signifie que le statut du NFC **physique** n'est pas mesuré.
- `recentActivity` : 8 dernières visites / récompenses max ; seulement le type et l'horodatage, pas de PII ni de QR/PIN.
- `capabilities` : envoi effectif de notifications, émission de pass Wallet natif et configuration matérielle NFC explicitement désactivés dans cette V1.

Aucun état d'onboarding n'est mutable depuis le navigateur ; la validation d'une visite exige toujours appareil approuvé + PIN + achat confirmé.
Les sections commerciales sans backend ne doivent pas afficher de statistiques inventées.

## Tests

`npm run check` + navigateur Chromium desktop/mobile simulant des réponses API : état initial, progression, refus d'accès, protection contre les fuites de secrets, absence de débordement.
Aucune migration ni paramètre d'authentification modifié.
