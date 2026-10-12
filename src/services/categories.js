import { q } from './db.js';

/** Longest name kept; a Telegram button and a website chip both need it short. */
const MAX_NAME_LENGTH = 40;

/**
 * Splits the admin's comma-separated CATEGORIES text into clean names: trimmed,
 * inner whitespace collapsed, angle brackets removed (names end up in HTML
 * messages; show them through escapeHtml), empties and case-insensitive
 * repeats dropped, in the order the admin wrote them.
 *
 * @param {?string} text - e.g. "Фігурки, Мерч, Ігри (Диски)".
 * @returns {string[]}
 */
export function parseCategories(text) {
    const seen = new Set();
    const names = [];
    for (const raw of (text || '').split(',')) {
        const name = raw.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
        const key = name.toLocaleLowerCase();
        if (!name || seen.has(key)) continue;
        seen.add(key);
        names.push(name);
    }
    return names;
}

/**
 * Categories offered in the posting wizards and on the website. Empty when the
 * admin hasn't set any, in which case the wizards skip the category step.
 *
 * @returns {string[]}
 */
export function getCategories() {
    return parseCategories(q.getSetting.get('CATEGORIES')?.value);
}
