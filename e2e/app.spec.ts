import { expect, test } from '@playwright/test';
import path from 'node:path';

test('loads the compiled application shell with styling', async ({ page }) => {
  const response = await page.goto('./');

  expect(response?.ok()).toBe(true);
  await expect(page).toHaveTitle('Signal Forge');
  await expect(page.getByRole('heading', { name: 'Signal Forge' })).toBeVisible();
  await expect(page.locator('#main-plot .plot-container')).toBeVisible();

  const headerBackground = await page
    .locator('header')
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(headerBackground).not.toBe('rgba(0, 0, 0, 0)');
  const serviceWorkerUrl = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL);
  expect(serviceWorkerUrl).toContain('/SignalForge/sw.js');
  expect(await page.locator('#app-sidebar').evaluate((element) => getComputedStyle(element).scrollbarGutter)).toContain(
    'stable'
  );
});

test('theme and help controls are interactive', async ({ page }) => {
  await page.goto('./');

  const themeButton = page.getByRole('button', { name: /Mode/ });
  const initialTheme = await page.locator('html').getAttribute('data-theme');
  await themeButton.click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', initialTheme ?? '');

  await page.getByRole('button', { name: '❓ Help' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Signal Forge Overview' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('enforces Savitzky-Golay window minima in the filter editor', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: '➕ Add' }).click();
  await page.getByRole('button', { name: 'Savitzky-Golay' }).click();

  await expect(page.locator('#param-window')).toHaveAttribute('min', '3');
  await expect(page.locator('#slider-window')).toHaveAttribute('min', '3');
  await page.locator('#param-window').fill('1');
  await expect(page.locator('#param-window')).toHaveValue('3');
});

test('adds a specification-driven FIR filter and plots its exact response', async ({ page }) => {
  test.setTimeout(45_000);
  const consoleMessages: string[] = [];
  page.on('console', (message) => consoleMessages.push(message.text()));
  await page.goto('./');
  await page.evaluate(() => {
    const NativeWorker = window.Worker;
    class CountingWorker extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        const tracked = window as typeof window & { __signalforgeWorkerCount?: number };
        tracked.__signalforgeWorkerCount = (tracked.__signalforgeWorkerCount || 0) + 1;
      }
    }
    window.Worker = CountingWorker;
  });
  const rows = ['Time,Voltage'];
  for (let index = 0; index < 256; index += 1) {
    rows.push(`${index / 1000},${Math.sin((2 * Math.PI * 50 * index) / 1000)}`);
  }
  await page.locator('#file-input').setInputFiles({
    name: 'fir.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(rows.join('\n'))
  });
  await page.getByRole('button', { name: 'Use row 1 as header' }).click();

  await page.getByRole('button', { name: '➕ Add' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Designed FIR Filters');
  await expect(dialog).toContainText('IIR Filters');
  await dialog.getByRole('button', { name: 'Kaiser FIR Low Pass' }).click();
  await expect(page.getByRole('listbox', { name: 'Filter steps' })).toContainText('FIR LP');
  await expect(page.locator('#group-fir-advanced')).toBeVisible();
  await expect(page.locator('#param-processing-mode option[value="zero-phase"]')).toHaveText(
    'Centered zero-phase (one pass)'
  );
  await expect(page.locator('#fir-design-summary')).toContainText('achieved ripple');

  await page.locator('#param-fir-transition').fill('15');
  await page.locator('#unit-fir-transition').selectOption('1');
  await page.locator('#param-fir-attenuation').fill('160');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { __signalforgeWorkerCount?: number }).__signalforgeWorkerCount || 0
      )
    )
    .toBeGreaterThan(0);
  const themeBeforeWorkerCompletion = await page.locator('html').getAttribute('data-theme');
  await page.getByRole('button', { name: /Mode/ }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', themeBeforeWorkerCompletion || '');
  await expect(page.locator('#fir-design-summary')).toContainText('stopband ≥ 160');

  await page.getByRole('button', { name: 'Spectral', exact: true }).click();
  await page.locator('#fft-view').selectOption('both');
  await page.locator('#live-view-mode').selectOption('fft');
  await expect
    .poll(() =>
      page.locator('#main-plot').evaluate((element) => {
        const plot = element as HTMLElement & { data?: Array<{ name?: string }> };
        return (plot.data || []).map((trace) => trace.name);
      })
    )
    .toEqual(expect.arrayContaining(['FIR Response', 'FIR Response Phase', 'FIR Group Delay']));

  await page.locator('#live-view-mode').selectOption('time');
  await page.getByRole('button', { name: 'Filter', exact: true }).click();
  await page.locator('#param-fir-transition').fill('0.000001');
  await expect(page.locator('#live-status')).toContainText('tap safety limit');
  expect(consoleMessages.some((message) => message.includes('using the synchronous path'))).toBe(false);
});

test('does not claim an LTI or causal FIR response after non-uniform resampling', async ({ page }) => {
  await page.goto('./');
  const rows = ['Time,Voltage'];
  for (let index = 0; index < 128; index += 1) {
    const time = index / 1000 + (index % 3 === 0 ? 0.00008 : 0);
    rows.push(`${time},${Math.sin((2 * Math.PI * 50 * index) / 1000)}`);
  }
  await page.locator('#file-input').setInputFiles({
    name: 'nonuniform-fir.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(rows.join('\n'))
  });
  await page.getByRole('button', { name: 'Use row 1 as header' }).click();
  await page.getByRole('button', { name: '➕ Add' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Kaiser FIR Low Pass' }).click();

  await page.locator('#live-view-mode').selectOption('fft');
  await expect(page.locator('#live-status')).toContainText('FIR response hidden');
  const names = await page.locator('#main-plot').evaluate((element) => {
    const plot = element as HTMLElement & { data?: Array<{ name?: string }> };
    return (plot.data || []).map((trace) => trace.name);
  });
  expect(names).not.toContain('FIR Response');

  await page.locator('#live-view-mode').selectOption('time');
  await page.locator('#param-processing-mode').selectOption('causal');
  await expect(page.locator('#live-status')).toContainText('Causal FIR filtering requires a uniform timebase');
});

test('routes expensive FIR processing for Multi View through workers', async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto('./');
  await page.evaluate(() => {
    const NativeWorker = window.Worker;
    class CountingWorker extends NativeWorker {
      constructor(scriptURL: string | URL, options?: WorkerOptions) {
        super(scriptURL, options);
        const tracked = window as typeof window & { __signalforgeWorkerCount?: number };
        tracked.__signalforgeWorkerCount = (tracked.__signalforgeWorkerCount || 0) + 1;
      }
    }
    window.Worker = CountingWorker;
  });
  const rows = ['Time,Voltage,Current'];
  for (let index = 0; index < 256; index += 1) {
    rows.push(
      `${index / 1000},${Math.sin((2 * Math.PI * 50 * index) / 1000)},${Math.cos((2 * Math.PI * 40 * index) / 1000)}`
    );
  }
  await page.locator('#file-input').setInputFiles({
    name: 'fir-multiview.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(rows.join('\n'))
  });
  await page.getByRole('button', { name: 'Use row 1 as header' }).click();
  await page.getByRole('button', { name: '➕ Add' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Kaiser FIR Low Pass' }).click();
  await page.locator('#param-fir-transition').fill('15');
  await page.locator('#unit-fir-transition').selectOption('1');
  await page.locator('#param-fir-attenuation').fill('160');
  await expect(page.locator('#fir-design-summary')).toContainText('stopband ≥ 160');

  await page.locator('#btn-add-multiview').click();
  await page.getByRole('dialog').getByRole('button', { name: 'Multi-View Tab' }).click();
  await expect(page.locator('#live-status')).toContainText('Multi-View');
  await page.evaluate(() => {
    (window as typeof window & { __signalforgeWorkerCount?: number }).__signalforgeWorkerCount = 0;
  });
  await page.locator('#trace-selector-list input[data-col="Current"]').check();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as typeof window & { __signalforgeWorkerCount?: number }).__signalforgeWorkerCount || 0
      )
    )
    .toBeGreaterThan(0);
  const initialTheme = await page.locator('html').getAttribute('data-theme');
  await page.getByRole('button', { name: /Mode/ }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', initialTheme || '');
});

test('imports a synthetic CSV and renders its channel', async ({ page }) => {
  await page.goto('./');

  await page.locator('#file-input').setInputFiles({
    name: 'synthetic.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Time,Voltage,Current\n0,0,0\n0.001,1,2\n0.002,0,0\n')
  });

  await page.getByRole('button', { name: 'Use row 1 as header' }).click();
  await expect(page.locator('#live-status')).toHaveText('Ready');
  await expect(page.locator('#column-tabs')).toContainText('Voltage');
  await expect(page.locator('#main-plot .scatterlayer')).toBeVisible();
});

test('adds a designed IIR filter and captures a reviewed session shot', async ({ page }) => {
  await page.goto('./');
  await page.locator('#file-input').setInputFiles({
    name: 'review.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Time,Voltage,Current\n0,0,0\n0.001,1,2\n0.002,0,0\n')
  });
  await page.getByRole('button', { name: 'Use row 1 as header' }).click();

  await page.getByRole('button', { name: '➕ Add' }).click();
  await page.getByRole('button', { name: 'Butterworth Low Pass' }).click();
  await expect(page.getByRole('listbox', { name: 'Filter steps' })).toContainText('Butterworth LP');
  await expect(page.locator('#param-processing-mode')).toHaveValue('zero-phase');
  await page.locator('#live-show-residual').check();
  await expect(page.locator('#main-plot')).toContainText('Raw − Processed Residual');
  await page.getByRole('button', { name: 'Spectral', exact: true }).click();
  await page.locator('#fft-view').selectOption('both');
  await page.locator('#live-view-mode').selectOption('fft');
  await expect
    .poll(() =>
      page.locator('#main-plot').evaluate((element) => {
        const plot = element as HTMLElement & {
          data?: Array<{ name?: string; yaxis?: string }>;
        };
        return Object.fromEntries((plot.data || []).map((trace) => [trace.name, trace.yaxis || 'y']));
      })
    )
    .toMatchObject({
      'Filtered Phase': 'y2',
      'IIR Response': 'y',
      'IIR Response Phase': 'y2',
      'IIR Group Delay': 'y3'
    });
  await page.locator('#live-view-mode').selectOption('time');

  await page.getByRole('button', { name: '🗂️ Sessions' }).click();
  await page.getByRole('button', { name: 'Capture current data as shot' }).click();
  await expect(page.getByRole('heading', { name: 'Session Review' })).toBeVisible();
  await expect(page.getByRole('button', { name: /review\.csv 1 · unreviewed/ })).toBeVisible();
  await expect(page.locator('#review-waveform-plot .plot-container')).toBeVisible();

  await page.locator('#review-marker-time').fill('0.001');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('manual/accepted');
});

test('opens a fixture-verified Keysight BIN directly', async ({ page }) => {
  await page.goto('./');
  await page
    .locator('#file-input')
    .setInputFiles(
      path.resolve(
        'reference-material/SignalForge-scope-import-examples/fixtures/keysight/keysight_dsox1102g_single_channel.bin'
      )
    );

  await expect(page.locator('#live-status')).toHaveText('Ready');
  await expect(page.locator('#column-tabs')).toContainText('CH1');
  await expect(page.locator('#main-plot .scatterlayer')).toBeVisible();
});

test('keeps the newest direct native import when selections overlap', async ({ page }) => {
  await page.goto('./');
  await page
    .locator('#file-input')
    .setInputFiles(
      path.resolve(
        'reference-material/SignalForge-scope-import-examples/fixtures/tektronix/fastframe_5mhz_100frames.wfm'
      )
    );
  await page
    .locator('#file-input')
    .setInputFiles(
      path.resolve(
        'reference-material/SignalForge-scope-import-examples/fixtures/keysight/keysight_dsox1102g_single_channel.bin'
      )
    );

  await expect(page.locator('#live-status')).toHaveText('Ready');
  await expect(page.locator('#column-tabs')).toContainText('CH1');
  await expect(page.locator('#column-tabs')).not.toContainText('Waveform');
  await page.getByRole('button', { name: '🗂️ Sessions' }).click();
  await expect(page.locator('#review-saved-session')).not.toContainText('fastframe_5mhz_100frames');
});

test('pairs and imports a fixture-verified R&S RTx waveform', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: '📥 Multi Import' }).click();
  await page.locator('#multi-use-profile').uncheck();
  await page
    .locator('#multi-files')
    .setInputFiles([
      path.resolve(
        'reference-material/SignalForge-scope-import-examples/fixtures/rohde_schwarz/rs_rtp_two_channel.bin'
      ),
      path.resolve(
        'reference-material/SignalForge-scope-import-examples/fixtures/rohde_schwarz/rs_rtp_two_channel.Wfm.bin'
      )
    ]);
  await page.getByRole('button', { name: 'Preview extraction' }).click();
  await expect(page.locator('#multi-preview-table')).toContainText(
    'rs_rtp_two_channel.bin + rs_rtp_two_channel.Wfm.bin'
  );
  await expect(page.locator('#multi-preview-table')).toContainText('R&S RTx waveform pair');

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Import matched files' }).click();
  await page.getByRole('button', { name: '🗂️ Sessions' }).click();
  await expect(page.getByRole('button', { name: /rs_rtp_two_channel 1 · unreviewed/ })).toBeVisible();
  await expect(page.locator('#review-waveform-plot .plot-container')).toBeVisible();
});

test('previews filename metadata and groups a multi-file shot', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: '📥 Multi Import' }).click();
  await page.locator('#multi-files').setInputFiles([
    {
      name: 'shot 7 - 25kV - 200mm - Voltage.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Time (s),Voltage (V)\n0,0\n0.001,1\n')
    },
    {
      name: 'shot 7 - 25kV - 200mm - Current.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('Time (s),Current (A)\n0,0\n0.001,2\n')
    }
  ]);
  await page.getByRole('button', { name: 'Preview extraction' }).click();
  await expect(page.locator('#multi-preview-table')).toContainText('25000');
  await expect(page.locator('#multi-preview-table')).toContainText('Delimited text');

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Import matched files' }).click();
  await page.getByRole('button', { name: '🗂️ Sessions' }).click();
  await expect(page.getByRole('button', { name: /Shot 7 1 · unreviewed/ })).toBeVisible();
  await expect(page.locator('#review-waveform-plot .plot-container')).toBeVisible();
});

test('imports arbitrary supported filenames without a convention profile', async ({ page }) => {
  await page.goto('./');
  await page.getByRole('button', { name: '📥 Multi Import' }).click();
  await page.locator('#multi-use-profile').uncheck();
  await expect(page.locator('#multi-profile-example')).toContainText('any supported filename');
  await page.locator('#multi-files').setInputFiles({
    name: 'anything the instrument produced.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('Time (s),Voltage (V)\n0,0\n0.001,1\n')
  });
  await page.getByRole('button', { name: 'Preview extraction' }).click();
  await expect(page.locator('#multi-preview-table')).toContainText('anything the instrument produced.csv');

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Import matched files' }).click();
  await page.getByRole('button', { name: '🗂️ Sessions' }).click();
  await expect(page.getByRole('button', { name: /anything the instrument produced 1 · unreviewed/ })).toBeVisible();
});
