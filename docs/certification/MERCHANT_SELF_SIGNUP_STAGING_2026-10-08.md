# Taply — Inscription commerçant autonome (préproduction 08/10/2026)

## Résultat

- La page `connexion.html` mène vers **Créer un compte** et non plus vers la démonstration.
- Nouvelle page `creer-compte.html`, reprenant l'identité visuelle Taply : nom du commerce, e-mail, mot de passe de 12 caractères minimum, confirmation du mot de passe, conditions générales.
- Nouvelle route `POST /api/auth/signup` : validation stricte et inscription par **Supabase Auth**, e-mail de confirmation Supabase et anti-énumération ; mode preview obligatoire, refus absolu en production.
- Après confirmation de l'e-mail, le premier `POST /api/auth/login` utilise temporairement le **JWT Supabase de l'utilisateur réellement connecté** pour appeler `public.taply_complete_merchant_signup_v1()`, qui calcule `auth.uid()` dans PostgreSQL et provisionne dans une transaction : un commerce, un compte propriétaire, un programme fidélité initial à **5 passages**. Puis session Taply HttpOnly normale.
- La fonction SQL refuse un utilisateur non confirmé, un appel sans JWT, un compte déjà rattaché, un nom de commerce invalide ; le rôle `anon` et le rôle SQL applicatif `taply_app` ne peuvent pas l'appeler. Identifiants Supabase jamais envoyés au navigateur Taply comme session Taply.
- `TAPLY_LOYALTY_PREVIEW=enabled` exigé au login pour ce provisioning ; le simple compte email/mot de passe ne crée pas de commerce en production.
- Supabase `taply-staging` : migration supplémentaire `20261008100009_merchant_self_onboarding.sql` exécutée, **22/22 migrations**.
- Supabase Auth **site_url** et **additional_redirect_urls** corrigés uniquement pour `https://taply-staging-louisondu44000-7822.vercel.app/connexion.html` et son URL de confirmation. Le CLI indique **aucun écart après mise à jour** pour ces deux propriétés. Les autres propriétés Supabase n'ont pas été poussées.
- Vercel Preview : `https://taply-staging-louisondu44000-7822.vercel.app/creer-compte.html`. Aucune modification de la production.

## Tests

- Avant le dernier garde d'environnement : 508/508 tests TypeScript/Vitest, 28/28 vérifications PostgreSQL 17 GitHub Actions (dont fonction d'onboarding réelle contre cluster isolé). Aucun accès anon ni taply_app à la fonction.
- **28 tests Playwright** desktop + mobile : navigation de connexion vers Créer un compte, erreurs de validation, écran de succès, aucune persistance de mots de passe. Réponses e-mail **simulées en Playwright**.
- Après garde anti-production supplémentaire : **509 tests locaux et certification CI verte** [GitHub Actions #37759263361](https://github.com/louisonb4-arch/TAPLY/actions/runs/37759263361).
- Preview Vercel a confirmé le chargement de `connexion.html` avec le bon lien, de `creer-compte.html` avec le vrai formulaire et `POST /api/auth/signup` répond `400 VALIDATION_FAILED` à un corps vide. Déploiement final sur l'alias staging uniquement.

## Limites et précautions

- Aucun nouveau parcours **e-mail réel → création d'un commerce réel → premier login** n'a été entièrement certifié après ces changements contre le service distant. Une tentative de création de nouvelle boîte de test a été empêchée par la protection de l'outil, donc **ne pas prétendre un E2E réel de ce nouveau parcours**. Le pipeline email/confirmation Supabase a été validé lors d'un test antérieur, et l'onboarding SQL est certifié en PostgreSQL isolé.
- La protection anti-bot, la limitation robuste des créations de commerces, la vérification du consentement et l'acceptation RGPD avec preuve horodatée restent nécessaires avant le lancement public.
- Aucune facturation Stripe, émission Wallet native ni notifications réelles.
- Les secrets de test ne sont pas inclus dans Git. Pas de fusion dans `main`.
