import { expect, test } from '@playwright/test';

const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

test('traps Tab within a dialog and restores focus when it closes', async ({ page }) => {
  await page.goto('./');
  const addButton = page.getByRole('button', { name: '➕ Add' });
  await addButton.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const focusableCount = await dialog.locator(focusableSelector).evaluateAll((elements) => {
    const focusable = elements.filter(
      (element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true'
    ) as HTMLElement[];
    focusable.at(0)?.setAttribute('data-e2e-focus-edge', 'first');
    focusable.at(-1)?.setAttribute('data-e2e-focus-edge', 'last');
    return focusable.length;
  });
  expect(focusableCount).toBeGreaterThan(1);

  const first = dialog.locator('[data-e2e-focus-edge="first"]');
  const last = dialog.locator('[data-e2e-focus-edge="last"]');
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();

  await first.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(addButton).toBeFocused();
});

test('Escape closes stacked dialogs from the top down', async ({ page }) => {
  await page.goto('./');
  await page.locator('#file-input').setInputFiles({
    name: 'accessible-dialogs.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Time,Voltage\n0,0\n0.001,1\n')
  });
  await page.getByRole('button', { name: 'Use row 1 as header' }).click();

  await page.getByRole('button', { name: 'Add Multi-View or Math Trace' }).click();
  await page.getByRole('button', { name: 'Math Trace Tab' }).click();
  const mathDialog = page.getByRole('dialog').filter({ hasText: 'Create Advanced Math Trace' });
  await expect(mathDialog).toBeVisible();

  await mathDialog.getByRole('button', { name: 'Open math help' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(2);

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(mathDialog).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('exposes the theme toggle state through aria-pressed', async ({ page }) => {
  await page.goto('./');
  const themeButton = page.getByRole('button', { name: /Mode/ });
  const initial = await themeButton.getAttribute('aria-pressed');
  expect(initial).toMatch(/^(?:true|false)$/);

  const toggled = initial === 'true' ? 'false' : 'true';
  await themeButton.click();
  await expect(themeButton).toHaveAttribute('aria-pressed', toggled);

  await themeButton.click();
  await expect(themeButton).toHaveAttribute('aria-pressed', initial!);
});

test('keeps interactive controls named and document ids unique', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: /Export/ }).click();
  const audit = await page.evaluate(() => {
    const ids = [...document.querySelectorAll<HTMLElement>('[id]')].map((element) => element.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    const unnamedButtons = [...document.querySelectorAll<HTMLButtonElement>('button')].filter(
      (button) =>
        !button.disabled &&
        !button.hidden &&
        !(button.getAttribute('aria-label') || button.getAttribute('aria-labelledby') || button.textContent?.trim())
    ).length;
    const unnamedFields = [
      ...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        'input:not([type="hidden"]), select, textarea'
      )
    ]
      .filter((field) => {
        const labels = field.labels;
        return !(
          field.getAttribute('aria-label') ||
          field.getAttribute('aria-labelledby') ||
          (labels && labels.length > 0)
        );
      })
      .map((field) => field.id || field.outerHTML);
    return { duplicates: [...new Set(duplicates)], unnamedButtons, unnamedFields };
  });

  expect(audit.duplicates).toEqual([]);
  expect(audit.unnamedButtons).toBe(0);
  expect(audit.unnamedFields).toEqual([]);
  await expect(page.getByRole('dialog')).toHaveAttribute('aria-labelledby', /modal-title-/);
  await expect(page.getByRole('button', { name: 'Close dialog' })).toBeVisible();
});
