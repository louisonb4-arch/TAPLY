# Activer Stripe (mode test puis production)

Le code est prêt et testé avec un faux client Stripe et des webhooks signés localement. Aucune clé Stripe n'existe dans le projet : ces étapes sont à faire par le titulaire du compte Stripe. Ne collez jamais une clé dans une conversation.

## 1. Produit et prix (mode test)

Tableau de bord Stripe → mode **Test** → Catalogue de produits → *Ajouter un produit* :
- Nom : `Taply` ; Prix : **20,00 EUR**, **récurrent mensuel**.
- Copier l'identifiant du prix (`price_…`).

## 2. Webhook

Développeurs → Webhooks → *Ajouter une destination* :
- URL : `https://taply-staging-louisondu44000-7822.vercel.app/api/billing/webhook`
- Version d'API : `2026-08-26.dahlia` (celle que le serveur fige dans `backend/billing/stripe.ts`).
- Événements : `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.paid`, `invoice.payment_succeeded`, `invoice.payment_failed`, `invoice.payment_action_required`.
- Copier le secret de signature (`whsec_…`).

## 3. Portail client

Paramètres → Facturation → Portail client : activer la mise à jour du moyen de paiement, l'historique des factures et la résiliation (fin de période recommandée).

## 4. Clé API restreinte (recommandée par Stripe plutôt que la clé secrète)

Développeurs → Clés API → *Créer une clé restreinte* (« Taply serveur ») avec uniquement :
- Checkout Sessions : **Écriture** ;
- Customer portal : **Écriture** ;
- Subscriptions : **Lecture** ;
- Customers : **Lecture**.

Tout le reste : Aucun. La clé `rk_test_…` se met dans `STRIPE_SECRET_KEY` (le serveur accepte `sk_` et `rk_`). Si une action renvoie une erreur 403 Stripe, ajouter la permission que Stripe indique dans Développeurs → Journaux.

## 5. Variables Vercel (Preview), depuis un terminal

```bash
npx vercel env add STRIPE_SECRET_KEY preview --sensitive
```

```bash
npx vercel env add STRIPE_WEBHOOK_SECRET preview --sensitive
```

```bash
npx vercel env add STRIPE_PRICE_ID preview
```

```bash
npx vercel env add TAPLY_BILLING_MODE preview
```

(valeur : `enforced`), puis redéployer la Preview et réassigner l'alias staging.

## 6. Recette Stripe (carte de test)

1. Se connecter à l'espace commerçant → Abonnement → *S'abonner* → carte `4242 4242 4242 4242`, date future, CVC quelconque.
2. Retour sur le tableau de bord : statut « Actif » (via retour vérifié + webhook).
3. Carte `4000 0000 0000 0341` (échec au renouvellement) ou *Simuler* depuis Stripe → statut « Paiement en échec » (accès en grâce).
4. Résilier depuis le portail → « Résilié » → espace en lecture seule.
5. Renvoyer un événement depuis Stripe (*Resend*) → aucune double application (`stripe_events`).

## Choix de parcours

Le compte est créé **avant** le paiement (e-mail confirmé), puis le paiement **active** le compte. Raisons : rattacher chaque paiement à un commerce existant sans clé `service_role` côté serveur, éviter les paiements orphelins et les doublons d'abonnement (session Checkout réutilisée, clé d'idempotence, refus si un abonnement est déjà actif). Un client existant se reconnecte avec ses identifiants habituels.
