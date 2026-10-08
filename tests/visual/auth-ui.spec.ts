import { expect, test } from '@playwright/test';

const base = process.env['TAPLY_TEST_SITE_URL'];
test.skip(!base, 'TAPLY_TEST_SITE_URL requis : serveur local explicitement démarré');

const programs = { programs: [{
  id: '00000000-0000-4000-8000-000000000010', name: 'Café pilote',
  status: 'active', threshold: 5, notificationsEnabled: false,
  totalMembers: 4, pendingRewards: 1,
}] };

function mockOwner(page: import('@playwright/test').Page) {
  return Promise.all([
    page.route('**/api/loyalty/merchant', route => route.fulfill({
      status:200, contentType:'application/json', body:JSON.stringify({ name:'Boutique pilote QA' }),
    })),
    page.route('**/api/auth/me', route => route.fulfill({
      status:200, contentType:'application/json',
      body:JSON.stringify({ authenticated:true, role:'owner', merchantId:'00000000-0000-4000-8000-000000000001' }),
    })),
    page.route('**/api/loyalty/overview', route => route.fulfill({
      status:200, contentType:'application/json', body:JSON.stringify(programs),
    })),
    page.route('**/api/loyalty/customers', route => route.fulfill({
      status:200, contentType:'application/json', body:JSON.stringify({ customers:[
        { membershipId:'00000000-0000-4000-8000-000000000099', firstName:'Élodie',
          programName:'Café pilote', visitCount:2, threshold:5, rewardPending:false },
      ], limit:50 }),
    })),
    page.route('**/api/loyalty/security', route => route.fulfill({
      status:200, contentType:'application/json',
      body:JSON.stringify({ devices:[], recentActivity:[], unusualVelocity:[] }),
    })),
    page.route('**/api/loyalty/identity', route => route.fulfill({
      status:200, contentType:'application/json',
      body:JSON.stringify({ merchantUserId:'00000000-0000-4000-8000-000000000005', role:'owner' }),
    })),
  ]);
}

test('aucun dashboard visible sans session Taply', async ({ page }) => {
  await page.route('**/api/auth/me', r => r.fulfill({
    status:401, contentType:'application/json', body:JSON.stringify({ error: { code:'AUTH_REQUIRED' } }),
  }));
  await page.goto(base + '/dashboard/#/accueil');
  await expect(page).toHaveURL(/connexion\.html/);
  await expect(page.locator('body')).not.toContainText('248 clients');
});

test('preview désactivée : zéro donnée de démonstration en fallback', async ({ page }) => {
  await page.route('**/api/auth/me', route => route.fulfill({
    status:200, contentType:'application/json',
    body:JSON.stringify({ authenticated:true, role:'owner', merchantId:'00000000-0000-4000-8000-000000000001' }),
  }));
  await page.route('**/api/loyalty/**', route => route.fulfill({
    status:503, contentType:'application/json', body:JSON.stringify({ error: { code:'SERVICE_UNAVAILABLE' } }),
  }));
  await page.goto(base + '/dashboard/#/accueil');
  await expect(page.getByText('Fonctionnalité non disponible')).toBeVisible();
  await expect(page.locator('body')).not.toContainText('Roll in Love');
  await expect(page.locator('body')).not.toContainText('248 clients');
});

test('données réelles API affichées dans le tableau de bord et clients', async ({ page }) => {
  await mockOwner(page);
  await page.goto(base + '/dashboard/#/accueil');
  await expect(page.getByText('Café pilote')).toBeVisible();
  await expect(page.locator('.kpi__value').first()).toHaveText('4');
  await page.goto(base + '/dashboard/#/clients');
  await expect(page.getByText('Élodie')).toBeVisible();
  await expect(page.getByText('2 passages', { exact:false })).toBeVisible();
});

test('mauvais mot de passe : refus, pas de redirection', async ({ page }) => {
  await page.route('**/api/auth/login', route => route.fulfill({
    status:401, contentType:'application/json', body:JSON.stringify({ error:{ code:'AUTH_INVALID' } }),
  }));
  await page.goto(base + '/connexion.html');
  await page.locator('#email').fill('owner@taply.test');
  await page.locator('#pwd').fill('wrong');
  await page.locator('[data-login] button[type=submit]').click();
  await expect(page.locator('[data-login-error]')).toBeVisible();
  await expect(page).toHaveURL(/connexion\.html/);
  await expect(page.locator('#pwd')).toBeEmpty();
});

test('connexion réussie : cookie sécurisé géré par le serveur, accès au dashboard', async ({ page }) => {
  await mockOwner(page);
  await page.route('**/api/auth/login', route => route.fulfill({
    status:200, contentType:'application/json', body:JSON.stringify({ authenticated:true, role:'owner' }),
  }));
  await page.goto(base + '/connexion.html');
  await page.locator('#email').fill('owner@taply.test');
  await page.locator('#pwd').fill('correct-here');
  await page.locator('[data-login] button[type=submit]').click();
  await expect(page).toHaveURL(/dashboard\/#\/accueil/);
  await expect(page.getByText('Café pilote')).toBeVisible();
});

test('mutation programme envoie PIN et configuration à la vraie API', async ({ page }) => {
  await mockOwner(page);
  let captured: unknown;
  await page.route('**/api/loyalty/programs/update', async route => {
    captured = route.request().postDataJSON();
    await route.fulfill({ status:200, contentType:'application/json',
      body:JSON.stringify({ updated:true, nextThreshold:7 }) });
  });
  await page.goto(base + '/dashboard/#/parametres/carte');
  await expect(page.getByText('Café pilote')).toBeVisible();
  await page.locator('[name=threshold]').fill('7');
  await page.locator('[name=pin]').fill('123456');
  await page.getByRole('button', { name:'Enregistrer les changements' }).click();
  await expect.poll(() => captured).toMatchObject({
    threshold:7, pin:'123456', notificationsEnabled:false,
  });
});
test('le prénom client reçu du serveur est échappé (anti-XSS)', async ({ page }) => {
  await mockOwner(page);
  await page.route('**/api/loyalty/customers', route => route.fulfill({
    status:200, contentType:'application/json',
    body:JSON.stringify({ customers: [{
      membershipId:'00000000-0000-4000-8000-000000000099',
      firstName:'<img src=x onerror=alert(1)>',
      programName:'Café pilote', visitCount:1, threshold:5, rewardPending:false,
    }], limit:50 }),
  }));
  await page.goto(base + '/dashboard/#/clients');
  await expect(page.getByText('<img src=x onerror=alert(1)>')).toBeVisible();
  await expect(page.locator('img[src="x"]')).toHaveCount(0);
});

test('l’employé n’accède pas aux clients, mais peut ouvrir le scan sécurisé', async ({ page }) => {
  await page.route('**/api/auth/me', r => r.fulfill({
    status:200, contentType:'application/json',
    body:JSON.stringify({ authenticated:true, role:'staff', merchantId:'00000000-0000-4000-8000-000000000001' }),
  }));
  await page.route('**/api/loyalty/identity', r => r.fulfill({
    status:200, contentType:'application/json',
    body:JSON.stringify({ merchantUserId:'00000000-0000-4000-8000-000000000020', role:'staff' }),
  }));
  await page.goto(base + '/dashboard/#/clients');
  await expect(page.getByText('Accès limité')).toHaveCount(0);
  await expect(page.getByText('Identifiant employé')).toBeVisible();
  await expect(page.getByText('Élodie')).toHaveCount(0);
  await page.goto(base + '/dashboard/#/scan');
  await expect(page.getByText('Valider un passage', { exact:false }).first()).toBeVisible();
});

test('QR public : sans code présentoir, aucune inscription', async ({ page }) => {
  await page.goto(base + '/join.html');
  await expect(page.getByText('Code du présentoir absent ou incorrect', { exact:false })).toBeVisible();
  await expect(page.locator('[data-enroll]')).toBeHidden();
});

test('QR public : pré-inscription sans crédit automatique ni secret en URL', async ({ page }) => {
  let request: unknown;
  await page.route('**/api/loyalty/enrollment/prepare', async route => {
    request = route.request().postDataJSON();
    await route.fulfill({ status:201, contentType:'application/json', body:JSON.stringify({
      status:'prepared', claimToken:'A'.repeat(43), expiresInSeconds:600,
    }) });
  });
  await page.goto(base + '/join.html?code=' + 'p'.repeat(25));
  await page.locator('#firstName').fill('Camille');
  await page.locator('[name=privacyAccepted]').check();
  await page.getByRole('button', { name:'Commencer' }).click();
  await expect(page.locator('[data-claim]')).toHaveText('A'.repeat(43));
  await expect(page).not.toHaveURL(/AAAAAAAA/);
  expect(request).toMatchObject({ firstName:'Camille', privacyAccepted:true,
    publicToken:'p'.repeat(25) });
});

test('employé : validation du premier passage après confirmation humaine', async ({ page }) => {
  await page.route('**/api/auth/me', r => r.fulfill({
    status:200, contentType:'application/json', body:JSON.stringify({
      authenticated:true, role:'staff', merchantId:'00000000-0000-4000-8000-000000000001',
    }),
  }));
  await page.route('**/api/loyalty/identity', r => r.fulfill({
    status:200, contentType:'application/json', body:JSON.stringify({ merchantUserId:'00000000-0000-4000-8000-000000000020' }),
  }));
  let submitted: unknown;
  await page.route('**/api/loyalty/enrollment/confirm', async route => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ status:201, contentType:'application/json', body:JSON.stringify({
      status:'confirmed', membershipId:'00000000-0000-4000-8000-000000000999',
      qrToken:'q'.repeat(43), firstVisitCredited:true, visitCount:1, rewardUnlocked:false,
    }) });
  });
  await page.goto(base + '/dashboard/#/confirmation');
  await page.locator('[name=claimToken]').fill('A'.repeat(43));
  await page.locator('[name=pin]').fill('123456');
  await page.locator('[name=customerPresent]').check();
  await page.locator('[name=purchaseConfirmed]').check();
  await page.getByRole('button', { name:'Activer la carte et créditer le premier passage' }).click();
  await expect(page.getByText('Premier passage enregistré.', { exact:false })).toBeVisible();
  await expect(page.getByText('q'.repeat(43), { exact:false })).toBeVisible();
  expect(submitted).toMatchObject({ customerPresent:true, purchaseConfirmed:true, pin:'123456',
    claimToken:'A'.repeat(43) });
});

test('le lien Créer un compte remplace définitivement la démo', async ({ page }) => {
  await page.goto(base + '/connexion.html');
  await expect(page.getByRole('link', { name: 'Créer un compte' })).toHaveAttribute('href', 'creer-compte.html');
  await page.getByRole('link', { name: 'Créer un compte' }).click();
  await expect(page).toHaveURL(/creer-compte\.html/);
  await expect(page.getByRole('button', { name: 'Créer mon compte' })).toBeVisible();
});
test('l’inscription valide le mot de passe et ne contacte pas le serveur si mismatch', async ({ page }) => {
  let hits = 0;
  await page.route('**/api/auth/signup', route => { hits++; return route.abort(); });
  await page.goto(base + '/creer-compte.html');
  await page.locator('[name=businessName]').fill('Boulangerie');
  await page.locator('[name=email]').fill('owner@taply.test');
  await page.locator('[name=password]').fill('long-test-password-12');
  await page.locator('[name=passwordConfirm]').fill('different-long-password');
  await page.locator('[name=termsAccepted]').check();
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(page.getByText('Les mots de passe ne correspondent pas.')).toBeVisible();
  expect(hits).toBe(0);
});
test('une inscription acceptée affiche la confirmation et ne conserve pas le mot de passe', async ({ page }) => {
  let submitted: unknown;
  await page.route('**/api/auth/signup', async route => {
    submitted = route.request().postDataJSON();
    await route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({emailSent:true})});
  });
  await page.goto(base + '/creer-compte.html');
  await page.locator('[name=businessName]').fill('Boulangerie Taply');
  await page.locator('[name=email]').fill('owner@taply.test');
  await page.locator('[name=password]').fill('long-test-password-12');
  await page.locator('[name=passwordConfirm]').fill('long-test-password-12');
  await page.locator('[name=termsAccepted]').check();
  await page.getByRole('button', { name: 'Créer mon compte' }).click();
  await expect(page.getByText('Vérifiez votre boîte e-mail.')).toBeVisible();
  await expect(page.locator('[data-signup]')).toBeHidden();
  expect(submitted).toMatchObject({businessName:'Boulangerie Taply',email:'owner@taply.test',termsAccepted:true});
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});
