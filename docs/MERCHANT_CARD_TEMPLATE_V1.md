# Carte commune du commerce vs cartes clients — Taply V1

## Principe produit

- À la première connexion du commerçant, le provisioning Supabase crée **un programme de fidélité** dans `taply.loyalty_programs` avec une version des règles (5 passages par défaut). Le commerçant ne renseigne jamais de prénom pour le consulter ou régler son seuil.
- `#/carte` affiche ce **modèle commun** : même identité du commerce, même type de programme et même logique de récompense.
- Lorsqu'un client s'inscrit, le système crée une **adhésion personnelle** (`taply.memberships.id`, UUID) et un QR personnel opaque distinct. Les passages sont suivis pour cette adhésion ; ils ne sont pas partagés.
- Le présentoir NFC/QR public ne doit servir qu'à **initier** une pré-inscription. Il ne délivre pas une visite ni ne permet d'accumuler des passages librement.

## État de V1 et limites explicites

- L'écran `Ma carte` est une **prévisualisation illustrative**, pas un pass Apple Wallet déjà émis. L'intégration Wallet native et le provisionnement matériel restent à faire.
- L'écran `Inscrire un client` est **une opération manuelle distincte** qui demande actuellement un prénom et un PIN employé : les contraintes de la base existante exigent ce champ. Cette demande n'a aucune place dans la création/visualisation de la carte du commerce.
- Le parcours d'adhésion sans collecte de prénom n'est **pas encore livré** ; il demandera une modification du schéma `customer_profiles`/`pending_enrollments` et des routes publiques, avec revue RGPD et tests d'anti-abus.
- Aucune modification du schéma ni des contrôles anti-fraude pour cette correction UI.

## Validation

Tests de séparation programme/adhésion, 528 tests de base et contrôle navigateur desktop/mobile de la route `#/carte`. Vérifier qu'aucun `POST` ni champ `firstName` n'est déclenché par la page de modèle.
