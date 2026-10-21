import { expect, Page, test } from '@playwright/test';
import { spawnSync } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

const API = 'http://localhost:4100';
const ROOT = resolve(__dirname, '../..');
const PASSWORD = 'a-long-test-passphrase';
const stateDir = mkdtempSync(join(tmpdir(), 'tv-e2e-sim-'));
const shots = resolve(ROOT, 'test-results/e2e-screens');

async function latestLink(page: Page, email: string, subject: string) {
  const res = await page.request.get(`${API}/v1/dev/outbox`, { params: { to: email } });
  const item = (await res.json()).items.find((m: { subject: string }) =>
    m.subject.includes(subject),
  );
  return /https?:\/\/[^/]+(\/\S+)/.exec(item.body)![1];
}

function simulate(args: string[]) {
  // Invoke tsx directly so the simulator's own exit code reaches the test.
  return spawnSync(
    join(ROOT, 'apps/simulator/node_modules/.bin/tsx'),
    ['src/cli.ts', '--api', API, '--state', stateDir, ...args],
    {
      cwd: join(ROOT, 'apps/simulator'),
      encoding: 'utf8',
    },
  );
}

async function register(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('link', { name: 'Create free account' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('Confirm password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Set up TraceVault' })).toBeVisible();
  await page.goto(await latestLink(page, email, 'Verify'));
  await expect(page.getByText('Your email address is confirmed.')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });

test('register, enroll a simulated device, search activity, act on alerts, revoke', async ({
  page,
  browser,
}) => {
  const email = `e2e-${Date.now()}@example.test`;
  await register(page, email);

  // Device enrollment
  await page.goto('/devices/enroll');
  await page.getByRole('button', { name: 'Create enrollment code' }).click();
  const code = (await page.getByLabel('Enrollment code').innerText()).trim();
  expect(code).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  const sim = simulate(['--code', code, '--name', 'E2E laptop']);
  expect(sim.status, sim.stderr).toBe(0);
  expect(sim.stdout).toMatch(/Uploaded 19 events/);

  // Dashboard reflects the device and alerts
  await page.goto('/dashboard');
  await expect(page.getByText('Registered devices')).toBeVisible();
  await expect(page.locator('.tv-stat', { hasText: 'Reporting now' })).toContainText('1 / 1');
  await expect(page.locator('.tv-stat', { hasText: 'Open alerts' })).not.toContainText(/^0/);
  await page.screenshot({ path: `${shots}/dashboard.png`, fullPage: true });

  // Timeline search + demo labelling + detail panel
  await page.goto('/timeline');
  await expect(page.getByRole('cell', { name: /Local account created/ })).toBeVisible();
  await expect(page.getByText('Simulated').first()).toBeVisible();
  await page.getByLabel('Search').fill('firewall');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Security setting changed' }).click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('firewall');
  await expect(drawer).toContainText('Before and after on this device');
  await page.screenshot({ path: `${shots}/timeline-detail.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  // Offline queue: events generated while "offline" upload on the next run without duplicates
  const offline = simulate(['--scenario', 'routine', '--offline']);
  expect(offline.stdout).toMatch(/Offline mode/);
  const resync = simulate(['--scenario', 'routine']);
  expect(resync.stdout).toMatch(/Uploaded \d+ events \(0 already stored/);

  // Alerts: inferred vs observed, then resolve
  await page.goto('/alerts');
  await page.getByRole('link', { name: /New local account on E2E laptop/ }).click();
  const detail = page
    .locator('section.tv-card')
    .filter({ has: page.getByRole('heading', { name: /New local account on E2E laptop/ }) });
  await expect(detail.getByText('Observed')).toBeVisible();
  await page.getByLabel('Resolution note (optional)').fill('Checked with the borrower');
  await page.getByRole('button', { name: 'Mark resolved' }).click();
  await expect(page.getByText(/Resolved .*Checked with the borrower/)).toBeVisible();
  await page.getByRole('link', { name: /failed sign-in attempts/ }).click();
  await expect(page.getByText('This alert is an inference')).toBeVisible();
  await page.screenshot({ path: `${shots}/alerts.png`, fullPage: true });

  // Grounded summary
  await page.goto('/investigate');
  await page
    .getByRole('button', { name: 'Were there any unusual security events this week?' })
    .click();
  await expect(page.getByText('Inference').first()).toBeVisible();
  await expect(page.getByText(/no data sent to any AI provider/)).toBeVisible();
  await page.screenshot({ path: `${shots}/investigate.png`, fullPage: true });

  // Device page: report lost → credentials stop working
  await page.goto('/devices');
  await page.getByRole('link', { name: 'E2E laptop' }).click();
  await page.waitForURL(/\/devices\/[0-9a-f-]{36}$/);
  const deviceUrl = page.url();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('button', { name: 'Report lost & revoke access' }).click();
  await expect(page.getByText('Device reported lost and its access revoked.')).toBeVisible();
  await page.screenshot({ path: `${shots}/device-recovery.png`, fullPage: true });
  const after = simulate([]);
  expect(after.status).toBe(3);
  expect(after.stderr).toMatch(/revoked/);

  // A second user cannot open the first user's device page
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await register(p2, `e2e-other-${Date.now()}@example.test`);
  await p2.goto(deviceUrl);
  await expect(p2.getByText('Device not found')).toBeVisible();
  await p2.goto('/timeline');
  await expect(p2.getByText('No events match')).toBeVisible();
  await other.close();
});

test('settings, data export and mobile layout render', async ({ page }) => {
  const email = `e2e-settings-${Date.now()}@example.test`;
  await register(page, email);
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();
  await page.goto('/settings/data');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download export' }).click();
  expect((await download).suggestedFilename()).toMatch(/^tracevault-export-.*\.json$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dashboard');
  await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
  await page.screenshot({ path: `${shots}/mobile-dashboard.png`, fullPage: true });
});
