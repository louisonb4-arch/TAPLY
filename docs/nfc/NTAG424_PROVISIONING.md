# Personnalisation des puces NTAG 424 DNA — procédure opérateur

> **Statut (10 oct. 2026)** : puces et lecteur **non reçus**. Tout ce qui suit
> a été validé **hors ligne** uniquement : cryptographie reproduite octet pour
> octet sur les exemples publiés par NXP (AN12196), contenu NDEF et offsets
> vérifiés contre le code serveur, déroulé complet testé sur une **puce
> simulée**. **Aucune compatibilité matérielle (puce réelle, lecteur, application
> NXP) n'a été testée.** La première puce réelle doit être traitée comme un test
> (voir §11).

Outils du dépôt :

| Fichier | Rôle |
| --- | --- |
| `scripts/nfc/provision.ts` | CLI : imprime le plan (simulation à sec) ; `--show-keys` pour une saisie manuelle |
| `scripts/nfc/plan.ts` | plan d'une puce, dérivation des clés, `Transport` + `runProvisioning` (PC/SC à écrire) |
| `scripts/nfc/ev2.ts` | protocole EV2 AES : authentification, secure messaging, APDU |
| `scripts/nfc/ndef.ts` | fichier NDEF et offsets SDM |
| `backend/nfc/keys.ts`, `backend/nfc/sdm.ts`, `backend/nfc/tap.ts` | côté serveur (dérivation, vérification SUN, appairage/crédit) |

---

## 1. Principe

Chaque tap produit l'URL `https://<hôte>/t?e=<32 hex>&c=<16 hex>` :

- `e` = PICCData chiffrées (AES-128-CBC, clé 1) : tag `C7`, UID 7 octets, compteur de lecture SDMReadCtr ;
- `c` = SDMMAC (8 octets, clé de session dérivée de la clé 2) calculé sur une **entrée vide**.

Le serveur déchiffre `e`, retrouve l'UID, dérive la clé 2 de cet UID, vérifie `c`,
puis consomme le compteur (strictement croissant) dans `backend/nfc/tap.ts`.

Aucune clé de puce n'est stockée : toutes sont dérivées (HKDF-SHA256) du secret
maître `TAPLY_NFC_MASTER_KEY` et de la version `TAPLY_NFC_KEY_VERSION`.
**Le fichier maître utilisé pour programmer doit contenir exactement la même
valeur que `TAPLY_NFC_MASTER_KEY` de la production**, et `--key-version` doit
égaler `TAPLY_NFC_KEY_VERSION`. Sinon les puces programmées seront refusées
(`invalid`) par le serveur.

## 2. Décision préalable : l'hôte gravé dans la puce

- L'URL (donc l'hôte) est écrite dans la puce puis verrouillée (Write = clé 0).
  **Ce doit être le domaine de production définitif** (ex. `taply.fr`), jamais un
  domaine de préproduction, une URL Vercel `*.vercel.app` ou un raccourcisseur.
- Changer d'hôte plus tard exige la clé 0 de **chaque** puce (réécriture NDEF +
  ChangeFileSettings). L'outil actuel ne le fait pas : en pratique, remplacer les puces.
- Le chemin est fixe : `/t` (route `^/t$ → /t.html` de `vercel.json`).
- L'outil refuse : majuscules, schéma, port, chemin, IP, `localhost`, point final.

## 3. Matériel

Options (aucune testée par nous) :

| Option | Ce qu'on sait | Non vérifié |
| --- | --- | --- |
| Lecteur USB PC/SC **ACS ACR1252U** | lecteur NFC PC/SC/CCID répandu, ISO 14443 A | échange ISO-DEP (APDU 90 xx) avec NTAG 424 DNA via notre futur transport ; chaînage ; pilotes macOS |
| Lecteur USB PC/SC **Identiv uTrust 3700 F** | lecteur PC/SC sans contact ISO 14443 | idem |
| **NXP TagXplorer** (application PC de NXP, pilote un lecteur PC/SC) | NXP l'annonce compatible NTAG 424 DNA (authentification, clés, réglages de fichier SDM) | intitulés exacts des menus, saisie des offsets, version requise : **à confirmer à l'installation** |
| **NXP TagInfo** (Android/iOS) | identification de la puce, lecture NDEF, AN12196 §9 | — |
| **NXP TagWriter** (Android) | écriture NDEF, AN12196 §9 | configuration SDM/changement de clés NTAG 424 DNA : **non vérifié**, ne pas s'y fier pour les clés |
| Téléphone Android / iPhone récent | ouverture de l'URL NFC en lecture « arrière-plan » | comportement exact par modèle/OS non testé |

Le transport PC/SC de `runProvisioning` **n'est pas implémenté** (dépendance
`pcsclite` non ajoutée, matériel absent). L'interface est prête :
`Transport { transmit(apdu: Buffer): Promise<Buffer> }` — envoie un APDU court,
renvoie données + SW1SW2, **ne journalise jamais les APDU**.

## 4. Contrôles à réception des puces

À faire sur **une** puce d'abord, puis par échantillon.

1. **Identification** (TagInfo) : « NTAG 424 DNA » (NT4H2421Gx), UID **7 octets
   commençant par `04`**. Un UID de 4 octets commençant par `08` = *Random ID*
   activé (irréversible) : sans la clé du fournisseur on ne peut pas lire l'UID
   réel → mettre la puce de côté, contacter le fournisseur.
2. **État usine du fichier NDEF** : `GetFileSettings(02)` non authentifié doit
   répondre `00 00 E0 EE 00 01 00` + `91 00` (pas de SDM, CommMode.Plain,
   Read/Write/ReadWrite libres, Change = clé 0, 256 octets — datasheet Table 8).
   Un NDEF déjà écrit par le fournisseur (URL de test) n'est pas un problème s'il
   n'a pas activé SDM ni changé les droits.
3. **Clés usine** : `AuthenticateEV2First` clé 0 avec `00000000000000000000000000000000`
   doit réussir (`91 00`). C'est ce que fait l'étape 3 de l'outil.

Diagnostic :

| Constat | Interprétation | Action |
| --- | --- | --- |
| réglages `0000E0EE000100` + auth clé 0 usine OK | **vierge** | personnaliser |
| autres réglages (SDM actif, droits changés) | **préconfigurée** par un tiers | ne rien modifier, contacter le fournisseur |
| auth clé 0 usine → `91 AE` | **verrouillée** (clés changées) | **NE RIEN FORCER**, contacter le fournisseur |
| réponse d'auth de 17 octets / `91 9D` | mode LRP activé | non supporté, contacter le fournisseur |
| `91 AD` | délai anti-force brute en cours | arrêter, attendre |

Pourquoi ne jamais « essayer des clés » : chaque échec incrémente un compteur
par clé ; après 50 échecs consécutifs la puce impose des délais (`91 AD`) et, à
la limite totale (1000 par défaut, AN12196 §6.4), la clé devient inutilisable.
L'outil fait **au plus deux** tentatives par passage (clé usine, puis la clé
Taply si la puce porte déjà les réglages Taply).

## 5. Plan de clés

| Slot | Rôle | Dérivation (`backend/nfc/keys.ts`) | Usage |
| --- | --- | --- | --- |
| 0 | `appMasterKey` | par UID | administration : ChangeKey, ChangeFileSettings (Change = 0), écriture NDEF (Write = 0, ReadWrite = 0) |
| 1 | `sdmMetaReadKey` | **commune** à tous les tags d'une version | chiffrement des PICCData (`e`) |
| 2 | `sdmFileReadKey` | par UID | SDMMAC (`c`) |
| 3 | `changeKey` | par UID | inutilisée pour les accès, retirée de la valeur usine |
| 4 | `changeKey` | par UID | idem |

Version de clé (octet KeyVer de ChangeKey) = `keyVersion` sur les 5 clés
(usine = `00`). La clé 1 est commune parce que l'UID n'est connu qu'après
déchiffrement de `e` : **sa fuite affaiblit tout le parc de cette version**.

## 6. Réglages SDM exacts (fichier 02 / E104h)

Pour `--host taply.fr` (71 octets de NDEF) — l'outil recalcule tout à partir des
octets réels :

```
NDEF (offset 0) : 0045 D1 01 41 55 04 "taply.fr/t?e=" + 32×"0" + "&c=" + 16×"0"
PICCDataOffset       = 20 (0x14)  → placeholder e
SDMMACInputOffset    = 55 (0x37)  ┐ égaux : MAC sur entrée vide
SDMMACOffset         = 55 (0x37)  ┘ → placeholder c

ChangeFileSettings(02), données : 40 00E0 C1 FF12 140000 370000 370000
  40      FileOption : SDM + miroir activés, CommMode.Plain
  00 E0   AccessRights (LSB d'abord) : ReadWrite=0, Change=0 | Read=E (libre), Write=0
  C1      SDMOptions : UID mirroring, SDMReadCtr mirroring, ASCII
  FF 12   SDMAccessRights (LSB d'abord) : RFU=F, SDMCtrRet=F | SDMMetaRead=1, SDMFileRead=2
  14 00 00 / 37 00 00 / 37 00 00 : PICCDataOffset / SDMMACInputOffset / SDMMACOffset (LSB d'abord)

GetFileSettings(02) attendu après coup : 00 40 00E0 000100 C1 FF12 140000 370000 370000
```

Ordre des octets vérifié dans la datasheet (Tables 7 et 69 : valeur 16 bits
transmise LSB d'abord) et sur AN12196 Table 18 (`F121` = RFU F, CtrRet 1,
MetaRead 2, FileRead 1). **SDMCtrRet = F** : `GetFileCounters` est interdit ; le
compteur n'est lisible que dans `e` (chiffré). Pas de SDMReadCtrLimit, pas de
SDMENCFileData.

Le fichier CC (E103h) n'est pas modifié : il annonce encore l'écriture NDEF
« libre » (`00h`), mais la puce refuse toute écriture sans clé 0. Certaines
applications afficheront donc la puce comme inscriptible ; une tentative
d'écriture échouera.

## 7. Préparer le secret maître sur le poste de programmation

```bash
mkdir -p ~/.config/taply && chmod 700 ~/.config/taply
# Copier la valeur de TAPLY_NFC_MASTER_KEY (64 hex) depuis le coffre, sans écho :
( umask 077; pbpaste > ~/.config/taply/nfc-master-v1.hex )   # macOS ; vider le presse-papiers ensuite
chmod 600 ~/.config/taply/nfc-master-v1.hex
```

L'outil refuse : fichier absent, non régulier, accessible au groupe ou aux autres
(`mode & 077 ≠ 0`), contenu ≠ 64 hex, clé nulle. Ne jamais placer ce fichier dans
le dépôt, un dossier synchronisé (iCloud/Dropbox) ni une sauvegarde non chiffrée.

## 8. Générer le plan d'une puce

```bash
node --import ./scripts/dev-ts-hooks.mjs scripts/nfc/provision.ts \
  --uid 04XXXXXXXXXXXX --host taply.fr \
  --master-file ~/.config/taply/nfc-master-v1.hex --key-version 1
```

Sortie (sans aucune clé) : plan de clés, octets NDEF (hex + dump), offsets,
octets ChangeFileSettings, réponse GetFileSettings attendue, les 13 étapes avec
leurs APDU, et la section de vérification.

`--show-keys` ajoute les 5 clés en hex pour une saisie manuelle. Il est **refusé
si la sortie n'est pas un terminal** (pas de `> fichier`, pas de `| tee`). Ne
jamais copier ces clés ailleurs que dans le champ de saisie ; fermer/effacer le
terminal après usage ; pas de capture d'écran.

## 9. Programmation manuelle avec NXP TagXplorer (en attendant le transport PC/SC)

> Intitulés de menus donnés à titre indicatif : **non vérifiés**, TagXplorer
> n'a pas encore été installé. Le **résultat attendu** (octets) est, lui, exact.

Faire la personnalisation **dans un lieu maîtrisé** : la session est ouverte avec
la clé usine publique, donc quiconque enregistre l'échange radio (ou un journal
d'APDU) peut retrouver les nouvelles clés.

1. Poser la puce sur le lecteur, lire son UID (7 octets, `04…`). Lancer
   `provision.ts --uid <UID> … --show-keys` dans un terminal.
2. TagXplorer : connecter le lecteur, détecter la puce, sélectionner
   l'application NDEF (`D2760000850101`).
3. Contrôle : GetFileSettings du fichier 02 = `0000E0EE000100` (sinon arrêter, §4).
4. Authentification **clé 0, AES, valeur `00…00`**. Si elle échoue : arrêter (§4).
5. **Écrire le NDEF** : de préférence en écriture brute (« Write Data », fichier
   02, offset 0) des octets hex affichés par l'outil. Si l'on passe par un éditeur
   d'enregistrement URL, l'URL doit être **exactement** l'URL gabarit (même
   longueur), sinon les offsets ne correspondent plus.
6. **Change File Settings** du fichier 02 avec les valeurs du §6 : SDM activé,
   CommMode Plain, Read = E, Write = 0, ReadWrite = 0, Change = 0, UID mirror +
   counter mirror, ASCII, SDMMetaRead = 1, SDMFileRead = 2, SDMCtrRet = F,
   PICCDataOffset / SDMMACInputOffset / SDMMACOffset **tels qu'affichés pour
   cette URL** (décimal ou hex selon le champ).
7. Relire GetFileSettings du fichier 02 : doit égaler la ligne « attendu après
   personnalisation » de l'outil.
8. **Change Key** 1, 2, 3, 4 : ancienne clé `00…00`, nouvelle clé = valeur
   affichée, version = `01` (ou la version choisie).
9. **Change Key 0 en dernier** (ancienne `00…00`, nouvelle = clé 0 affichée,
   même version). Après cette étape, seule la clé 0 Taply permet de modifier la
   puce. Une erreur de saisie ici rend la puce **définitivement** non
   administrable.
10. Effacer le terminal. Passer aux vérifications (§10).

Avec le futur transport PC/SC, `runProvisioning` fait exactement ces étapes et
en plus : compare l'UID (GetCardUID chiffré) avant toute écriture, vérifie les
MAC de chaque réponse, reprend une personnalisation interrompue (GetKeyVersion
indique les clés déjà posées) et relit la puce non authentifiée pour vérifier le
message SUN avec le code du serveur.

## 10. Vérifications au téléphone puis appairage

**Avant appairage**

1. Approcher un téléphone NFC déverrouillé : il doit proposer
   `https://taply.fr/t?e=…&c=…`. Ne pas ouvrir/partager ces URL ailleurs.
2. Deux taps successifs ⇒ deux URL **différentes**. URL identique ou zéros ⇒
   SDM inactif : ne pas déployer.
3. La page `/t` affiche « Présentoir non reconnu — Ce présentoir n'est pas
   associé à un commerce Taply » : c'est normal tant que la puce n'est pas
   appairée (preuve que le serveur l'a reconnue comme **authentique**). « Cette
   lecture n'est pas authentique » ⇒ clés/version/hôte incorrects.

**Appairage dans l'application** (`backend/nfc/admin.ts` + `backend/nfc/tap.ts`)

1. Le propriétaire (rôle `owner`) se connecte au tableau de bord **dans le
   navigateur par défaut du téléphone** (celui qui ouvrira l'URL NFC).
2. Menu **« QR & NFC »** → saisir le nom du présentoir → **« Associer une puce »**.
   Le bouton est grisé si le serveur n'a pas ses clés NFC
   (`TAPLY_NFC_MASTER_KEY` absente ou invalide).
3. Dans les **10 minutes**, taper la puce avec ce même téléphone. La première
   lecture SUN valide enregistre la puce (UID, version de clés, dernier compteur)
   ; la page affiche « Présentoir associé ».
4. Activer « Passage automatique par NFC » si souhaité.
5. Tap de contrôle avec un téléphone client : passage crédité (puis délai de 2 h
   par carte).

## 11. Première puce réelle : protocole de test

1. Tester **une** puce, idéalement une puce de rebut. Elle peut viser la
   préproduction (`--host taply-staging-louisondu44000-7822.vercel.app` +
   `~/.config/taply/nfc-master-staging-v1.hex`, la valeur de
   `TAPLY_NFC_MASTER_KEY` en Preview) : elle restera alors définitivement liée
   au staging.
2. Avant toute écriture, vérifier §4 points 1–3.
3. Après personnalisation : vérifications §10, puis 20 taps d'affilée (compteur
   croissant, aucune erreur serveur), puis « Désactiver »/« Réactiver ».
4. Seulement ensuite, programmer le lot. Noter les écarts dans ce document.

## 12. Puce perdue, volée ou compromise

- Tableau de bord **« QR & NFC » → « Signaler perdue/volée »** : statut
  `compromised`, **définitif** ; toute lecture est refusée. Le passage
  automatique est coupé s'il ne reste aucune puce active.
- **« Remplacer »** ouvre un appairage qui retire l'ancienne puce lorsque la
  nouvelle est associée.
- Les clés 0 et 2 étant propres à chaque UID, la perte d'une puce n'impose pas
  de rotation globale. Seule la clé 1 est partagée : sa compromission (extraction
  matérielle, fuite du maître) impose une rotation (§13).

## 13. Rotation des clés (`keyVersion`)

- Toutes les clés sont dérivées avec la version : changer `TAPLY_NFC_KEY_VERSION`
  change toutes les clés.
- **Le serveur actuel n'accepte qu'une version à la fois** (`tap.ts` utilise la
  clé 1 de la version courante et refuse une puce enregistrée avec une autre
  version). Changer de version rend donc **toutes** les puces déployées
  inutilisables jusqu'à leur reprogrammation ou leur remplacement.
- L'outil ne sait programmer que **usine → version v**. Reprogrammer une puce
  Taply v1 en v2 (authentification avec l'ancienne clé 0, ChangeKey avec XOR des
  anciennes clés) n'est **pas implémenté**.
- En pratique : rotation = nouveau lot de puces programmées en v+1, bascule
  serveur, remplacement via « Remplacer ». À planifier, pas à improviser.

## 14. Limites de sécurité de SUN (à connaître)

- **Capture / relais** : une URL lue mais jamais envoyée au serveur reste valable
  jusqu'à ce qu'une lecture plus récente de la même puce soit consommée.
  Quelqu'un qui tape la puce sans ouvrir l'URL peut la réutiliser plus tard
  ailleurs. SUN prouve qu'une puce authentique a produit l'URL, pas que le
  téléphone est au comptoir (bornes : délai 2 h par carte, vélocité par puce,
  désactivation possible).
- **Le compteur n'est pas une horloge** : il ordonne les lectures, il ne date
  rien.
- **Puce programmée non appairée** : n'importe quel compte propriétaire ayant une
  fenêtre d'appairage ouverte et une URL valide **non consommée** de cette puce
  peut l'associer à son commerce (« première lecture SUN valide »). Garder les
  puces programmées sous clé et les appairer dès l'installation.
- **Session de personnalisation** ouverte avec la clé usine publique : une écoute
  radio ou un journal d'APDU de cette session révèle les nouvelles clés.
- **UID en clair à l'anticollision** : Random ID n'est pas activé, l'UID radio
  reste lisible (traçabilité physique de la puce). Dans l'URL, l'UID est chiffré.
- **Clé 1 partagée** : voir §5 et §12.

## 15. Codes d'état utiles (datasheet Tables 23–24)

| SW | Nom | Cause probable |
| --- | --- | --- |
| `91 00` / `90 00` | OK | — |
| `91 AF` | ADDITIONAL_FRAME | normal après la partie 1 de l'authentification |
| `91 AE` | AUTHENTICATION_ERROR | mauvaise clé, ou commande sans authentification requise |
| `91 1E` | INTEGRITY_ERROR | MAC/padding/CRC invalide (mauvaise clé de session, ancienne clé fausse dans ChangeKey) — l'authentification est perdue |
| `91 9D` | PERMISSION_DENIED | droits/configuration ne permettent pas la commande ; LRP |
| `91 9E` | PARAMETER_ERROR | réglages SDM incohérents (offsets qui se chevauchent…) |
| `91 7E` | LENGTH_ERROR | APDU mal formé |
| `91 AD` | AUTHENTICATION_DELAY | trop d'échecs d'authentification : attendre |
| `91 BE` | BOUNDARY_ERROR | écriture/lecture hors fichier |
| `91 CA` | COMMAND_ABORTED | séquence interrompue (ex. autre commande entre les deux parties d'auth) |
| `6A 82` | fichier/application introuvable | mauvaise sélection |

## 16. Ce qui a été vérifié, et comment

Sources lues : **NXP AN12196 Rev. 2.0** (4 mars 2025) et **datasheet
NT4H2421Gx Rev. 3.0** (31 janv. 2019), textes extraits des PDF officiels.

Reproduit octet pour octet (`tests/unit/nfc/ev2.test.ts`, `ndef.test.ts`) :

- AN12196 Table 14 (AuthenticateEV2First clé 0 : RndB, cryptogrammes, TI, SV1/SV2, clés de session),
  Table 19 (clé 3), Table 23 (AuthenticateEV2NonFirst) ;
- Table 7 (CommMode.MAC, GetFileSettings : MAC commande et réponse) ;
- Tables 9, 10, 24 (APDU en clair : ISOSelect, GetFileSettings, WriteData) ;
- Table 17 (WriteData CommMode.Full, 128 octets + bloc de padding) — le document
  indique `530000` comme longueur aux étapes 4/12, mais seul `800000` (étape 15)
  redonne le MAC publié ;
- Table 18 (ChangeFileSettings SDM : données, IV, cryptogramme, MAC, réponse) ;
- Table 21 (WriteData Full fichier propriétaire), Table 27 (SetConfiguration) ;
- Tables 25–26 (ChangeKey cas « autre clé » avec CRC32 `789DFADC` et cas « clé 0 ») ;
  la réponse publiée de la Table 25 (`203BB55D1089D587`) est vérifiée aussi ;
- Table 28 (GetCardUID : MAC commande, IVr, UID déchiffré) ;
- Tables 15–16 (NDEF de l'exemple et offsets 0x20 / 0x43) ;
- Tables 2 et 4 (SUN) via `backend/nfc/sdm.ts`, déjà couvertes par `sdm.test.ts`.

Non vérifiable sans matériel : comportement réel de la puce (état
d'authentification après ChangeKey 0 ou ISOSelect, valeurs usine réelles du lot,
temps de réponse), lecteurs PC/SC, TagXplorer/TagWriter, lecture NFC par les
téléphones (Android/iOS), chaînage ISO 14443-4.
