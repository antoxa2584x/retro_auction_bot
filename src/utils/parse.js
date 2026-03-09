import { addYears, isBefore, parse, setYear } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { t } from '../services/i18n.js';
import { q } from '../services/db.js';

/**
 * Escapes a string for use in a regular expression.
 * 
 * @param {string} string - The string to escape.
 * @returns {string} The escaped string.
 */
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parses an auction post text to extract minimum bid, step, and end time.
 * Dynamically builds regular expressions based on configured settings.
 * 
 * @param {string} text - The post text to parse.
 * @param {string} tz - Timezone for date calculation (e.g., 'Europe/Kyiv').
 * @returns {{minBid: number, step: number, end: Date}} Parsed auction data.
 * @throws {Error} If required fields are not found in the text.
 */
export function parsePost(text, tz) {
    const minBidLabel = q.getSetting.get('AUCTION_MIN_BID_TEXT')?.value || t('parse.defaults.min_bid');
    const bidStepLabel = q.getSetting.get('AUCTION_BID_STEP_TEXT')?.value || t('parse.defaults.bid_step');
    const endDateLabel = q.getSetting.get('AUCTION_END_DATE_TEXT')?.value || t('parse.defaults.end_date');

    const reMin = new RegExp(`${escapeRegExp(minBidLabel)}:\\s*([\\d\\s]+)`, 'i');
    const reStep = new RegExp(`${escapeRegExp(bidStepLabel)}:\\s*([\\d\\s]+)`, 'i');
    const reEnd = new RegExp(`${escapeRegExp(endDateLabel)}:\\s*([0-3]?\\d\\.[01]?\\d)\\s*(?:о|at)?\\s*([0-2]?\\d:[0-5]\\d)`, 'i');

    const m1 = reMin.exec(text || '');
    const m2 = reStep.exec(text || '');
    const m3 = reEnd.exec(text || '');
    if (!m1 || !m2 || !m3) throw new Error(t('parse.error'));

    const minBid = parseInt(m1[1].replace(/\s+/g, ''), 10);
    const step   = parseInt(m2[1].replace(/\s+/g, ''), 10);

    const [dd, mm] = m3[1].split('.').map(Number);
    const [HH, MM] = m3[2].split(':').map(Number);
    const nowZ = toZonedTime(new Date(), tz);
    let end = setYear(parse(`${dd}.${mm} ${HH}:${MM}`, 'd.M H:mm', nowZ), nowZ.getFullYear());
    if (isBefore(end, nowZ)) end = addYears(end, 1);
    return { minBid, step, end };
}
