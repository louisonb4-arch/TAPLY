import { expect, test } from '@playwright/test';

const base = process.env['TAPLY_TEST_SITE_URL'];
test.skip(!base, 'TAPLY_TEST_SITE_URL requis');

test('dashboard de Taply, texte intact, carte React chargée sans reconstruction du produit', async ({ page }) => {
  await page.goto(base + '/index.html');
  const story = page.locator('[data-dashboard-story]');
  await expect(story).toHaveCount(1);
  await expect(story.getByRole('heading', { name: /Piloter votre fidélité, mesurer ce qui compte/ })).toBeVisible();
  await expect(story.locator('li')).toHaveCount(3);
  await expect(story.locator('figcaption')).toContainText('données de démonstration');
  await expect(page.locator('section.notify')).toHaveCount(0);
  await story.scrollIntoViewIfNeeded();
  await expect(story.locator('[data-scroll-card]')).toBeVisible({ timeout: 12000 });
  await expect(story.locator('.dashboard-scroll-image')).toHaveJSProperty('naturalWidth', 1440);
  await expect(page.locator('a.nav__login')).toHaveAttribute('href','connexion.html');
});

test('l’effet Aceternity pivote et grandit au scroll, puis revient en arrière', async ({ page }) => {
  await page.setViewportSize({width:1440,height:900});
  await page.emulateMedia({ reducedMotion:'no-preference' });
  await page.goto(base + '/index.html');
  const story=page.locator('[data-dashboard-story]');
  const sectionY=await story.evaluate(el=>el.getBoundingClientRect().top+scrollY);
  await page.evaluate(y=>scrollTo({top:y,behavior:'instant'}),sectionY-690);
  const card=page.locator('[data-scroll-card]');
  await expect(card).toBeAttached({timeout:12000});
  async function pose(y:number) {
    await page.evaluate(v=>scrollTo({top:v,behavior:'instant'}),y);
    await page.waitForTimeout(240);
    return card.evaluate(el=>getComputedStyle(el).transform);
  }
  const first=await pose(sectionY-690);
  const midway=await pose(sectionY+140);
  const rewind=await pose(sectionY-690);
  expect(first).toContain('matrix3d');
  expect(midway).toContain('matrix3d');
  expect(first).not.toEqual(midway);
  expect(rewind).toEqual(first);
});

test('réduction des animations : l’écran reste ouvert et statique', async ({ browser }) => {
  const ctx=await browser.newContext({viewport:{width:1440,height:900},reducedMotion:'reduce'});
  const page=await ctx.newPage();
  await page.goto(base + '/index.html');
  const story=page.locator('[data-dashboard-story]');
  await story.scrollIntoViewIfNeeded();
  const card=story.locator('[data-scroll-card]');
  await expect(card).toBeVisible({timeout:12000});
  expect(await card.evaluate(el=>getComputedStyle(el).transform)).toBe('none');
  await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
  await page.waitForTimeout(90);
  expect(await card.evaluate(el=>getComputedStyle(el).transform)).toBe('none');
  await ctx.close();
});

test('sur téléphone : carte plate lisible, sans débordement horizontal', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await page.goto(base+'/index.html');
  const story=page.locator('[data-dashboard-story]');
  await story.scrollIntoViewIfNeeded();
  const card=story.locator('[data-scroll-card]');
  await expect(card).toBeVisible({timeout:12000});
  expect(await card.evaluate(el=>getComputedStyle(el).transform)).toBe('none');
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
  expect(overflow).toBeLessThanOrEqual(2);
});

test('le widget React est différé et ne bloque pas la première visite en haut de page', async ({ page }) => {
  const requested:string[]=[];
  page.on('request',r=>{
    if(r.url().includes('dashboard-scroll-react.js'))requested.push(r.url());
  });
  await page.goto(base+'/index.html',{waitUntil:'networkidle'});
  expect(requested).toHaveLength(0);
  await page.locator('[data-dashboard-story]').scrollIntoViewIfNeeded();
  await expect(page.locator('[data-scroll-card]')).toBeAttached({timeout:12000});
  expect(requested).toHaveLength(1);
});
