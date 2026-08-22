import type { ThemeName } from '../types';
import { Graph } from './graph';

const STORAGE_KEY = 'filterpro-theme';

export const Theme = {
  current: 'dark' as ThemeName,

  init(toggleButton: HTMLButtonElement | null): void {
    const saved = localStorage.getItem(STORAGE_KEY);
    const prefersLight = window.matchMedia?.('(prefers-color-scheme: light)').matches;
    const initial = saved === 'light' || saved === 'dark'
      ? saved
      : prefersLight ? 'light' : 'dark';
    this.apply(initial, false);
    toggleButton?.addEventListener('click', () => {
      this.apply(this.current === 'dark' ? 'light' : 'dark');
    });
    this.updateToggle(toggleButton);
  },

  apply(theme: string, persist = true): void {
    this.current = theme === 'light' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', this.current);
    if (persist) localStorage.setItem(STORAGE_KEY, this.current);
    this.updateToggle(document.getElementById('btn-theme-toggle') as HTMLButtonElement | null);
    Graph.updateTheme();
  },

  updateToggle(button: HTMLButtonElement | null): void {
    if (!button) return;
    const isLight = this.current === 'light';
    const icon = button.querySelector('.theme-icon');
    const label = button.querySelector('.theme-label');
    if (icon) icon.textContent = isLight ? '🌞' : '🌙';
    if (label) label.textContent = isLight ? 'Light Mode' : 'Dark Mode';
    button.setAttribute('aria-pressed', isLight ? 'true' : 'false');
    button.title = isLight ? 'Switch to dark mode' : 'Switch to light mode';
  }
};
