import { Config } from '../config';
import { State } from '../state';
import type { ThemeColors, ThemeName } from '../types';

export function getActiveTheme(): ThemeName {
  const theme = document.documentElement.getAttribute('data-theme');
  return theme === 'light' || theme === 'dark' ? theme : 'dark';
}

export function hexToRgba(hex: string | undefined, alpha: number): string {
  const fallback = `rgba(136, 136, 136, ${alpha})`;
  if (!hex) return fallback;
  const normalized = hex.startsWith('#') ? hex : `#${hex}`;
  if (normalized.length < 7) return fallback;
  const r = parseInt(normalized.slice(1, 3), 16);
  const g = parseInt(normalized.slice(3, 5), 16);
  const b = parseInt(normalized.slice(5, 7), 16);
  if ([r, g, b].some((channel) => Number.isNaN(channel))) return fallback;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function getColorsForTheme(theme: ThemeName = getActiveTheme()): ThemeColors {
  const configColors = State.config.colors || Config.colors;
  const defaults = Config.colors[theme] || Config.colors.dark;

  if (configColors[theme]) {
    return { ...defaults, ...configColors[theme] };
  }

  if (configColors.raw || configColors.filtered) {
    return {
      ...defaults,
      raw: configColors.raw || defaults.raw,
      filtered: configColors.filtered || defaults.filtered,
      diffRaw: configColors.diffRaw || configColors.raw || defaults.diffRaw,
      diffFilt: configColors.diffFilt || configColors.filtered || defaults.diffFilt,
      transfer: configColors.transfer || defaults.transfer
    };
  }

  return defaults;
}
