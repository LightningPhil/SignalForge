import { State } from '../state.js';
import { createModal } from './uiHelpers.js';
import { Graph } from './graph.js';
import { Config } from '../config.js';

/**
 * Graph Configuration UI
 */
export const GraphConfig = {
    
    show() {
        const config = State.config.graph;
        const colors = State.config.colors || Config.colors;
        const headers = State.data.headers;

        const getThemeColor = (theme, key) => {
            if (colors[theme] && colors[theme][key]) return colors[theme][key];
            if (colors[key]) return colors[key];
            if (Config.colors[theme] && Config.colors[theme][key]) return Config.colors[theme][key];
            return Config.colors.dark[key];
        };

        const createFormatOptions = (selectedVal) => {
            const options = [
                { value: 'decimal', label: 'Decimal Notation' },
                { value: 'scientific', label: 'Scientific Notation' },
                { value: 'integer', label: 'Integer Format' },
                { value: 'currency', label: 'Currency Format' },
                { value: 'percentage', label: 'Percentage Format' },
                { value: 'datetime', label: 'Date and Time Format' },
                { value: 'engineering', label: 'Engineering Notation' }
            ];

            return options.map(opt =>
                `<option value="${opt.value}" ${opt.value === selectedVal ? 'selected' : ''}>${opt.label}</option>`
            ).join('');
        };

        const xFormat = config.xAxisFormat || (config.useScientificNotation ? 'scientific' : 'decimal');
        const yFormat = config.yAxisFormat || (config.useScientificNotation ? 'scientific' : 'decimal');
        const currencySymbol = config.currencySymbol || '£';

        const currencyOptions = [
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

        const createCurrencyOptions = () => currencyOptions.map(opt =>
            `<option value="${opt.value}" ${opt.value === currencySymbol ? 'selected' : ''}>${opt.label}</option>`
        ).join('');

        const createOptions = (selectedVal) => {
            return headers.map(h =>
                `<option value="${h}" ${h === selectedVal ? 'selected' : ''}>${h}</option>`
            ).join('');
        };

        const html = `
            <h3>Graph Configuration</h3>
            
            <div style="display: flex; gap: 20px;">
                
                <!-- Left Column: Data & Axes -->
                <div style="flex: 1;">
                    <div class="panel">
                        <h4>Axes Setup</h4>
                        <label>X-Axis Column</label>
                        <select id="gc-x-col">${createOptions(State.data.timeColumn)}</select>
                        <small style="color:#666">Y-Axis is selected via Tabs above the graph.</small>
                    </div>

                    <div class="panel">
                        <h4>Labels</h4>
                        <label>Graph Title</label>
                        <input id="gc-title" type="text" value="${config.title}">
                        <label>X-Axis Label</label>
                        <input id="gc-xlabel" type="text" value="${config.xAxisTitle}">
                        <label>Y-Axis Label</label>
                        <input id="gc-ylabel" type="text" value="${config.yAxisTitle}">
                    </div>
                </div>

                <!-- Right Column: Visuals -->
                <div style="flex: 1;">
                    <div class="panel">
                        <h4>Trace Colors</h4>
                        <div class="subpanel">
                            <h5 style="margin-top:0;">Light Mode</h5>
                            <div style="display:flex; gap:10px; align-items:center; margin-bottom:10px;">
                                <input type="color" id="gc-col-light-raw" value="${getThemeColor('light','raw')}" style="height:35px; width:50px; padding:0; border:none;">
                                <label style="margin:0;">Raw Data Color</label>
                            </div>
                            <div style="display:flex; gap:10px; align-items:center;">
                                <input type="color" id="gc-col-light-filt" value="${getThemeColor('light','filtered')}" style="height:35px; width:50px; padding:0; border:none;">
                                <label style="margin:0;">Filtered Data Color</label>
                            </div>
                        </div>
                        <div class="subpanel" style="margin-top:12px;">
                            <h5 style="margin-top:0;">Dark Mode</h5>
                            <div style="display:flex; gap:10px; align-items:center; margin-bottom:10px;">
                                <input type="color" id="gc-col-dark-raw" value="${getThemeColor('dark','raw')}" style="height:35px; width:50px; padding:0; border:none;">
                                <label style="margin:0;">Raw Data Color</label>
                            </div>
                            <div style="display:flex; gap:10px; align-items:center;">
                                <input type="color" id="gc-col-dark-filt" value="${getThemeColor('dark','filtered')}" style="height:35px; width:50px; padding:0; border:none;">
                                <label style="margin:0;">Filtered Data Color</label>
                            </div>
                        </div>
                    </div>

                    <div class="panel">
                        <h4>Display Options</h4>
                        <label> X-Axis Format</label>
                        <select id="gc-x-format">${createFormatOptions(xFormat)}</select>

                        <label> Y-Axis Format</label>
                        <select id="gc-y-format">${createFormatOptions(yFormat)}</select>

                        <div id="gc-currency-wrapper" style="display:none;">
                            <label>Currency Symbol</label>
                            <select id="gc-currency-symbol">${createCurrencyOptions()}</select>
                        </div>

                        <label style="display:flex; align-items:center;">
                            <input type="checkbox" id="gc-log" style="width:auto; margin-right:10px;" ${config.logScaleY ? 'checked' : ''}>
                            Logarithmic Y-Scale
                        </label>

                        <hr style="border-color:#444; opacity: 0.5;">
                        <label style="display:flex; align-items:center;">
                            <input type="checkbox" id="gc-downsample" style="width:auto; margin-right:10px;" ${config.enableDownsampling ? 'checked' : ''}>
                            Smart Downsampling
                        </label>
                        <small style="color:#666">Improves performance for large datasets.</small>
                    </div>
                </div>
            </div>

            <button id="btn-save-gc" class="primary">Update Graph</button>
        `;

        const modal = createModal(html);

        const currencyWrapper = modal.querySelector('#gc-currency-wrapper');
        const toggleCurrencyVisibility = () => {
            const shouldShow = ['currency'].includes(modal.querySelector('#gc-x-format').value) || ['currency'].includes(modal.querySelector('#gc-y-format').value);
            currencyWrapper.style.display = shouldShow ? 'block' : 'none';
        };

        toggleCurrencyVisibility();

        modal.querySelector('#gc-x-format').addEventListener('change', toggleCurrencyVisibility);
        modal.querySelector('#gc-y-format').addEventListener('change', toggleCurrencyVisibility);

        // Save Action
        modal.querySelector('#btn-save-gc').addEventListener('click', () => {
            // Data
            State.data.timeColumn = modal.querySelector('#gc-x-col').value;

            // Settings
            const cfg = State.config.graph;
            cfg.title = modal.querySelector('#gc-title').value;
            cfg.xAxisTitle = modal.querySelector('#gc-xlabel').value;
            cfg.yAxisTitle = modal.querySelector('#gc-ylabel').value;
            cfg.xAxisFormat = modal.querySelector('#gc-x-format').value;
            cfg.yAxisFormat = modal.querySelector('#gc-y-format').value;
            cfg.currencySymbol = modal.querySelector('#gc-currency-symbol').value;
            cfg.logScaleY = modal.querySelector('#gc-log').checked;
            cfg.enableDownsampling = modal.querySelector('#gc-downsample').checked;

            // Colors
            if(!State.config.colors) State.config.colors = {};

            State.config.colors.light = {
                ...Config.colors.light,
                ...(State.config.colors.light || {}),
                raw: modal.querySelector('#gc-col-light-raw').value,
                filtered: modal.querySelector('#gc-col-light-filt').value,
                diffRaw: modal.querySelector('#gc-col-light-raw').value,
                diffFilt: modal.querySelector('#gc-col-light-filt').value
            };

            State.config.colors.dark = {
                ...Config.colors.dark,
                ...(State.config.colors.dark || {}),
                raw: modal.querySelector('#gc-col-dark-raw').value,
                filtered: modal.querySelector('#gc-col-dark-filt').value,
                diffRaw: modal.querySelector('#gc-col-dark-raw').value,
                diffFilt: modal.querySelector('#gc-col-dark-filt').value
            };

            // Trigger Re-render
            const xCol = State.data.timeColumn;
            const yCol = State.data.dataColumn;
            
            const rawX = State.data.raw.map(r => parseFloat(r[xCol]));
            const rawY = State.data.raw.map(r => parseFloat(r[yCol]));
            
            // Fetch Filtered Data
            const filteredY = State.data.processed.length > 0 ? State.data.processed : null;

            Graph.render(rawX, rawY, filteredY);
            
            document.body.removeChild(modal.parentElement);
        });
    }
};