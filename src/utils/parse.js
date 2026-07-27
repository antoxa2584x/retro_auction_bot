import { addYears, isBefore, parse, setYear } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';
import { t, getCurrency } from '../services/i18n.js';
import { buildAuctionText } from './utils.js';
import { q } from '../services/db.js';

/**
 * Escapes a string for use in a regular expression.
 * 
 * @param {string} string - The string to escape.
 * @returns {string} The escaped string.
 */
export function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reconstructs the auction text by replacing the technical parts (min bid, step, end date)
 * with new values, while keeping the description part intact.
 * 
 * @param {string} fullText - The full auction post text.
 * @param {Object} newData - Object with new values (min_bid, step, end_at, is_continuous, continuous_minutes).
 * @returns {string} Reconstructed text.
 */
export function reconstructAuctionText(fullText, newData) {
    const minBidLabel = q.getSetting.get('AUCTION_MIN_BID_TEXT')?.value || t('parse.defaults.min_bid');
    const bidStepLabel = q.getSetting.get('AUCTION_BID_STEP_TEXT')?.value || t('parse.defaults.bid_step');
    const endDateLabel = q.getSetting.get('AUCTION_END_DATE_TEXT')?.value || t('parse.defaults.end_date');
    const header = q.getSetting.get('AUCTION_HEADER')?.value || t('parse.defaults.header');
    const footer = q.getSetting.get('AUCTION_FOOTER')?.value || t('parse.defaults.footer');
    const priceLabel = t('bid.price_label') || 'Ціна';

    // 1. Strip header and footer if they exist to isolate the content
    let content = fullText;
    if (header && content.startsWith(header)) {
        content = content.substring(header.length).trim();
        // The header in a live post carries the status hashtag ("Header #активний"),
        // so drop whichever tag follows it too. Otherwise the old tag survives into
        // the description and buildAuctionText appends a second one below it.
        for (const tag of [t('parse.status.active'), t('parse.status.finished')]) {
            if (content.startsWith(tag)) {
                content = content.substring(tag.length).trim();
                break;
            }
        }
    }
    if (footer && content.endsWith(footer)) {
        content = content.substring(0, content.length - footer.length).trim();
    }

    // 2. Remove technical lines (min bid, step, end date, price) from the end
    const labels = [minBidLabel, bidStepLabel, endDateLabel, priceLabel];
    const lines = content.split('\n');
    const filteredLines = lines.filter(line => {
        const trimmed = line.trim();
        if (!trimmed) return true;
        // Check if line starts with any of the labels (case-insensitive)
        return !labels.some(label => trimmed.toLowerCase().startsWith(label.toLowerCase()));
    });

    const description = filteredLines.join('\n').trim();

    // 3. Rebuild using buildAuctionText
    return buildAuctionText({
        ...newData,
        full_text: description
    }, false, true);
}

/**
 * Parses an auction post text to extract minimum bid, step, and end time.
 * Dynamically builds regular expressions based on configured settings.
 * 
 * @param {string} text - The post text to parse.
 * @param {string} tz - Timezone for date calculation (e.g., 'UTC').
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
