import { Browser, expect, Page, test } from '@playwright/test';

/**
 * End-to-End-Durchlauf im echten Browser (U03, T04): echte laufende Anwendung, nur synthetische Daten.
 * Screenshots werden als Belege nach docs/screenshots geschrieben (Bildunterschrift dort: „Prototyp, synthetische Daten“).
 */
const SHOT = (name: string) => `../../docs/screenshots/${name}.png`;
const uniq = Date.now().toString(36);
const LAST = `Synth${uniq}`;

async function login(page: Page, user: string) {
  await page.goto('/anmelden');
  await page.locator(`button[data-user="${user}"]`).click();
  await page.waitForURL('**/uebersicht');
}

async function noHorizontalScroll(page: Page) {
  const r = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  expect(r.sw, 'keine horizontale Seitenverschiebung').toBeLessThanOrEqual(r.cw + 1);
}

async function unlabeledInputs(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('input:not([type=hidden]), select, textarea')]
      .filter((el) => {
        const e = el as HTMLInputElement;
        if (e.closest('[aria-hidden=true]')) return false;
        if (e.getAttribute('aria-label') || e.getAttribute('aria-labelledby')) return false;
        if (e.id && document.querySelector(`label[for="${e.id}"]`)) return false;
        if (e.closest('label')) return false;
        return true;
      })
      .map((e) => (e as HTMLElement).outerHTML.slice(0, 80)),
  );
}

let caseUrl = '';
let portalLink = '';
let accessCode = '';

test.describe.serial('DART 2.0 – vertikale Strecke', () => {
  test('Anmeldung und Dashboard (Desktop)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, 'dr.nord');
    await expect(page.getByRole('heading', { name: 'Patienten und Aufgaben' })).toBeVisible();
    await expect(page.getByText('Arztbögen offen')).toBeVisible();
    await expect(page.getByText(/Patienten \/ Fälle \(getrennt gezählt\)/)).toBeVisible();
    expect(await unlabeledInputs(page)).toEqual([]);
    await page.screenshot({ path: SHOT('01-dashboard'), fullPage: false });
  });

  test('Dreistufige Anlage: Science, Knorpel + Osteotomie, DEKOR + KnorpelRegister', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await login(page, 'dr.nord');
    await page.goto('/faelle/neu');
    // Fehlerzusammenfassung bei leerem Schritt
    await page.getByRole('button', { name: 'Weiter' }).click();
    await expect(page.locator('.alert-error')).toContainText('Vorname fehlt');
    await page.getByLabel('Vorname').fill('Erika');
    await page.getByLabel('Nachname').fill(LAST);
    await page.getByLabel('E-Mail für Verlaufsbefragungen (optional)').fill(`${uniq}@example.invalid`);
    await page.getByLabel(/Kontaktaufnahme per E-Mail/).check();
    await page.screenshot({ path: SHOT('02-anlage-schritt1') });
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.getByLabel('Links', { exact: true }).check();
    await page.getByLabel('Operativ', { exact: true }).check();
    await page.getByLabel(/Eingriffe suchen/).fill('5-781');
    await page.getByText('Valgisierende Tibiakopfosteotomie (Beispiel)').click();
    await page.getByLabel(/Eingriffe suchen/).fill('Zelltransplantation');
    await page.getByText(/Knorpelzelltransplantation, offen/).click();
    await expect(page.getByLabel('Knorpel', { exact: true })).toBeChecked();
    await expect(page.getByLabel('Osteotomie', { exact: true })).toBeChecked();
    await page.screenshot({ path: SHOT('03-anlage-schritt2') });
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.getByLabel('Geplantes OP-Datum').fill(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date()));
    await page.getByLabel('DART Science').check();
    await expect(page.getByLabel('KnorpelRegister DGOU')).toBeChecked();
    await expect(page.getByLabel('DEKOR', { exact: true })).toBeChecked();
    await page.screenshot({ path: SHOT('04-anlage-schritt3') });
    await page.getByRole('button', { name: 'Fall anlegen' }).click();
    await page.waitForURL(/\/faelle\/[0-9a-f-]{36}$/);
    caseUrl = page.url();
    await expect(page.getByText('Erfassung gesperrt')).toBeVisible();
    await expect(page.getByText('Persönliche Einladung vor Ort')).toBeVisible();
    portalLink = (await page.locator('a[href*="/portal/einladung#t="]').getAttribute('href'))!;
    accessCode = (await page.locator('strong', { hasText: /^[A-Z2-9]{8}$/ }).textContent())!.trim();
    expect(accessCode).toMatch(/^[A-Z2-9]{8}$/);
    await page.screenshot({ path: SHOT('05-fall-consent-fehlt'), fullPage: true });
  });

  test('Mobiles Portal (360 px): bewusstes Einlösen, Zugangscode, aktive Zustimmung mit Tastatur-Alternative', async ({ browser }) => {
    const ctx = await (browser as Browser).newContext({ viewport: { width: 360, height: 760 }, locale: 'de-DE', timezoneId: 'Europe/Berlin' });
    const page = await ctx.newPage();
    await page.goto(portalLink);
    await expect(page.getByRole('button', { name: 'Zugang jetzt öffnen' })).toBeVisible();
    await noHorizontalScroll(page);
    await page.getByRole('button', { name: 'Zugang jetzt öffnen' }).click();
    await page.getByLabel('Zugangscode').fill('FALSCH22');
    await page.getByRole('button', { name: 'Bestätigen' }).click();
    await expect(page.getByText(/nicht korrekt/)).toBeVisible();
    await page.getByLabel('Zugangscode').fill(accessCode);
    await page.getByRole('button', { name: 'Bestätigen' }).click();
    await page.waitForURL('**/portal');
    await expect(page.getByRole('heading', { name: 'Ihre Teilnahme am Register' })).toBeVisible();
    await page.screenshot({ path: SHOT('06-portal-information-360'), fullPage: true });
    await page.getByLabel(/Ich habe die Information gelesen/).check();
    await page.getByRole('button', { name: 'Weiter' }).click();
    // Nichts vorausgewählt
    for (const cb of await page.locator('fieldset').first().getByRole('checkbox').all()) await expect(cb).not.toBeChecked();
    for (const cb of await page.locator('fieldset').first().getByRole('checkbox').all()) await cb.check();
    await page.getByLabel('Namen eintippen').check();
    await page.getByLabel('Vor- und Nachname').fill(`Erika ${LAST}`);
    await noHorizontalScroll(page);
    await page.screenshot({ path: SHOT('07-portal-unterschrift-360'), fullPage: true });
    await page.getByRole('button', { name: 'Prüfen und bestätigen' }).click();
    await expect(page.getByText(/Ihre Einwilligung wurde gespeichert/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Starten' })).toBeVisible();
    await page.screenshot({ path: SHOT('08-portal-befragungen-360'), fullPage: true });
    await page.getByRole('link', { name: 'Starten' }).click();
    await page.getByText('4 – gar nicht').first().click();
    await expect(page.getByText(/Gespeichert/).first()).toBeVisible({ timeout: 10_000 });
    await noHorizontalScroll(page);
    await page.screenshot({ path: SHOT('09-portal-befragung-360'), fullPage: true });
    await ctx.close();
  });

  test('Dynamischer Arztbogen: Modulchips, Autosave, Verzweigung, Konflikt, Abschluss', async ({ page, browser }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await login(page, 'dr.nord');
    await page.goto(caseUrl);
    await expect(page.getByText('Aktiv', { exact: true })).toBeVisible();
    await page.getByRole('link', { name: /Osteotomie/ }).first().click();
    await expect(page.getByRole('navigation', { name: 'Module dieses Falls' })).toBeVisible();
    await page.getByLabel(/Ganzbeinstandaufnahme/).check();
    await page.getByLabel(/Beispielfeld: Winkel/).fill('87,5');
    await page.getByLabel(/Öffnend/).check();
    await expect(page.getByLabel(/Implantat/)).toBeVisible();
    await page.getByLabel(/Implantat/).fill('Beispielplatte');
    await expect(page.getByRole('status').filter({ hasText: /Gespeichert/ }).first()).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: SHOT('10-arztbogen-autosave'), fullPage: true });
    // Verzweigung: Feld wird ausgeblendet, bleibt aber historisch erhalten
    await page.getByLabel(/Schließend/).check();
    await expect(page.getByLabel(/Implantat/)).toHaveCount(0);
    await expect(page.getByText(/ausgeblendete Angabe\(n\) bleiben historisch gespeichert/)).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /Gespeichert/ }).first()).toBeVisible({ timeout: 10_000 });

    // Paralleles Bearbeiten durch zweite Person → Konflikt
    const other = await (browser as Browser).newContext();
    const p2 = await other.newPage();
    await login(p2, 'dr.nord2');
    await p2.goto(page.url());
    await p2.getByLabel(/Geplante Korrektur/).fill('9');
    await expect(p2.getByRole('status').filter({ hasText: /Gespeichert/ }).first()).toBeVisible({ timeout: 10_000 });
    await other.close();
    await page.getByLabel(/Geplante Korrektur/).fill('7');
    await expect(page.getByText('Konflikt: Der Bogen wurde inzwischen geändert')).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: SHOT('11-arztbogen-konflikt'), fullPage: true });
    await page.getByRole('button', { name: 'Meine Eingaben auf den Serverstand anwenden' }).click();
    await expect(page.getByRole('status').filter({ hasText: /Gespeichert/ }).first()).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Prüfen und abschließen' }).click();
    await expect(page.getByText(/Bogen abgeschlossen/)).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: SHOT('12-arztbogen-abgeschlossen'), fullPage: false });
    // Basisbogen: Pflichtfehler werden zusammengefasst und feldnah angezeigt
    await page.getByRole('link', { name: /^Basis/ }).click();
    await page.getByRole('button', { name: 'Prüfen und abschließen' }).click();
    await expect(page.getByText(/Abschluss nicht möglich/)).toBeVisible();
    await expect(page.locator('.field-error').first()).toBeVisible();
  });

  test('Formulareditor mit Vorschau und Versionsfreigabe', async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    await login(page, 'redaktion');
    await page.goto('/formulare');
    await page.getByRole('link', { name: 'V1' }).first().click();
    await expect(page.getByRole('heading', { name: 'Vorschau mit synthetischen Daten' })).toBeVisible();
    await page.screenshot({ path: SHOT('13-editor-vorschau'), fullPage: false });
  });

  test('Papierweg: Upload in Prüfung und Prüfansicht', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1000 });
    await login(page, 'doku.nord');
    await page.goto('/faelle/neu');
    await page.getByLabel('Vorname').fill('Max');
    await page.getByLabel('Nachname').fill(`Papier${uniq}`);
    await page.getByLabel(/Upload einer handschriftlich/).check();
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.getByLabel('Rechts', { exact: true }).check();
    await page.getByLabel('Konservativ', { exact: true }).check();
    await page.getByRole('button', { name: 'Weiter' }).click();
    await page.getByLabel(/Beginn der konservativen Behandlung/).fill('2026-10-20');
    await page.getByRole('button', { name: 'Fall anlegen' }).click();
    await page.waitForURL(/\/faelle\/[0-9a-f-]{36}$/);
    await page.setInputFiles('#up', { name: 'einwilligung.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% synthetisch\n%%EOF\n') });
    await page.getByRole('button', { name: 'Hochladen', exact: true }).click();
    await expect(page.getByText(/Nachweis hochgeladen – Prüfung ausstehend/)).toBeVisible();
    await expect(page.getByText('Einwilligung: Upload in Prüfung').first()).toBeVisible();
    await page.screenshot({ path: SHOT('14-upload-in-pruefung'), fullPage: false });
    await login(page, 'dr.nord');
    await page.goto('/nachweise');
    await expect(page.getByText(`Sichtprüfung`).first()).toBeVisible();
    await page.screenshot({ path: SHOT('15-nachweise-pruefen'), fullPage: false });
  });

  test('Keine Rechte (Technischer Betrieb) und Dashboard bei 360 px', async ({ page }) => {
    await login(page, 'technik');
    await expect(page.getByText('Keine fachliche Fallansicht')).toBeVisible();
    await page.screenshot({ path: SHOT('16-keine-rechte') });
    await page.setViewportSize({ width: 360, height: 800 });
    await login(page, 'dr.nord');
    await noHorizontalScroll(page);
    await page.screenshot({ path: SHOT('17-dashboard-360'), fullPage: false });
  });

  test('Tastaturbedienung: sichtbarer Fokus und Sprunglink', async ({ page }) => {
    await page.goto('/anmelden');
    await page.keyboard.press('Tab');
    await expect(page.getByText('Zum Inhalt springen')).toBeFocused();
    await page.keyboard.press('Tab');
    const shadow = await page.evaluate(() => getComputedStyle(document.activeElement!).boxShadow);
    expect(shadow).not.toBe('none');
  });

  test('Linkscanner (GET) verbraucht keinen Einladungstoken', async ({ request }) => {
    const r = await request.get('/portal/einladung');
    expect(r.status()).toBe(200);
    const api = await request.get('/api/v1/portal/redeem?token=abc');
    expect(api.status()).toBe(404);
  });
});
