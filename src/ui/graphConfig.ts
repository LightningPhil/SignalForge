import { runPipelineAndRender } from '../app/dataPipeline';
import { renderColumnTabs } from '../app/tabs';
import { Config } from '../config';
import { State } from '../state';
import type { AxisFormat, ThemeColors, ThemeName } from '../types';
import { ui } from './classes';
import { closeModal, createModal, escapeHtml } from './uiHelpers';

const AXIS_FORMATS: Array<{ value: AxisFormat; label: string }> = [
  { value: 'decimal', label: 'Decimal Notation' },
  { value: 'scientific', label: 'Scientific Notation' },
  { value: 'integer', label: 'Integer Format' },
  { value: 'currency', label: 'Currency Format' },
  { value: 'percentage', label: 'Percentage Format' },
  { value: 'datetime', label: 'Date and Time Format' },
  { value: 'engineering', label: 'Engineering Notation' }
];

const CURRENCY_OPTIONS = [
  { label: 'British Pound (£)', value: '£' },
  { label: 'US Dollar ($)', value: '$' },
  { label: 'Euro (€)', value: '€' },
  { label: 'Japanese Yen (¥)', value: '¥' },
  { label: 'Chinese Yuan (¥)', value: '¥' },
  { label: 'Indian Rupee (₹)', value: '₹' },
  { label: 'South Korean Won (₩)', value: '₩' },
  { label: 'Russian Ruble (₽)', value: '₽' },
  { label: 'Australian Dollar (A$)', value: 'A$' },
  { label: 'Canadian Dollar (C$)', value: 'C$' },
  { label: 'Swiss Franc (CHF)', value: 'CHF' },
  { label: 'Hong Kong Dollar (HK$)', value: 'HK$' },
  { label: 'New Zealand Dollar (NZ$)', value: 'NZ$' },
  { label: 'Singapore Dollar (S$)', value: 'S$' },
  { label: 'Brazilian Real (R$)', value: 'R$' },
  { label: 'Turkish Lira (₺)', value: '₺' },
  { label: 'Thai Baht (฿)', value: '฿' }
];

function isAxisFormat(value: string): value is AxisFormat {
  return AXIS_FORMATS.some((opt) => opt.value === value);
}

export const GraphConfig = {
  show(): void {
    const config = State.config.graph;
    const colors = State.config.colors || Config.colors;
    const headers = State.data.headers;

    const getThemeColor = (theme: ThemeName, key: keyof ThemeColors): string => {
      const themed = colors[theme];
      if (themed && themed[key]) return themed[key];
      const legacy = colors[key];
      if (typeof legacy === 'string') return legacy;
      return Config.colors[theme][key] || Config.colors.dark[key];
    };

    const createFormatOptions = (selectedVal: string) =>
      AXIS_FORMATS.map(
        (opt) => `<option value="${opt.value}" ${opt.value === selectedVal ? 'selected' : ''}>${opt.label}</option>`
      ).join('');

    const xFormat = config.xAxisFormat || (config.useScientificNotation ? 'scientific' : 'decimal');
    const yFormat = config.yAxisFormat || (config.useScientificNotation ? 'scientific' : 'decimal');
    const currencySymbol = config.currencySymbol || '£';
    const sigFigs = config.significantFigures || 3;

    const createCurrencyOptions = () =>
      CURRENCY_OPTIONS.map(
        (opt) =>
          `<option value="${escapeHtml(opt.value)}" ${opt.value === currencySymbol ? 'selected' : ''}>${opt.label}</option>`
      ).join('');

    const createOptions = (selectedVal: string | null) =>
      headers
        .map((h) => `<option value="${escapeHtml(h)}" ${h === selectedVal ? 'selected' : ''}>${escapeHtml(h)}</option>`)
        .join('');

    const html = `
      <h3 class="${ui.modalTitle}">Graph Configuration</h3>
      <div class="flex flex-col gap-5 md:flex-row">
        <div class="min-w-0 flex-1">
          <section class="${ui.modalPanel}">
            <h4 class="mb-2 font-semibold">Axes Setup</h4>
            <label class="sf-label" for="gc-x-col">X-Axis Column</label>
            <select id="gc-x-col" class="sf-field">${createOptions(State.data.timeColumn)}</select>
            <small class="sf-hint">Y-Axis is selected via Tabs above the graph.</small>
          </section>
          <section class="${ui.modalPanel}">
            <h4 class="mb-2 font-semibold">Labels</h4>
            <label class="sf-label" for="gc-title">Graph Title</label>
            <input id="gc-title" class="sf-field" type="text" value="${escapeHtml(config.title)}">
            <label class="sf-label" for="gc-xlabel">X-Axis Label</label>
            <input id="gc-xlabel" class="sf-field" type="text" value="${escapeHtml(config.xAxisTitle)}">
            <label class="sf-label" for="gc-ylabel">Y-Axis Label</label>
            <input id="gc-ylabel" class="sf-field" type="text" value="${escapeHtml(config.yAxisTitle)}">
          </section>
        </div>
        <div class="min-w-0 flex-1">
          <section class="${ui.modalPanel}">
            <h4 class="mb-2 font-semibold">Trace Colors</h4>
            <div class="mb-3 rounded-md border border-line bg-panel p-3">
              <h5 class="mb-2 font-medium">Light Mode</h5>
              <div class="mb-2.5 flex items-center gap-2.5">
                <input type="color" id="gc-col-light-raw" class="h-9 w-12 cursor-pointer border-0 bg-transparent p-0" value="${getThemeColor('light', 'raw')}" aria-label="Light raw color">
                <label class="m-0 text-sm" for="gc-col-light-raw">Raw Data Color</label>
              </div>
              <div class="flex items-center gap-2.5">
                <input type="color" id="gc-col-light-filt" class="h-9 w-12 cursor-pointer border-0 bg-transparent p-0" value="${getThemeColor('light', 'filtered')}" aria-label="Light filtered color">
                <label class="m-0 text-sm" for="gc-col-light-filt">Filtered Data Color</label>
              </div>
            </div>
            <div class="rounded-md border border-line bg-panel p-3">
              <h5 class="mb-2 font-medium">Dark Mode</h5>
              <div class="mb-2.5 flex items-center gap-2.5">
                <input type="color" id="gc-col-dark-raw" class="h-9 w-12 cursor-pointer border-0 bg-transparent p-0" value="${getThemeColor('dark', 'raw')}" aria-label="Dark raw color">
                <label class="m-0 text-sm" for="gc-col-dark-raw">Raw Data Color</label>
              </div>
              <div class="flex items-center gap-2.5">
                <input type="color" id="gc-col-dark-filt" class="h-9 w-12 cursor-pointer border-0 bg-transparent p-0" value="${getThemeColor('dark', 'filtered')}" aria-label="Dark filtered color">
                <label class="m-0 text-sm" for="gc-col-dark-filt">Filtered Data Color</label>
              </div>
            </div>
          </section>
          <section class="${ui.modalPanel}">
            <h4 class="mb-2 font-semibold">Display Options</h4>
            <label class="sf-label" for="gc-x-format">X-Axis Format</label>
            <select id="gc-x-format" class="sf-field">${createFormatOptions(xFormat)}</select>
            <label class="sf-label" for="gc-y-format">Y-Axis Format</label>
            <select id="gc-y-format" class="sf-field">${createFormatOptions(yFormat)}</select>
            <label class="sf-label" for="gc-sig-figs">Scientific Significant Figures</label>
            <input id="gc-sig-figs" class="sf-field" type="number" min="1" max="10" value="${sigFigs}">
            <small class="sf-hint">Controls precision for scientific and engineering formats.</small>
            <div id="gc-currency-wrapper" class="hidden">
              <label class="sf-label" for="gc-currency-symbol">Currency Symbol</label>
              <select id="gc-currency-symbol" class="sf-field">${createCurrencyOptions()}</select>
            </div>
            <label class="${ui.toggleLabel} mt-3">
              <input type="checkbox" id="gc-log" class="h-4 w-4 accent-accent" ${config.logScaleY ? 'checked' : ''}>
              Logarithmic Y-Scale
            </label>
            <hr class="my-3 border-line opacity-50">
            <label class="${ui.toggleLabel}">
              <input type="checkbox" id="gc-downsample" class="h-4 w-4 accent-accent" ${config.enableDownsampling ? 'checked' : ''}>
              Smart Downsampling
            </label>
            <small class="sf-hint">Improves performance for large datasets.</small>
          </section>
        </div>
      </div>
      <button id="btn-save-gc" class="sf-btn sf-btn-primary mt-2" type="button">Update Graph</button>
    `;

    const modal = createModal(html);
    const currencyWrapper = modal.querySelector('#gc-currency-wrapper');
    const xFormatEl = modal.querySelector<HTMLSelectElement>('#gc-x-format');
    const yFormatEl = modal.querySelector<HTMLSelectElement>('#gc-y-format');

    const toggleCurrencyVisibility = () => {
      const shouldShow = xFormatEl?.value === 'currency' || yFormatEl?.value === 'currency';
      currencyWrapper?.classList.toggle('hidden', !shouldShow);
    };

    toggleCurrencyVisibility();
    xFormatEl?.addEventListener('change', toggleCurrencyVisibility);
    yFormatEl?.addEventListener('change', toggleCurrencyVisibility);

    modal.querySelector('#btn-save-gc')?.addEventListener('click', () => {
      const xCol = modal.querySelector<HTMLSelectElement>('#gc-x-col')?.value;
      if (xCol) State.data.timeColumn = xCol;

      const cfg = State.config.graph;
      cfg.title = modal.querySelector<HTMLInputElement>('#gc-title')?.value ?? cfg.title;
      cfg.xAxisTitle = modal.querySelector<HTMLInputElement>('#gc-xlabel')?.value ?? cfg.xAxisTitle;
      cfg.yAxisTitle = modal.querySelector<HTMLInputElement>('#gc-ylabel')?.value ?? cfg.yAxisTitle;
      const nextX = xFormatEl?.value ?? cfg.xAxisFormat;
      const nextY = yFormatEl?.value ?? cfg.yAxisFormat;
      if (isAxisFormat(nextX)) cfg.xAxisFormat = nextX;
      if (isAxisFormat(nextY)) cfg.yAxisFormat = nextY;
      cfg.currencySymbol = modal.querySelector<HTMLSelectElement>('#gc-currency-symbol')?.value || cfg.currencySymbol;
      cfg.significantFigures =
        Number.parseInt(modal.querySelector<HTMLInputElement>('#gc-sig-figs')?.value || '3', 10) || 3;
      cfg.logScaleY = !!modal.querySelector<HTMLInputElement>('#gc-log')?.checked;
      cfg.enableDownsampling = !!modal.querySelector<HTMLInputElement>('#gc-downsample')?.checked;

      const lightRaw = modal.querySelector<HTMLInputElement>('#gc-col-light-raw')?.value || Config.colors.light.raw;
      const lightFilt =
        modal.querySelector<HTMLInputElement>('#gc-col-light-filt')?.value || Config.colors.light.filtered;
      const darkRaw = modal.querySelector<HTMLInputElement>('#gc-col-dark-raw')?.value || Config.colors.dark.raw;
      const darkFilt = modal.querySelector<HTMLInputElement>('#gc-col-dark-filt')?.value || Config.colors.dark.filtered;

      State.config.colors.light = {
        ...Config.colors.light,
        ...(State.config.colors.light || {}),
        raw: lightRaw,
        filtered: lightFilt,
        diffRaw: lightRaw,
        diffFilt: lightFilt
      };
      State.config.colors.dark = {
        ...Config.colors.dark,
        ...(State.config.colors.dark || {}),
        raw: darkRaw,
        filtered: darkFilt,
        diffRaw: darkRaw,
        diffFilt: darkFilt
      };

      renderColumnTabs();
      runPipelineAndRender();
      closeModal(modal);
    });
  }
};
