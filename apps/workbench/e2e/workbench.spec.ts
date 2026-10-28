import { expect, test, type Page } from '@playwright/test';

/** Fail the test on any console error or uncaught exception. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

async function noHorizontalScroll(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, 'page must not scroll sideways').toBeLessThanOrEqual(client);
}

const ROUTES = ['', 'compose', 'verify', 'inspect', 'vectors', 'errors', 'evidence'];

test('every page renders without console errors or sideways scrolling', async ({ page }) => {
  const errors = watchErrors(page);
  for (const r of ROUTES) {
    await page.goto(`./#/${r}`);
    await expect(page.locator('h1')).toBeVisible();
    await noHorizontalScroll(page);
  }
  expect(errors).toEqual([]);
});

test('compose, sign and verify a claim, then see expiry fail', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('./#/compose');
  await expect(page.getByText('Passes the off-chain checks now')).toBeVisible();
  await page.getByRole('button', { name: 'Open in Verify' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Verify' })).toBeVisible();
  await expect(page.getByText('Passes every check that can run off-chain')).toBeVisible();

  await page.getByLabel('Check at').selectOption('custom');
  await page.getByLabel('Unix time (seconds)').fill('18446744073709551615');
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.getByText('Fails at step 3: ClaimExpired')).toBeVisible();
  await expect(page.getByText(/On-chain this is error 1103/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('a flipped bit breaks the signature and the diff names the field', async ({ page }) => {
  await page.goto('./#/inspect');
  await expect(page.getByText('The signature matches these bytes')).toBeVisible();
  await page.getByRole('button', { name: 'Flip one bit in the subject' }).click();
  await expect(page.getByText('The signature does not match these bytes')).toBeVisible();
  await expect(page.getByText('1 field differ')).toBeVisible();
});

test('all shared vectors pass in a real browser', async ({ page }) => {
  await page.goto('./#/vectors');
  await expect(page.getByRole('heading', { name: '16 of 16 vectors pass' })).toBeVisible();
});

test('recorded Testnet claims re-verify offline', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith('http://localhost:4173/')) requests.push(r.url());
  });
  await page.goto('./#/evidence');
  await expect(page.getByText('Rebuilt preimage is byte-identical to the recorded one')).toHaveCount(3);
  await expect(page.getByText(/Signature verifies for this contract on Testnet/)).toHaveCount(3);
  expect(requests, 'the Workbench makes no network requests').toEqual([]);
});

test('keyboard: skip link reaches the content and the error lookup works', async ({ page, isMobile }) => {
  test.skip(isMobile, 'keyboard flow checked on desktop');
  await page.goto('./#/errors');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  await page.getByLabel('Error text or code').fill('HostError: Error(Contract, #1106)');
  await expect(page.getByText('1106 ClaimAlreadyUsed')).toBeVisible();
});
