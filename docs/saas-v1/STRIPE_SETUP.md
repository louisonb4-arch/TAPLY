# Activer Stripe (mode test puis production)

Le code est prêt et testé avec un faux client Stripe et des webhooks signés localement. Aucune clé Stripe n'existe dans le projet : ces étapes sont à faire par le titulaire du compte Stripe. Ne collez jamais une clé dans une conversation.

## État au 10 oct. 2026 (compte Stripe « taply », mode Test)

Fait (identifiants non secrets) :
- compte `acct_1UOwPoA2Tvsebt17` (distinct du compte « flip ») ;
- produit `prod_VPmHSxB5C5jzmn` « Taply », prix `price_1UOwiXA2Tvsebt174k2DdoLX` (20,00 EUR / mois) ;
- webhook `we_1UOwkfA2Tvsebt17WLtDwnAU` « taply-staging-billing » (charge utile instantanée, 12 événements, version `2026-09-30.endive`) ;
- portail client enregistré (configuration par défaut : moyen de paiement, factures, résiliation en fin de période avec motif).

- clé restreinte « Taply serveur (staging) » (4 autorisations) et secret du webhook ajoutés par le titulaire dans Vercel Preview ; `TAPLY_BILLING_MODE=enforced` ;
- staging redéployé (`taply-pxsynh21w`), smoke 24/24 avec `STAGING_STRIPE=configured` (webhook non signé ou mal signé → 401).

- **Recette §6.1–6.2 OK (10 oct. 2026, 10:13 UTC)** : paiement carte 4242 par le titulaire → abonnement Stripe `active` 20,00 €/mois ; en base `merchant_subscriptions` = `active`, bon prix, fin de période 10 nov. 2026, session Checkout effacée ; `stripe_events` : `invoice.paid`, `checkout.session.completed`, `customer.subscription.created`, `invoice.payment_succeeded`, chacun reçu et appliqué **une seule fois**.

Reste (facultatif en test) : §6.3 échec de renouvellement, §6.4 résiliation via le portail, §6.5 renvoi d'un événement. TVA : titulaire en micro-entreprise, franchise en base (art. 293 B du CGI) → pas de TVA, Stripe Tax **désactivé** ; bas de page par défaut des factures = « TVA non applicable, art. 293 B du CGI. » (mode Test, à refaire en mode production). Si le seuil de franchise est dépassé : activer la TVA et décider du prix (20 € TTC ou 24 € TTC). Factures conformes : compléter Paramètres → Entreprise (nom + « EI », adresse, SIRET).

## 1. Produit et prix (mode test)

Tableau de bord Stripe → mode **Test** → Catalogue de produits → *Ajouter un produit* :
- Nom : `Taply` ; Prix : **20,00 EUR**, **récurrent mensuel**.
- Copier l'identifiant du prix (`price_…`).

## 2. Webhook

Développeurs → Webhooks → *Ajouter une destination* :
- URL : `https://taply-staging-louisondu44000-7822.vercel.app/api/billing/webhook`
- Style de charge utile : **Instantanée** (le serveur lit `data.object`).
- Version d'API : `2026-09-30.endive` (celle que le serveur fige dans `backend/billing/stripe.ts`).
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

## Parcours « paiement d'abord » (depuis le 10 oct. 2026)

1. `creer-compte.html` → **Payer et commencer** → `POST /api/billing/start` (Origin vérifiée, 10/h par IP, 500/h au total) → page Stripe Checkout, sans compte (`metadata.taply_flow = signup`).
2. Retour sur `activer.html?paiement={CHECKOUT_SESSION_ID}` : le serveur relit la session chez Stripe et mémorise le paiement dans `taply.signup_checkouts` (e-mail stocké uniquement en empreinte SHA-256). L'e-mail du payeur pré-remplit le formulaire ; l'identifiant est retiré de la barre d'adresse.
3. Création du compte → e-mail de confirmation Supabase → connexion.
4. **Rattachement au login** : uniquement si l'e-mail du compte est **confirmé** et identique à l'e-mail du paiement **relu chez Stripe**. Connaître l'identifiant de session ne suffit pas.
5. Le webhook `checkout.session.completed` mémorise aussi le paiement (idempotent) : fermer la page de retour ne perd rien ; `activer.html` sans paramètre permet de finaliser plus tard.

Garde-fous :
- **Doublons** : réglage Stripe *Limiter à 1 abonnement par client* activé (Paramètres → Paiements → Checkout et Payment Links ; redirection vers `connexion.html`). Côté serveur, un commerce ayant déjà un abonnement en vigueur ne reçoit jamais le second : la ligne passe en `duplicate`, journal `billing.signup_checkout.duplicate` → **remboursement manuel** dans Stripe.
- **Payé sans compte** : rappel par le lien « Finaliser l'inscription » ; après 14 jours, remboursement/résiliation manuels. Liste (SQL Supabase, rôle propriétaire) :

```sql
select checkout_session_id, stripe_customer_id, stripe_subscription_id, created_at
  from taply.signup_checkouts
 where status = 'paid' and created_at < now() - interval '14 days'
 order by created_at;
```

- Inscription sans paiement toujours possible (« Préparer ma carte d'abord ») : espace en configuration seule, bouton **Activer — 20 € / mois** sur chaque bandeau du tableau de bord.
- Clé restreinte inchangée (4 autorisations) : Checkout Sessions en écriture suffit pour relire les sessions.

À faire par le titulaire : adresse de contact (support) et lien `activer.html` dans le **mémo par défaut** des factures, puis recette avec un e-mail réel non encore inscrit.
