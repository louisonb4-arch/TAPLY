import { test, expect } from '@playwright/test';

const base = process.env['TAPLY_TEST_SITE_URL'];
test.skip(!base, 'TAPLY_TEST_SITE_URL nécessaire');

function apiSetup(page: import('@playwright/test').Page, initialConfigured: boolean) {
  let configured = initialConfigured;
  let creations = 0;
  const publicUrl = (base || '') + '/join.html?code=' + 'p'.repeat(27);
  page.route('**/api/**', async route => {
    const r = route.request();
    const pathname = new URL(r.url()).pathname.replace(/^\/api\//, '');
    if (pathname === 'loyalty/public-link') {
      if(r.method()==='POST'){ configured=true; creations++; }
      return route.fulfill({ status:200, contentType:'application/json',
        body:JSON.stringify(configured
          ? { configured:true, url:publicUrl, programId:'program-test', created: r.method()==='POST'}
          : { configured:false }) });
    }
    const responses:Record<string,unknown>={
      'auth/me': { role:'owner', merchantId:'11111111-1111-4111-8111-111111111111' },
      'loyalty/merchant': { name:'Coffee Shop Test' },
      'loyalty/overview': { programs:[{id:'p',name:'Carte de fidélité',threshold:5,status:'active',totalMembers:0,pendingRewards:0}] },
      'loyalty/customers': { customers:[] },
      'loyalty/security': { devices:[], recentActivity:[], unusualVelocity:[] },
      'loyalty/identity': {merchantUserId:'22222222-2222-4222-8222-222222222222',role:'owner'},
    };
    if (pathname in responses) return route.fulfill({
      status:200,contentType:'application/json', body:JSON.stringify(responses[pathname]),
    });
    return route.fulfill({status:404});
  });
  return { getCreations:()=>creations, publicUrl };
}

test('propriétaire : génère un QR réel sans service tiers et sans inscription automatique', async ({ page }) => {
  const {getCreations,publicUrl}=apiSetup(page,false);
  const errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base + '/dashboard/#/parametres/qr',{waitUntil:'networkidle'});
  await expect(page.getByRole('heading',{name:'QR de comptoir'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Activer mon QR de comptoir'})).toBeVisible();
  await page.getByRole('button',{name:'Activer mon QR de comptoir'}).click();
  await expect(page.getByRole('heading',{name:'Votre QR code est prêt'})).toBeVisible();
  await expect(page.locator('[data-public-qr] svg')).toBeVisible();
  const qrPath = await page.locator('[data-public-qr] svg path').first().getAttribute('d');
  expect(qrPath?.length).toBeGreaterThan(1000);
  await expect(page.locator('#merchant-public-url')).toHaveValue(publicUrl);
  expect(getCreations()).toBe(1);
  expect(errors).toEqual([]);
  await expect(page.getByText(/Aucun passage n’est comptabilisé sans validation/)).toBeVisible();
});

test('propriétaire : lien existant affiché sans rotation, responsive mobile', async ({ page }) => {
  const {getCreations, publicUrl}=apiSetup(page,true);
  await page.setViewportSize({width:390,height:844});
  await page.goto(base + '/dashboard/#/parametres/qr');
  await expect(page.locator('[data-public-qr] svg')).toBeVisible();
  await expect(page.locator('#merchant-public-url')).toHaveValue(publicUrl);
  expect(getCreations()).toBe(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(2);
});
