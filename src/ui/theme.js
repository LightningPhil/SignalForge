import { Graph } from './graph.js';

const STORAGE_KEY = 'filterpro-theme';

export const Theme = {
    current: 'dark',

    init(toggleButton) {
        const saved = localStorage.getItem(STORAGE_KEY);
        const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
        const initialTheme = saved || (prefersLight ? 'light' : 'dark');

        this.apply(initialTheme, false);
        if (toggleButton) {
            toggleButton.addEventListener('click', () => {
                const next = this.current === 'dark' ? 'light' : 'dark';
                this.apply(next);
            });
            this.updateToggle(toggleButton);
        }
    },

    apply(theme, persist = true) {
        this.current = theme === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', this.current);
        if (persist) localStorage.setItem(STORAGE_KEY, this.current);

        this.updateToggle(document.getElementById('btn-theme-toggle'));
        if (Graph.updateTheme) Graph.updateTheme();
    },

    updateToggle(button) {
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
