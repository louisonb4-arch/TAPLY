import { test, expect } from '@playwright/test';

const base = process.env['TAPLY_TEST_SITE_URL'];
test.skip(!base, 'TAPLY_TEST_SITE_URL requis');

test('la section Dashboard remplace les notifications, sans changer le produit', async ({ page }) => {
  await page.goto(base + '/index.html');
  const story = page.locator('[data-dashboard-story]');
  await expect(story).toHaveCount(1);
  await expect(page.locator('section.notify')).toHaveCount(0);
  await expect(story.getByRole('heading', { name: /Piloter votre fidélité, mesurer ce qui compte/ })).toBeVisible();
  await expect(story.locator('li')).toHaveCount(3);
  const asset = story.locator('.macbook__screen');
  await story.scrollIntoViewIfNeeded();
  await expect(asset).toHaveJSProperty('naturalWidth', 1440, {timeout:8000});
  await expect(story.locator('figcaption')).toContainText('données de démonstration');
  await expect(page.locator('a.nav__login')).toHaveAttribute('href','connexion.html');
});

test('l’ouverture du Mac dépend réellement du scroll et se rembobine en remontant', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(base + '/index.html');
  const story = page.locator('[data-dashboard-story]');
  const mac = page.locator('[data-macbook]');
  const sectionY = await story.evaluate(e => e.getBoundingClientRect().top + scrollY);
  const progress = async (y: number) => {
    await page.evaluate(yPos => window.scrollTo({ top: yPos, behavior:'instant' }),y);
    await page.waitForTimeout(100);
    return Number(await mac.evaluate(e => e.style.getPropertyValue('--mac-progress')));
  };
  const closed = await progress(sectionY - 680);
  const half = await progress(sectionY - 260);
  const opened = await progress(sectionY + 230);
  const rewind = await progress(sectionY - 680);
  expect(closed).toBeLessThan(0.16);
  expect(half).toBeGreaterThan(closed + 0.22);
  expect(opened).toBeGreaterThan(0.90);
  expect(Math.abs(rewind - closed)).toBeLessThan(0.015);
  await expect(page.locator('h2#dashboard-story-title')).toBeVisible();
});

test('préférence mouvement réduit : pas de fermeture du Mac', async ({ browser }) => {
  const context = await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
  const page = await context.newPage();
  await page.goto(base + '/index.html');
  const mac = page.locator('[data-macbook]');
  expect(Number(await mac.evaluate(e => e.style.getPropertyValue('--mac-progress')))).toBe(1);
  await page.evaluate(() => scrollTo(0,document.body.scrollHeight/2));
  await page.waitForTimeout(80);
  expect(Number(await mac.evaluate(e => e.style.getPropertyValue('--mac-progress')))).toBe(1);
  await context.close();
});

test('mobile : Mac fixe et aucun défilement horizontal', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto(base + '/index.html');
  const story = page.locator('[data-dashboard-story]');
  await story.scrollIntoViewIfNeeded();
  await expect(story.locator('img.macbook__screen')).toHaveJSProperty('naturalWidth',1440,{timeout:8000});
  expect(Number(await page.locator('[data-macbook]').evaluate(e=>e.style.getPropertyValue('--mac-progress')))).toBe(1);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(2);
});
