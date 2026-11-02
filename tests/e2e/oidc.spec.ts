import { expect, test } from '@playwright/test';

/** Nur mit `AUTH_MODE=oidc docker compose --profile oidc up` ausführen: E2E_OIDC=1 npx playwright test oidc */
test.skip(process.env.E2E_OIDC !== '1', 'Keycloak-Profil nicht aktiv');

test('Anmeldung über Keycloak (OIDC, Authorization Code + PKCE)', async ({ page }) => {
  await page.goto('/anmelden');
  await page.getByRole('link', { name: 'Anmelden' }).click();
  await page.waitForURL(/localhost:8080\/realms\/dart/);
  await page.fill('#username', 'dr.nord');
  await page.fill('#password', 'Demo-Passwort-1');
  await page.click('#kc-login');
  await page.waitForURL('**/uebersicht');
  await expect(page.getByRole('heading', { name: 'Patienten und Aufgaben' })).toBeVisible();
  // Demo-Anmeldung ist im OIDC-Modus abgeschaltet
  const r = await page.request.get('/api/v1/auth/dev-users');
  expect(r.status()).toBe(404);
});
