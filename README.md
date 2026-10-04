# Taply — site vitrine

HTML/CSS/JS vanilla, sans build. Aperçu local : `python3 -m http.server 4330` puis http://localhost:4330

## Remplacer les images
1. Déposer les fichiers dans `images/`.
2. Renseigner le chemin dans `js/config.js` → `images.hero = "images/hero.jpg"`, etc.
   Vide = placeholder affiché. Formats conseillés indiqués en commentaire.
3. Si la photo hero montre déjà le téléphone : `heroDevice: false`.
4. Vidéo démo : `demoVideo` (mp4 local ou URL embed YouTube/Vimeo).
5. OG / favicon : `images/og.jpg` (1200×630), `images/favicon.svg`, `images/apple-touch-icon.png` (180×180).

## Modifier l'identité
Tout est dans `css/tokens.css` (couleurs, typo, espacements, rayons, ombres, mouvement).

## À confirmer avant mise en ligne
- Domaine (canonical / og:url), e-mail `contact@taply.fr`, URLs réseaux sociaux
- Témoignage (section Preuves) : texte + nom temporaires
- Compatibilité téléphones (FAQ), prix du badge au-delà des 50 premiers
- Pages légales : champs `[…]` surlignés en vert
- Formulaires : `formEndpoint` / `newsletterEndpoint` dans config.js (sinon envoi simulé)
