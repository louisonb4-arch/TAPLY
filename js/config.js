/* ==========================================================================
   TAPLY — Configuration du contenu
   ---------------------------------------------------------------------------
   IMAGES : déposez vos fichiers dans /images puis renseignez leur chemin.
   Laissé vide ("") → le placeholder reste affiché. Aucun autre fichier à
   modifier : le texte alternatif est déjà dans index.html (data-alt).
   ========================================================================== */

window.TAPLY_CONFIG = {
  images: {
    hero:        "",   // ex. "images/hero.jpg"        — 2400×1600, ambiance comptoir, sujet à droite
    constat:     "",   // ex. "images/constat.jpg"     — 1800×1200, sacs kraft + ardoise
    step1:       "",   // ex. "images/step-1.jpg"      — 1600×1100, le client tape le badge
    step2:       "",   // ex. "images/step-2.jpg"      — 1600×1100, la carte dans le Wallet
    step3:       "",   // ex. "images/step-3.jpg"      — 1600×1100, la récompense
    benefits:    "",   // ex. "images/benefits.jpg"    — 1400×1800 (portrait), intérieur boulangerie-café
    testimonial: "",   // ex. "images/temoin.jpg"      — 400×400, portrait du commerçant
    walletQr:    ""    // ex. "images/qr-exemple.png"  — QR code vers une carte d'exemple
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
