import { expect, test } from '@playwright/test';

test('applies marker-aware and reference processing with recipe undo and redo', async ({ page }) => {
  await page.goto('./');
  const rows = ['Time,Signal,Reference'];
  for (let index = 0; index < 256; index += 1) {
    rows.push(`${index * 1e-6},${5 + Math.sin(index * 0.08)},${0.1 * Math.sin(index * 0.08)}`);
  }
  await page.locator('#file-input').setInputFiles({
    name: 'contextual-processing.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(rows.join('\n'))
  });
  await page.getByRole('button', { name: 'Use row 1 as header' }).click();

  await page.getByRole('button', { name: /Sessions/ }).click();
  const review = page.getByRole('dialog').filter({ hasText: 'Session Review' });
  await review.getByRole('button', { name: 'Capture current data as shot' }).click();
  await review.locator('#review-marker-name').fill('pretrigger');
  await review.locator('#review-marker-time').fill('0');
  await review.locator('#review-marker-end').fill('0.00002');
  await review.getByRole('button', { name: 'Add', exact: true }).click();
  await review.getByRole('button', { name: 'Close dialog' }).click();

  await page.getByRole('button', { name: '➕ Add' }).click();
  await page.getByRole('button', { name: 'Baseline Subtract' }).click();
  await expect(page.locator('#step-type-display')).toHaveText('Marker/Region Baseline Subtract');
  await page.locator('#param-region-mode').selectOption('region-marker');
  await page.locator('#param-region-marker').fill('pretrigger');
  await expect(page.locator('#pipeline-list')).toContainText(/Baseline \(region-marker, median\).*changed 256\/256/);

  await expect(page.locator('#btn-undo-pipeline')).toBeEnabled();
  await page.locator('#btn-undo-pipeline').click();
  await expect(page.locator('#btn-redo-pipeline')).toBeEnabled();
  await page.locator('#btn-redo-pipeline').click();

  await page.getByRole('button', { name: '➕ Add' }).click();
  await page.getByRole('button', { name: 'Reference/Common-Mode Subtract' }).click();
  await expect(page.locator('#param-reference-column')).toHaveValue('Reference');
  await expect(page.locator('#pipeline-list')).toContainText(/Reference.*changed 255\/256/);
});
