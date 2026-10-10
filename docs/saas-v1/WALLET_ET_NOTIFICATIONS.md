# Apple Wallet, Google Wallet et notifications — état et plan

Priorité respectée : la carte web responsive est complète et autonome. Rien ci-dessous ne bloque le produit.

## Deux scénarios à ne pas confondre

1. **Téléphone → présentoir NTAG 424 DNA** (implémenté) : le téléphone lit la puce, ouvre `/t?e&c`, le serveur vérifie la preuve SUN et crédite. Fonctionne sans application sur les iPhone (XS et suivants, lecture NFC en arrière-plan) et Android avec NFC activé.
2. **Carte Wallet → terminal NFC du commerce** (non implémenté, non permis par nos puces) : Apple « Value Added Services » / Google Smart Tap exigent un terminal certifié et des accords spécifiques (Apple NFC certificate, Google Smart Tap collector ID). Les puces NTAG 424 DNA ne sont pas des lecteurs. Une carte Wallet Taply affichera donc un **QR** (le même jeton personnel) scanné par le scanner du dashboard.

## Wallet — ce qui est prêt

- Identité stable de carte (`memberships.id`), code court affiché, jetons QR révocables (`wallet_qr_tokens`, `expires_at` NULL = statique pour Wallet), validation employé + PIN des codes statiques (mode A).
- `WALLET_WEB_SERVICE_URL` réservé dans la configuration.

## Wallet — ce qu'il faut pour aller plus loin

| | Apple Wallet | Google Wallet |
|---|---|---|
| Compte | Apple Developer Program (99 €/an) | Google Wallet API (console Google Pay & Wallet, compte émetteur) |
| Certificats | Pass Type ID + certificat de signature `.p12`, certificat WWDR | Compte de service + clé, classe `LoyaltyClass` |
| Backend à ajouter | Génération `.pkpass` signée (PKCS#7), web service PassKit (`/v1/devices/...`, `/v1/passes/...`) pour mises à jour push APNs | Objets `LoyaltyObject` (JWT « Save to Google Wallet »), PATCH lors des passages |
| Synchronisation | Push APNs vers l'appareil → téléchargement du pass mis à jour | Mise à jour serveur de l'objet, propagée par Google |

Dès réception des accès : ajouter `wallet_passes` (membership, plateforme, numéro de série, jeton d'authentification haché, dernière version) et déclencher la mise à jour dans la même transaction que `notification_outbox`.

## Notifications — ce qui est prêt

- Préférences commerçant : `notify_reward_unlocked`, `notifications_enabled` (dashboard → Notifications). Désactivées par défaut pour les annonces.
- File d'événements `notification_outbox` alimentée dans la transaction de crédit (`reward_unlocked`), dédoublonnée par carte et par cycle (`dedupe_key` unique) : aucune double notification possible.
- Table `push_subscriptions` (abonnement Web Push d'une identité anonyme, consentement explicite, révocable).

## Notifications — ce qui manque (honnêtement non livré)

- Clés VAPID (`TAPLY_VAPID_PUBLIC_KEY` / `TAPLY_VAPID_PRIVATE_KEY`) et l'envoi Web Push (chiffrement RFC 8291) par une tâche planifiée (Vercel Cron) qui lit la file, respecte les préférences et un plafond par client (ex. 1 annonce/semaine).
- Le bouton « Activer les alertes » sur la carte client (permission du navigateur, uniquement sur action de l'utilisateur ; sur iPhone, Web Push n'existe que pour une web app ajoutée à l'écran d'accueil, iOS 16.4+).
- Désabonnement en un geste depuis la carte (révocation de `push_subscriptions`).

L'interface le dit explicitement : « l'envoi effectif n'est pas encore actif ».
