/**
 * Non-régression visuelle du site statique.
 *
 * Compare, pixel par pixel, deux versions servies en direct :
 *   BEFORE_URL (référence, ex. production ou commit d'origine)
 *   AFTER_URL  (version à valider)
 * Exemple :
 *   BEFORE_URL=http://127.0.0.1:4410 AFTER_URL=http://127.0.0.1:4411 npm run test:visual
 * Tolérance 0 (voir static-site.spec.ts).
 */

import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  timeout: 120_000,
  fullyParallel: true,
  workers: 3,
  reporter: [['list']],
  outputDir: '../../test-results/visual',
  use: {
    browserName: 'chromium',
    headless: true,
    contextOptions: { reducedMotion: 'reduce' },
    deviceScaleFactor: 1,
    // Rastérisation déterministe : un seul fil, pas de rendu partiel,
    // profil de couleur fixe (sinon l'anticrénelage varie d'une capture à l'autre).
    launchOptions: {
      args: ['--num-raster-threads=1', '--disable-partial-raster', '--force-color-profile=srgb', '--disable-gpu'],
    },
  },
  projects: [
    { name: 'desktop-1440', use: { viewport: { width: 1440, height: 900 } } },
    { name: 'mobile-390', use: { viewport: { width: 390, height: 844 } } },
  ],
});
