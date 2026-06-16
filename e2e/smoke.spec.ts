import { test, expect } from '@playwright/test';

/**
 * Smoke E2E: the app boots, redirects to the dashboard, and renders the core
 * shell in mock-demo mode (no wallet required). Exercises the real built app.
 */

test('root redirects to the dashboard', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/dashboard/);
});

test('dashboard renders the escrow register and stats', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: /Escrow Registers/i })).toBeVisible();
  // Mock demo data shows at least one escrow card.
  await expect(page.getByText(/Escrow #/).first()).toBeVisible();
});

test('demo mode exposes the create-escrow action', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.getByRole('button', { name: /New Escrow/i })).toBeVisible();
});
