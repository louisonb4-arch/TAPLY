# Recette manuelle sur staging (à faire par le titulaire du compte)

Staging : https://taply-staging-louisondu44000-7822.vercel.app — base Supabase `taply-staging`.
Les tests automatisés ont couvert tout le reste ; ces étapes demandent un vrai compte, une vraie boîte e-mail et de vrais téléphones.

## 1. Commerçant (ordinateur)

1. `creer-compte.html` → nom du commerce, e-mail réel, mot de passe ≥ 12 caractères → e-mail de confirmation reçu.
2. Lien de confirmation → `connexion.html?confirmation=ok` → connexion → redirection vers « Créer ma carte ».
3. Recharger la page, fermer/rouvrir le navigateur : la session persiste (12 h max, 2 h d'inactivité).
4. Étapes 1 à 5 : commerce, seuil (3 à 10), 2 récompenses, couleurs, publication → QR affiché et téléchargeable.
5. Paramètres → *Approuver cet appareil* (e-mail + mot de passe + PIN 6–10 chiffres).
6. « Mot de passe oublié » depuis `connexion.html` → e-mail reçu → nouveau mot de passe → connexion OK.

Si le lien de réinitialisation renvoie vers la page d'accueil : ajouter `https://taply-staging-louisondu44000-7822.vercel.app/reinitialiser-mot-de-passe.html` dans Supabase → Authentication → URL Configuration → Redirect URLs (la page d'accueil redirige déjà automatiquement les liens de récupération).

## 2. Client (iPhone et Android)

1. Scanner le QR téléchargé avec l'appareil photo → page du commerce → *Obtenir ma carte* → carte 0/N, aucune information demandée.
2. Fermer l'onglet, rescanner : la même carte réapparaît (pas de doublon).
3. *Afficher mon QR* → QR avec compte à rebours.

## 3. Comptoir

1. Dashboard → Scanner → PIN → *Démarrer la caméra* (autoriser) → viser le QR du client → carte affichée, rien n'est crédité.
2. *Achat constaté — valider le passage* → le téléphone du client se met à jour seul (≈ 4 s).
3. Rescanner : « Délai de 2 h » affiché, aucun crédit.

## 4. Récompense (raccourci de test)

Pour ne pas attendre 2 h entre chaque passage, mettre temporairement le seuil à 3 sur un commerce de test, puis dans Supabase → SQL (staging uniquement) :

```sql
update taply.membership_states set last_credited_at = last_credited_at - interval '3 hours'
 where merchant_id = '<id du commerce de test>';
```

Seuil atteint → le client choisit sa récompense → le comptoir scanne → « Le client a choisi : … » → *Confirmer la remise* → carte à 0, cycle 2.

## 5. Isolation

Avec un second compte commerçant : aucune carte, aucun client, aucune puce du premier n'est visible ; scanner le QR d'un client du premier commerce → « QR invalide ou expiré ».

## 6. NFC (à la réception des puces)

Suivre `docs/nfc/NTAG424_PROVISIONING.md`.
