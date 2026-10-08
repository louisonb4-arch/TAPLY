import { expect, test } from '@playwright/test';

const base = process.env['TAPLY_TEST_SITE_URL'];
test.skip(!base, 'TAPLY_TEST_SITE_URL requis');

const pages = [
  '/', '/connexion.html', '/creer-compte.html', '/join.html',
  '/mentions-legales.html', '/cgu.html', '/cgv.html',
  '/cookies.html', '/confidentialite.html', '/404.html', '/dashboard/',
];

test('le même logo PNG est chargé et visible sur toutes les pages', async ({ page }) => {
  // Le dashboard renvoie vers la connexion sans session. Il reste testé
  // statiquement via repo-invariants et avec son DOM dans cet appel.
  await page.route('**/api/auth/me', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ authenticated: true, merchantId: '00000000-0000-4000-8000-000000000001', role: 'staff' }),
  }));
  for (const pathname of pages) {
    await page.goto(base + pathname, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.logo').first()).toBeAttached();
    const state = await page.locator('.logo').evaluateAll(nodes => nodes.map(node => {
      const images = Array.from(node.querySelectorAll<HTMLImageElement>('img.logo__asset'));
      const rect = node.getBoundingClientRect();
      return {
        count: images.length,
        allLoaded: images.every(image => image.complete && image.naturalWidth > 0),
        visibleLogo: rect.width > 0 && rect.height > 0,
        visibleImages: images.filter(image => getComputedStyle(image).display !== 'none').length,
      };
    }));
    expect(state.length, pathname).toBeGreaterThan(0);
    expect(state.every(entry => entry.count === 2 && entry.allLoaded), pathname).toBe(true);
    expect(state.filter(entry => entry.visibleLogo).length, pathname).toBeGreaterThan(0);
    expect(state.filter(entry => entry.visibleLogo).every(entry => entry.visibleImages === 1), pathname).toBe(true);
  }
});

test('le logo s’adapte au contraste de la navigation et du footer', async ({ page }) => {
  await page.goto(base + '/', { waitUntil: 'domcontentloaded' });
  const nav = page.locator('.nav .logo').first();
  await expect(nav.locator('.logo__asset--light')).toBeVisible();
  await expect(nav.locator('.logo__asset--dark')).toBeHidden();
  await page.evaluate(() => window.scrollTo(0, 1800));
  await expect(page.locator('.nav')).toHaveClass(/is-solid/, {timeout:4000});
  await expect(nav.locator('.logo__asset--dark')).toBeVisible();
  await expect(nav.locator('.logo__asset--light')).toBeHidden();
  const footer = page.locator('.footer .logo--on-deep').first();
  await expect(footer.locator('.logo__asset--light')).toBeAttached();
  await page.goto(base + '/mentions-legales.html', { waitUntil:'domcontentloaded' });
  await expect(page.locator('.nav .logo__asset--dark')).toBeVisible();
  await expect(page.locator('.nav .logo__asset--light')).toBeHidden();
});
