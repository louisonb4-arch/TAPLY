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
  await story.scrollIntoViewIfNeeded();
  const card=page.locator('[data-scroll-card]');
  await expect(card).toBeAttached({timeout:12000});
  const stageY=await page.locator('.dashboard-scroll-container').evaluate(el=>el.getBoundingClientRect().top+scrollY);
  async function pose(y:number) {
    await page.evaluate(v=>scrollTo({top:v,behavior:'instant'}),y);
    await page.waitForTimeout(240);
    return card.evaluate(el=>getComputedStyle(el).transform);
  }
  const first=await pose(stageY-250);
  const midway=await pose(stageY+180);
  const rewind=await pose(stageY-250);
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

test('desktop : titre centré, grand écran au milieu, trois bénéfices alignés sous le dashboard', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base + '/index.html');
    const section = page.locator('[data-dashboard-story]');
    await section.scrollIntoViewIfNeeded();
    await expect(section.locator('[data-scroll-card]')).toBeVisible({ timeout: 12000 });
    const result = await page.evaluate(() => {
      const bounds = (selector: string) => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        if (!rect) throw new Error('Missing ' + selector);
        return {x: rect.x, y: rect.y + scrollY, width: rect.width};
      };
      const rows = Array.from(document.querySelectorAll('.dashboard-story__features li')).map(item => {
        const rect=item.getBoundingClientRect();
        return {x: rect.x, y: rect.y + scrollY};
      });
      return {
        intro: bounds('.dashboard-story__intro'),
        screen: bounds('.dashboard-story__visual'),
        features: bounds('.dashboard-story__features'),
        rows,
        horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      };
    });
    expect(result.intro.y).toBeLessThan(result.screen.y);
    expect(result.screen.y).toBeLessThan(result.features.y);
    expect(Math.abs(result.screen.x + result.screen.width / 2 - width / 2)).toBeLessThan(40);
    expect(result.screen.width).toBeGreaterThan(Math.min(700, width * .67));
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]!.x).toBeLessThan(result.rows[1]!.x);
    expect(result.rows[1]!.x).toBeLessThan(result.rows[2]!.x);
    expect(result.rows[0]!.y).toBeCloseTo(result.rows[1]!.y, 1);
    expect(result.rows[1]!.y).toBeCloseTo(result.rows[2]!.y, 1);
    expect(result.horizontalOverflow).toBeLessThanOrEqual(2);
  }
});

test('mobile et tablette : garder les bénéfices avant le visuel', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base + '/index.html');
    const section = page.locator('[data-dashboard-story]');
    const y = await section.locator('.dashboard-story__intro').evaluate(el=>el.getBoundingClientRect().top + scrollY);
    const f = await section.locator('.dashboard-story__features').evaluate(el=>el.getBoundingClientRect().top + scrollY);
    const v = await section.locator('.dashboard-story__visual').evaluate(el=>el.getBoundingClientRect().top + scrollY);
    expect(y).toBeLessThan(f);
    expect(f).toBeLessThan(v);
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
    expect(overflow).toBeLessThanOrEqual(2);
  }
});

test('animation Aceternity originale : 20° → 0°, 105 % → 100 %, titre 0 → -100 px', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion:'no-preference' });
  await page.goto(base + '/index.html');
  const story = page.locator('[data-dashboard-story]');
  await story.scrollIntoViewIfNeeded();
  const stage = page.locator('.dashboard-scroll-container');
  await expect(stage).toBeAttached({timeout:12000});
  const stageBounds = await stage.evaluate(el => ({ top: el.getBoundingClientRect().top + scrollY, height: el.offsetHeight }));
  expect(stageBounds.height).toBe(1280); // h-[80rem] de la référence.
  const card = page.locator('[data-scroll-card]');
  const title = page.locator('.dashboard-story__intro-motion');
  const pose = async (position: number) => {
    await page.evaluate(y => window.scrollTo({ top:y, behavior:'instant' }), position);
    await page.waitForTimeout(180);
    return {
      transform: await card.evaluate(el => el.style.transform),
      titleShift: await title.evaluate(el => getComputedStyle(el).transform),
    };
  };
  const start = await pose(stageBounds.top - 250);
  expect(start.transform).toContain('scale(1.05)');
  expect(start.transform).toContain('rotateX(20deg)');
  expect(start.titleShift).toMatch(/matrix\(1, 0, 0, 1, 0, 0\)/);
  const middle = await pose(stageBounds.top + 180);
  expect(middle.transform).not.toEqual(start.transform);
  const end = await pose(stageBounds.top + 520);
  expect(end.transform).toBe('none'); // Matrix identitaire : rotate=0, scale=1.
  expect(end.titleShift).toContain('-100)');
  const backwards = await pose(stageBounds.top - 250);
  expect(backwards.transform).toEqual(start.transform);
});

test('mobile : conserver le dashboard et le titre sans animation 3D', async ({ page }) => {
  await page.setViewportSize({width:390,height:844});
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.goto(base + '/index.html');
  const story=page.locator('[data-dashboard-story]');
  await story.scrollIntoViewIfNeeded();
  const card=page.locator('[data-scroll-card]');
  await expect(card).toBeVisible({timeout:12000});
  expect(await card.evaluate(el=>getComputedStyle(el).transform)).toBe('none');
  expect(await story.locator('.dashboard-story__intro-motion').evaluate(el=>getComputedStyle(el).transform)).toBe('matrix(1, 0, 0, 1, 0, 0)');
});
