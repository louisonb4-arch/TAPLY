# Taply SaaS V1 — Sécurité : contrôles et limites

Ce document dit ce qui est garanti, ce qui est seulement atténué, et ce qui ne l'est pas. Il ne remplace pas un audit offensif indépendant.

## Contrôles en place (testés)

| Risque | Contrôle | Preuve |
|---|---|---|
| Lecture/modification inter-commerces | RLS forcée sur 36 tables, GUC `app.merchant_id` posée par le serveur, filtres SQL explicites en plus | PGlite (E2E) + PostgreSQL 17.10 réel (`db:loyalty:cert`) |
| Accès d'une identité aux cartes d'une autre | RLS par `app.identity_id`, lien identité→carte vérifié avant toute lecture | E2E + certification réelle |
| Crédit sans validation | Aucune route client ne crédite, sauf `POST /c/nfc/tap` avec preuve SUN valide et neuve ; le QR public ne crédite jamais | Tests de portes + E2E |
| GET / aperçu de lien qui crédite | Pas de route GET NFC ; la page `/t` est statique et poste explicitement | Smoke staging |
| Double passage (double clic, réseau, concurrence) | Verrou `FOR UPDATE`, idempotence en base, compteur SDM consommé atomiquement | 8 envois simultanés de la même preuve → 1 passage (PG17 réel) |
| Contournement du délai de 2 h | Horloge de la base uniquement, état par carte, même délai QR et NFC | QR puis NFC refusé ; 6 lectures concurrentes → 1 passage |
| Double remise de récompense | Unicité (carte, cycle) du ledger + claim définitif + idempotence | Remises concurrentes → 1 seule |
| Falsification NFC | AES-CMAC (RFC 4493) + PICCData chiffrées (AN12196), clés diversifiées par UID (HKDF), comparaison à temps constant | Vecteurs RFC 4493 et NXP AN12196, 72 tests ; smoke staging (clé réelle) |
| Rejeu NFC / compteur obsolète | `last_read_ctr < ctr` mis à jour atomiquement ; journal par compteur | Tests E2E + PG17 réel |
| Vol de code de secours en base | Hash SHA-256 seul, 100 bits d'entropie | Test |
| Force brute du code de secours | 10 essais/h par IP, 1 000/h global, comptés avant vérification | Test (11e et 12e essais → 429) |
| CSRF | Origin exacte exigée sur toutes les mutations ; cookies SameSite | Tests + smoke staging |
| Activation sans paiement | Statut écrit uniquement par webhook signé ou retour vérifié auprès de Stripe ; état relu par l'API Stripe | E2E (signature invalide refusée, succès seul insuffisant) |
| Webhook rejoué | `stripe_events` (clé primaire) + traitement transactionnel | 6 livraisons simultanées → 1 application (PG17 réel) |
| Détournement d'abonnement | Un client Stripe différent de celui du commerce est ignoré | E2E |
| Fuite de secrets | Clés NFC jamais stockées ni renvoyées ; clé Stripe uniquement serveur ; aucun jeton en `localStorage` ; QR/session jamais dans une URL | Tests de garde UI, revue |
| Appareil employé volé | Révocation immédiate, PIN dérivé (scrypt + poivre), verrouillage après 5 échecs | Certification PG17 |

## Limites connues (non résolues ou seulement atténuées)

1. **NFC : présence physique non prouvée.** SUN prouve qu'une puce Taply authentique a produit l'URL, pas que le téléphone est au comptoir. Une URL capturée et jamais consommée reste utilisable jusqu'à ce qu'une lecture plus récente de la même puce soit consommée. Le compteur n'est pas un horodatage. Atténuations : délai de 2 h par carte, vélocité par puce (≥ 8 passages/min → validation au comptoir exigée), inscriptions en rafale par puce, limitation par IP, désactivation/signalement d'une puce en un clic, journal des refus. Le commerçant peut couper le NFC automatique et revenir au QR.
2. **Lecture parasite par le téléphone.** Certains téléphones lisent la puce sans ouvrir l'URL : le compteur avance, la lecture suivante reste valide (seuls les compteurs inférieurs au dernier consommé sont refusés).
3. **Perte d'identité client.** Sans code de secours, effacer les données du navigateur ou changer de téléphone fait perdre l'accès aux cartes. L'interface l'explique ; le commerçant ne peut pas « retrouver » une carte anonyme (aucune donnée personnelle).
4. **Fraude interne.** Un employé avec un appareil approuvé peut valider des passages sans achat réel ; seul le journal (employé, heure, carte) permet de le détecter. Pas de lien avec la caisse.
5. **Limitation de débit par IP.** Les clients derrière une même IP (Wi-Fi public, opérateur mobile) partagent les quotas. Aucun WAF ni défi anti-robot n'est en place.
6. **Pas de comptes employés distincts.** Les validations se font avec le compte propriétaire sur un appareil approuvé + PIN. Les invitations d'employés (rôle `staff`) existent en base mais n'ont pas de parcours d'invitation.
7. **Performances RLS.** L'advisor Supabase signale `auth_rls_initplan` (current_setting évalué par ligne) sur toutes les policies : sans effet aux volumes actuels, à optimiser avant fort trafic (`(select current_setting(...))`).
8. **Protection des mots de passe divulgués** (Supabase Auth) désactivée : à activer dans le tableau de bord Supabase.
9. **Sauvegardes.** Staging : export logique JSON avant migration (pas de PITR vérifié, pas de `pg_dump` faute de Docker). Production : à définir avant ouverture (plan Supabase avec PITR recommandé).
10. **Audit externe.** Aucun test d'intrusion indépendant n'a été réalisé.
