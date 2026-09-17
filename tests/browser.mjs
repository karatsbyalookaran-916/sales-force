import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { database } from '../server/database.mjs';
import { makeServer } from '../server/server.mjs';
const folder = mkdtempSync(join(tmpdir(), 'karats-browser-test-'));
const db = database(join(folder, 'test.sqlite'));
const server = makeServer(db);
await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(undefined)));
const address = /** @type {import('node:net').AddressInfo} */ (server.address());
const baseURL = `http://localhost:${address.port}`;

// Waits for a server-side condition. Used where the UI gives no completion signal.
async function until(check, description, { timeout = 15000, interval = 100 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeout}ms waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, interval));
  }
}
let browser;
try {
  // Edge locally, as the README describes. CI sets PLAYWRIGHT_CHANNEL empty to use
  // Playwright's bundled Chromium, which is the same engine and always available.
  const channel = process.env.PLAYWRIGHT_CHANNEL ?? 'msedge';
  browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: true });
  const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('heading', { name: 'Set up your workspace' }).waitFor();
  assert.equal(await page.locator('.sidebar').isVisible(), true);
  await page.getByLabel('Your name', { exact: true }).fill('Test Administrator');
  await page.locator('#login-form input[name=email]').fill('admin@example.test');
  await page.locator('#login-form input[name=password]').fill('browser-test-12345');
  await page.getByRole('button', { name: 'Create administrator account', exact: true }).click();
  await page.locator('#lead-dashboard').waitFor({ state: 'visible' });
  await page.locator('#pipeline-link').click();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.sidebar').isVisible(), true);
  assert.equal(await page.locator('.topbar').evaluate(element => getComputedStyle(element).position), 'fixed');
  await page.getByRole('button', { name: 'Collapse navigation' }).click();
  assert.equal(await page.locator('body').evaluate(element => element.classList.contains('sidebar-collapsed')), true);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.getByRole('button', { name: '+ Add lead', exact: true }).click();
  await page.getByLabel('Business / jewellery name').fill('Malabar Test Jewellers');
  await page.getByLabel('Contact person').fill('Anita');
  await page.getByLabel('Location', { exact: true }).fill('Kochi');
  await page.getByLabel('Next follow-up').fill('2026-09-16');
  await page.getByRole('button', { name: 'Save lead', exact: true }).click();
  await page.locator('.pending').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Malabar Test Jewellers', exact: true }).waitFor();
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/desktop.png', fullPage: true });
  // Disconnect, update a lead, reload, and verify the update survived entirely offline.
  await context.setOffline(true);
  await page.getByRole('button', { name: 'Malabar Test Jewellers', exact: true }).click();
  await page.getByLabel('Sales stage').selectOption('Interested');
  await page.getByRole('button', { name: 'Save lead', exact: true }).click();
  await page.getByText('Saved on device · awaiting sync', { exact: true }).waitFor();
  await page.reload();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.column').filter({ has: page.getByRole('heading', { name: 'Interested', exact: true }) }).getByRole('button', { name: 'Malabar Test Jewellers' }).count(), 1);
  const presentation = await context.newPage();
  const response = await presentation.goto('/Karats-Elite-Plan-Brochure-source.html?lang=en#presentation');
  assert.equal(response.status(), 200);
  await presentation.getByRole('button', { name: 'Collapse navigation' }).click();
  assert.equal(await presentation.locator('body').evaluate(element => element.classList.contains('karats-lane-collapsed')), true);
  await presentation.getByRole('button', { name: 'Open navigation' }).click();
  assert.equal(await presentation.locator('.karats-page-lane').isVisible(), true);
  await presentation.locator('.karats-manage-team').waitFor();
  await presentation.locator('#deckIndicator').getByText('Page 1 of 7', { exact: true }).waitFor();
  assert.equal(await presentation.locator('#presentationControls').evaluate(element => { const box=element.getBoundingClientRect(); return box.left >= 0 && box.right <= window.innerWidth + 1; }), true);
  for (let index = 0; index < 5; index++) await presentation.getByRole('button', { name: 'Next page' }).click();
  assert.equal(await presentation.locator('.page.presentation-active').isVisible(), true);
  assert.equal(await presentation.locator('.page.presentation-active').evaluate(element => element.getBoundingClientRect().right <= window.innerWidth + 1), true);
  await presentation.close();
  const calculator = await context.newPage();
  assert.equal((await calculator.goto('/Karats-Smart-Capital-Calculator.html')).status(), 200);
  await calculator.locator('.karats-manage-team').waitFor();
  assert.equal(await calculator.locator('.section-panel').isVisible(), true);
  assert.equal(await calculator.locator('.detail-grid').isVisible(), true);
  await calculator.getByRole('button', { name: 'Collapse navigation' }).click();
  assert.equal(await calculator.locator('body').evaluate(element => element.classList.contains('karats-lane-collapsed')), true);
  await calculator.setViewportSize({ width: 390, height: 844 });
  await calculator.getByRole('button', { name: 'Open navigation' }).click();
  assert.equal(await calculator.locator('.karats-page-backdrop').isVisible(), true);
  await calculator.locator('.karats-page-backdrop').click({ position: { x: 380, y: 400 } });
  await calculator.close();
  // A different connected session edits the same record before the offline update syncs.
  const apiContext = await browser.newContext({ baseURL });
  await apiContext.request.post('/api/login', { headers: { Origin: baseURL, 'X-Karats-Request': '1' }, data: { email: 'admin@example.test', password: 'browser-test-12345' } });
  const leads = await (await apiContext.request.get('/api/leads')).json();
  const remoteUpdate = await apiContext.request.post('/api/leads', { headers: { Origin: baseURL, 'X-Karats-Request': '1' }, data: { mutationId: crypto.randomUUID(), baseVersion: 1, lead: { ...leads[0], stage: 'Presented' } } });
  assert.equal(remoteUpdate.status(), 200);
  await context.setOffline(false);
  await page.getByRole('button', { name: 'Review Malabar Test Jewellers' }).waitFor();
  await page.getByRole('button', { name: 'Review Malabar Test Jewellers' }).click();
  await page.getByRole('button', { name: 'Use my version', exact: true }).click();
  await page.getByRole('button', { name: 'Review Malabar Test Jewellers' }).waitFor({ state: 'hidden' });
  // The banner hides as soon as the choice is applied locally, which is before the queued
  // update reaches the server. Background sync is deliberately silent, so there is no UI
  // signal for completion: poll the server rather than race it.
  const final = await until(async () => {
    const rows = await (await apiContext.request.get('/api/leads')).json();
    return rows[0]?.version === 3 ? rows : null;
  }, 'the resolved lead to reach the server');
  assert.equal(final[0].stage, 'Interested'); assert.equal(final[0].version, 3);
  // Team provisioning and responsive layout.
  await page.getByRole('button', { name: 'Employee management' }).click();
  await page.getByRole('heading', { name: 'Employee management', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Onboard staff', exact: true }).click();
  await page.locator('#team-form input[name=name]').fill('Team Member');
  await page.locator('#team-form input[name=email]').fill('member@example.test');
  await page.locator('#team-form input[name=password]').fill('member-test-12345');
  await page.getByRole('button', { name: 'Create staff login' }).click();
  await page.locator('.employee-row').filter({ hasText: 'member@example.test' }).waitFor();
  assert.equal(await page.locator('#team-form select[name=role]').count(), 0);
  await page.locator('#pipeline-link').click();
  if (await page.locator('body').evaluate(element => element.classList.contains('sidebar-collapsed'))) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('heading', { name: 'Your profile', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Open navigation' }).click();
  if (await page.locator('#sidebar-backdrop').isVisible()) await page.locator('#sidebar-backdrop').click({ position: { x: 380, y: 400 } });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.screenshot({ path: 'test-results/mobile.png', fullPage: true });
  await page.locator('#profile-trigger').click();
  await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
  await page.locator('#login-view').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => new Promise(resolve => { const request = indexedDB.open('karats-team'); request.onsuccess = () => { const read = request.result.transaction('workspace').objectStore('workspace').get('active'); read.onsuccess = () => resolve(read.result == null); }; })), true);
  assert.deepEqual(errors, []);
  console.log('PASS: sign-in, lead save, offline reload, offline presentation, conflict resolution, team accounts, mobile layout and sign-out clearing.');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve)); db.close(); rmSync(folder, { recursive: true });
}
