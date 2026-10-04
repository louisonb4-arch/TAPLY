/* ==========================================================================
   TAPLY — Données de démonstration du tableau de bord
   ---------------------------------------------------------------------------
   Tout ce que l'espace commerçant affiche vient d'ici. Pour brancher une
   vraie API, remplacer cet objet par la réponse du serveur (même forme).
   Commerce de démo : Roll in Love (Nantes). Chiffres FICTIFS.
   ========================================================================== */
(() => {
  // Générateur pseudo-aléatoire déterministe : mêmes courbes à chaque visite
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const series = (n, base, amp, trend) =>
    Array.from({ length: n }, (_, i) => Math.max(1, Math.round(base + trend * i + (rand() - .45) * amp)));

  const DAY = 864e5;
  const today = new Date(2026, 9, 4); // 4 oct. 2026 — date de référence de la démo
  const days = n => Array.from({ length: n }, (_, i) => new Date(today - (n - 1 - i) * DAY));
  const months = Array.from({ length: 12 }, (_, i) => new Date(today.getFullYear(), today.getMonth() - 11 + i, 1));

  window.TAPLY_DEMO = {
    today: today.toISOString(),

    merchant: {
      name: 'Roll in Love',
      city: 'Nantes, France',
      address: '12 rue de la Paix, 44000 Nantes',
      category: 'Restaurant / Brunch',
      description: 'Coffee, brunch & good vibes',
      logo: 'img/roll-in-love.webp',
      stamp: 'img/swirl.webp',
      card: { visits: 10, reward: '1 café offert', theme: 'creme' },
      nfc: { status: 'Actif', lastSeen: "aujourd'hui à 09:12" }
    },

    totals: { clients: 248, loyal: 42, inactive: 56 },

    // Indicateurs par période — delta = évolution vs période précédente (%)
    periods: {
      '7j':  { label: '7 derniers jours', visits: 192,  visitsDelta: 9,  active: 131, activeDelta: 4,  rewards: 21,  rewardsDelta: 11, returnRate: 64, returnDelta: 2,
               points: series(7, 26, 14, .4).map((v, i) => ({ d: days(7)[i], v })), unit: 'day' },
      '30j': { label: '30 derniers jours', visits: 842,  visitsDelta: 18, active: 248, activeDelta: 12, rewards: 62,  rewardsDelta: 34, returnRate: 68, returnDelta: 6,
               points: series(30, 21, 16, .5).map((v, i) => ({ d: days(30)[i], v })), unit: 'day' },
      '12m': { label: '12 derniers mois', visits: 8930, visitsDelta: 41, active: 612, activeDelta: 27, rewards: 655, rewardsDelta: 38, returnRate: 66, returnDelta: 9,
               points: series(12, 520, 160, 38).map((v, i) => ({ d: months[i], v })), unit: 'month' }
    },

    today_: { visits: 28, visitsDelta: 27 },

    clients: [
      { id: 'lea-d',     name: 'Léa D.',     visits: 12, cardVisits: 8, rewards: 2, used: 1, loyal: true,  since: '2025-01-12', last: 3,  email: 'lea.d@exemple.fr' },
      { id: 'tom-m',     name: 'Tom M.',     visits: 8,  cardVisits: 8, rewards: 0, used: 0, loyal: true,  since: '2025-03-02', last: 1,  email: 'tom.m@exemple.fr' },
      { id: 'chloe-l',   name: 'Chloé L.',   visits: 7,  cardVisits: 7, rewards: 0, used: 0, loyal: true,  since: '2025-04-18', last: 0,  email: 'chloe.l@exemple.fr' },
      { id: 'thomas-b',  name: 'Thomas B.',  visits: 10, cardVisits: 0, rewards: 1, used: 0, loyal: true,  since: '2025-02-09', last: 0,  email: 'thomas.b@exemple.fr' },
      { id: 'sarah-c',   name: 'Sarah C.',   visits: 5,  cardVisits: 5, rewards: 0, used: 0, loyal: false, since: '2025-06-21', last: 6,  email: 'sarah.c@exemple.fr' },
      { id: 'manon-s',   name: 'Manon S.',   visits: 4,  cardVisits: 4, rewards: 0, used: 0, loyal: false, since: '2025-07-03', last: 0,  email: 'manon.s@exemple.fr' },
      { id: 'antoine-l', name: 'Antoine L.', visits: 3,  cardVisits: 3, rewards: 0, used: 0, loyal: false, since: '2025-08-14', last: 9,  email: 'antoine.l@exemple.fr' },
      { id: 'emma-r',    name: 'Emma R.',    visits: 2,  cardVisits: 2, rewards: 0, used: 0, loyal: false, since: '2025-09-01', last: 12, email: 'emma.r@exemple.fr' },
      { id: 'clara-m',   name: 'Clara M.',   visits: 11, cardVisits: 1, rewards: 1, used: 1, loyal: true,  since: '2024-11-30', last: 2,  email: 'clara.m@exemple.fr' },
      { id: 'lucas-h',   name: 'Lucas H.',   visits: 1,  cardVisits: 1, rewards: 0, used: 0, loyal: false, since: '2025-09-28', last: 6,  email: 'lucas.h@exemple.fr' },
      { id: 'julien-b',  name: 'Julien B.',  visits: 1,  cardVisits: 1, rewards: 0, used: 0, loyal: false, since: '2025-10-01', last: 3,  email: 'julien.b@exemple.fr' },
      { id: 'ines-k',    name: 'Inès K.',    visits: 6,  cardVisits: 6, rewards: 0, used: 0, loyal: false, since: '2025-05-11', last: 34, email: 'ines.k@exemple.fr' },
      { id: 'hugo-p',    name: 'Hugo P.',    visits: 9,  cardVisits: 9, rewards: 0, used: 0, loyal: true,  since: '2025-01-27', last: 41, email: 'hugo.p@exemple.fr' }
    ],

    activity: [
      { who: 'chloe-l',  what: 'Visite enregistrée',    ago: 5 },
      { who: 'thomas-b', what: 'Récompense débloquée',  ago: 17, reward: true },
      { who: 'manon-s',  what: 'Visite enregistrée',    ago: 28 },
      { who: 'clara-m',  what: 'Récompense utilisée',   ago: 74, reward: true },
      { who: 'tom-m',    what: 'Visite enregistrée',    ago: 96 }
    ],

    rewards: [
      { id: 'r1', name: 'Café offert',         visits: 10, active: true,  photo: '', tone: 'latte',  description: 'Un café au choix, offert.' },
      { id: 'r2', name: 'Brunch offert',       visits: 15, active: true,  photo: '', tone: 'brunch', description: 'Un brunch au choix sur notre carte ♡' },
      { id: 'r3', name: 'Viennoiserie offerte', visits: 5, active: true,  photo: '', tone: 'pastry', description: 'Croissant ou pain au chocolat.' },
      { id: 'r4', name: 'Smoothie offert',     visits: 8,  active: false, photo: '', tone: 'fruit',  description: 'Le smoothie du moment.' }
    ],

    sent: [
      { text: 'Nouveau brunch dispo ce week-end ! Venez découvrir notre nouvelle carte 😋', audience: 'Tous les clients', count: 248, ago: '3 j', opened: 61 },
      { text: 'Plus qu’une visite avant votre café offert ☕️', audience: 'Clients fidèles', count: 42, ago: '9 j', opened: 74 }
    ]
  };
})();
