# Taply : QR public de comptoir (pilote staging)

Le QR permet à un client de préparer sa carte. Il ne crédite aucune visite : un appareil approuvé, un code PIN et la confirmation humaine de présence/achat restent obligatoires.

Depuis le dashboard propriétaire : Paramètres → Mon QR de comptoir → Activer mon QR de comptoir. La création est sérialisée et idempotente. Le commerçant peut copier ou imprimer le QR. Le QR SVG est produit localement par qrcode-generator (licence MIT), sans service externe.

Le QR ouvre join.html?code=..., une page de pré-inscription valable dix minutes. Le personnel confirme ensuite la demande dans son dashboard avant la création de la carte et le premier passage. Les visites et récompenses ultérieures restent validées par le personnel.

Restrictions : seulement Preview/Staging (flag activé) ; zéro nouvelle route en production. La base conserve FORCE RLS ; la migration ajoute des politiques d'insertion/lecture uniquement pour le propriétaire authentifié. Le jeton public de comptoir n'est pas le jeton personnel du client.

Non terminé : Apple/Google Wallet natif, scanner par caméra, récupération de carte client, notifications, Stripe et tests en vraie boutique. Sans confirmation d'e-mail réelle, le parcours complet d'un nouveau compte reste à vérifier par un humain.

Certifications : npm run check ; npm run build:static ; tests navigateur merchant-qr.spec.ts ; certification PostgreSQL 17 jetable dans GitHub Actions. Ne pas lancer la certification PostgreSQL sur Supabase réel.
