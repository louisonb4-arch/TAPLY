import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { PNG } from 'pngjs';

/**
 * Pour chaque page : capture pleine page AVANT et APRÈS, puis comparaison
 * pixel par pixel. Vérifie aussi, sur APRÈS, l'absence d'erreur JS et de
 * ressource same-origin en échec.
 */

const BEFORE_URL = process.env['BEFORE_URL'];
const AFTER_URL = process.env['AFTER_URL'];

const PAGES = [
  '/',
  '/mentions-legales.html',
  '/cgv.html',
  '/cgu.html',
  '/confidentialite.html',
  '/cookies.html',
  '/connexion.html',
  '/404.html',
  '/dashboard/#/accueil',
  '/dashboard/#/clients',
  '/dashboard/#/clients/lea-d',
  '/dashboard/#/recompenses',
  '/dashboard/#/recompenses/nouvelle',
  '/dashboard/#/notifications',
  '/dashboard/#/statistiques',
  '/dashboard/#/parametres',
  '/dashboard/#/parametres/etablissement',
  '/dashboard/#/parametres/carte',
  '/dashboard/#/parametres/integrations',
] as const;

interface Capture {
  readonly png: Buffer;
  readonly status: number | null;
  readonly pageErrors: string[];
  readonly failedRequests: string[];
}

async function prepare(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  // Fait défiler la page pour déclencher les images chargées à la demande.
  await page.evaluate(async () => {
    document.documentElement.style.scrollBehavior = 'auto';
    const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => {
    await Promise.all(
      Array.from(document.images).map((img) =>
        img.complete ? null : new Promise((resolve) => img.addEventListener('load', resolve, { once: true })),
      ),
    );
  });
  await page.waitForTimeout(500);
}

async function capture(browser: Browser, baseUrl: string, path: string, viewport: { width: number; height: number }): Promise<Capture> {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce', deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('taply-consent', JSON.stringify({ analytics: false, date: 0 }));
    } catch {
      /* stockage indisponible */
    }
  });
  const page = await context.newPage();
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const origin = new URL(baseUrl).origin;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    const url = response.url();
    if (url.startsWith(origin) && response.status() >= 400) failedRequests.push(`${response.status()} ${url}`);
  });
  page.on('requestfailed', (request) => {
    if (request.url().startsWith(origin)) failedRequests.push(`FAILED ${request.url()}`);
  });

  const response = await page.goto(baseUrl + path, { waitUntil: 'load' });
  await prepare(page);
  const png = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
  await context.close();
  return { png, status: response?.status() ?? null, pageErrors, failedRequests };
}

/**
 * Comparaison STRICTE : tolérance 0, chaque canal RGBA de chaque pixel doit
 * être identique.
 *
 * Mesure (config Chromium de playwright.config.ts, rastérisation déterministe) :
 * référence comparée à elle-même, 19 pages × 2 viewports × 3 répétitions =
 * 114/114 identiques au pixel près. Aucune marge n'est donc justifiée.
 * Si un jour du bruit réapparaît (autre version de Chromium, autre machine),
 * corriger la cause du non-déterminisme plutôt que d'ajouter une tolérance.
 */
interface DiffResult {
  readonly sameSize: boolean;
  /** Pixels dont au moins un canal diffère. */
  readonly diff: number;
  readonly maxChannelDelta: number;
  readonly total: number;
  readonly sizes: string;
}

/** Comparaison RGBA exacte, décodage PNG côté Node (diagnostic en cas d'échec). */
function diffPixels(a: Buffer, b: Buffer): DiffResult {
  const imgA = PNG.sync.read(a);
  const imgB = PNG.sync.read(b);
  const sizes = `${imgA.width}x${imgA.height} vs ${imgB.width}x${imgB.height}`;
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    return { sameSize: false, diff: -1, maxChannelDelta: -1, total: 0, sizes };
  }
  let diff = 0;
  let maxChannelDelta = 0;
  for (let i = 0; i < imgA.data.length; i += 4) {
    let pixelMax = 0;
    for (let c = 0; c < 4; c += 1) {
      const delta = Math.abs((imgA.data[i + c] ?? 0) - (imgB.data[i + c] ?? 0));
      if (delta > pixelMax) pixelMax = delta;
    }
    if (pixelMax > 0) diff += 1;
    if (pixelMax > maxChannelDelta) maxChannelDelta = pixelMax;
  }
  return { sameSize: true, diff, maxChannelDelta, total: imgA.width * imgA.height, sizes };
}

test.describe('site statique : avant / après identiques', () => {
  test.skip(!BEFORE_URL || !AFTER_URL, 'BEFORE_URL et AFTER_URL requis');

  for (const path of PAGES) {
    test(`page ${path}`, async ({ browser }, testInfo) => {
      const viewport = testInfo.project.use.viewport ?? { width: 1440, height: 900 };
      const before = await capture(browser, BEFORE_URL as string, path, viewport);
      const after = await capture(browser, AFTER_URL as string, path, viewport);

      expect(after.status, 'statut HTTP').toBe(before.status);
      expect(after.pageErrors, 'erreurs JavaScript').toEqual([]);
      expect(after.failedRequests, 'ressources same-origin en échec').toEqual([]);

      const identicalBytes = before.png.equals(after.png);
      let result: DiffResult = { sameSize: true, diff: 0, maxChannelDelta: 0, total: 0, sizes: 'identiques (octets)' };
      if (!identicalBytes) result = diffPixels(before.png, after.png);

      const dir = join(testInfo.outputDir, 'captures');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'before.png'), before.png);
      writeFileSync(join(dir, 'after.png'), after.png);
      await testInfo.attach('résultat', {
        body: JSON.stringify({ path, project: testInfo.project.name, identicalBytes, ...result }),
        contentType: 'application/json',
      });

      expect(result.sameSize, `tailles : ${result.sizes}`).toBe(true);
      expect(result.diff, `pixels différents (${result.sizes}, delta max ${result.maxChannelDelta})`).toBe(0);
    });
  }
});
