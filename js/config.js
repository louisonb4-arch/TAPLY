/* ==========================================================================
   TAPLY — Configuration du contenu
   ---------------------------------------------------------------------------
   IMAGES : déposez vos fichiers dans /images puis renseignez leur chemin.
   Laissé vide ("") → le placeholder reste affiché. Aucun autre fichier à
   modifier : le texte alternatif est déjà dans index.html (data-alt).
   ========================================================================== */

window.TAPLY_CONFIG = {
  images: {
    hero:        "",   // ex. "images/hero.jpg"        — mobile/tablette (<1024px) : 1200×1800 portrait, sujet en bas
    heroDesktop: "images/hero-desktop.webp", // ≥1024px — 16:9, sujets (présentoir + téléphone) au centre-droit ; idéalement 2400px de large
    constat:     "",   // ex. "images/constat.jpg"     — 1800×1200, sacs kraft + ardoise
    step1:       "images/step-1.webp",   // 16:9 — le client tape le badge
    step2:       "images/step-2.webp",   // 16:9 — la carte dans le Wallet
    step3:       "images/step-3.webp",   // 16:9 — la carte physique / récompense
    benefits:    "",   // ex. "images/benefits.jpg"    — 1400×1800 (portrait), intérieur boulangerie-café
    testimonial: "",   // ex. "images/temoin.jpg"      — 400×400, portrait du commerçant
    walletQr:    "",   // ex. "images/qr-exemple.png"  — QR code vers une carte d'exemple
    avatar1: "", avatar2: "", avatar3: "", avatar4: ""   // portraits ronds du hero (preuve sociale), 160×160
  },

  /* Téléphone construit en code dans le hero.
     Passer à false si la photo hero montre déjà le téléphone en main. */
  heroDevice: true,

  /* Vidéo de démo (modale). Fichier local .mp4 ou URL YouTube/Vimeo "embed". */
  demoVideo:  "",      // ex. "images/demo.mp4" ou "https://www.youtube-nocookie.com/embed/XXXX"
  demoPoster: "",      // ex. "images/demo-poster.jpg"

  /* Formulaires : URL qui reçoit les données (Formspree, Make, API…).
     Vide → l'envoi est simulé côté navigateur (aucune donnée transmise). */
  formEndpoint:       "",
  newsletterEndpoint: ""
};
