import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const defaultLocale = 'uk';
const localesPath = path.join(__dirname, '..', 'locales');

let translations = {};
let currentLocale = defaultLocale;
let currentCurrency = '₴';

function loadTranslations() {
    const loaded = {};
    const files = fs.readdirSync(localesPath);
    for (const file of files) {
        if (file.endsWith('.json')) {
            const locale = path.basename(file, '.json');
            try {
                const content = fs.readFileSync(path.join(localesPath, file), 'utf8');
                loaded[locale] = JSON.parse(content);
            } catch (e) {
                console.error(`Failed to load locale ${locale}:`, e.message);
            }
        }
    }
    return loaded;
}

translations = loadTranslations();

/**
 * Sets the current global locale.
 * @param {string} locale 
 */
export function setLocale(locale) {
    if (translations[locale]) {
        currentLocale = locale;
    }
}

/**
 * Gets the current global locale.
 * @returns {string}
 */
export function getLocale() {
    return currentLocale;
}

/**
 * Sets the current global currency.
 * @param {string} currency 
 */
export function setCurrency(currency) {
    currentCurrency = currency;
}

/**
 * Gets the current global currency.
 * @returns {string}
 */
export function getCurrency() {
    return currentCurrency;
}

/**
 * Retrieves a translated string by its key.
 * Supports nested keys using dot notation (e.g., 'admin.already_admin').
 * Supports variable replacement using {{variable}} syntax.
 * 
 * @param {string} key - The translation key.
 * @param {Object} [params] - Optional parameters for replacement.
 * @returns {string} - The translated string or the key itself if not found.
 */
export function t(key, params = {}) {
    const keys = key.split('.');
    let value = translations[currentLocale];

    for (const k of keys) {
        if (value && value[k]) {
            value = value[k];
        } else {
            // Fallback to default locale if current is not default
            if (currentLocale !== defaultLocale) {
                let fallbackValue = translations[defaultLocale];
                for (const fk of keys) {
                    if (fallbackValue && fallbackValue[fk]) {
                        fallbackValue = fallbackValue[fk];
                    } else {
                        fallbackValue = key;
                        break;
                    }
                }
                value = fallbackValue;
                break;
            }
            return key;
        }
    }

    if (typeof value !== 'string') {
        return key;
    }

    let result = value;
    
    // Replace global currency placeholder
    result = result.replace(/{{cur}}/g, currentCurrency);

    for (const [param, val] of Object.entries(params)) {
        result = result.replace(new RegExp(`{{${param}}}`, 'g'), val);
    }

    return result;
}
