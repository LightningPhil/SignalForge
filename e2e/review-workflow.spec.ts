import { expect, test } from '@playwright/test';

function reviewCsv(sampleCount = 512): Buffer {
  const rows = ['Time,Voltage,Current'];
  for (let index = 0; index < sampleCount; index += 1) {
    const time = index * 1e-6;
    rows.push(`${time},${Math.sin(2 * Math.PI * 25_000 * time)},${Math.cos(2 * Math.PI * 25_000 * time)}`);
  }
  return Buffer.from(rows.join('\n'));
}

test('supports queue-based keyboard review, visible autosave, and aligned spectrogram comparison', async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto('./');
  await page.locator('#file-input').setInputFiles({
    name: 'review-workflow.csv',
    mimeType: 'text/csv',
    buffer: reviewCsv()
  });
  await page.getByRole('button', { name: 'Use row 1 as header' }).click();
  await page.getByRole('button', { name: /Sessions/ }).click();

  const review = page.getByRole('dialog').filter({ hasText: 'Session Review' });
  await review.getByRole('button', { name: 'Capture current data as shot' }).click();
  await review.locator('#review-status').selectOption('accepted');
  await review.getByRole('button', { name: 'Capture current data as shot' }).click();
  await review.locator('#review-status').selectOption('excluded');
  await review.getByRole('button', { name: 'Capture current data as shot' }).click();

  await expect(review.locator('#review-progress-summary')).toContainText('1/3 accepted');
  await expect(review.locator('#review-progress-summary')).toContainText('1 excluded');
  await expect(review.locator('#review-save-state')).toContainText('Saved', { timeout: 5_000 });

  await review.getByRole('button', { name: 'Excluded', exact: true }).click();
  await expect(review.locator('[data-shot-id]')).toHaveCount(1);
  await review.getByRole('button', { name: 'All', exact: true }).click();
  await expect(review.locator('[data-shot-id]')).toHaveCount(3);

  const reviewPlot = review.locator('#review-waveform-plot');
  await expect(reviewPlot.locator('.plot-container')).toBeVisible();
  await reviewPlot.focus();
  await page.keyboard.press('Enter');
  await expect(review.locator('[data-annotation-time]').first().locator('..')).toContainText('flashover');
  await expect(review.locator('[data-annotation-time]').first().locator('..')).toContainText('manual');

  await review.getByRole('button', { name: 'Compare shots' }).click();
  const comparison = page.getByRole('dialog').filter({ hasText: 'Event-aligned Comparison' });
  await comparison.locator('#ensemble-mode').selectOption('spectrogram');
  await comparison.getByRole('button', { name: 'Render comparison' }).click();
  await expect(comparison.locator('#ensemble-plot .heatmaplayer')).toBeVisible();
  await expect(comparison.locator('#ensemble-warning')).toContainText('missing');
});
