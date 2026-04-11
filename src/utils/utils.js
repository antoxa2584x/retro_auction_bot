import { CHANNEL_USERNAME, TZ } from '../config/env.js';
import { q } from '../services/db.js';
import { t, getCurrency } from '../services/i18n.js';
import { formatInTimeZone } from 'date-fns-tz';
import { addDays, set } from 'date-fns';

/**
 * Generates a direct link to a Telegram channel post.
 * 
 * @param {number} chatId - Chat ID (can be -100...).
 * @param {number} messageId - Message ID in the channel.
 * @returns {string} URL link to the message.
 */
export function getAuctionLink(chatId, messageId) {
    if (CHANNEL_USERNAME) {
        return `https://t.me/${CHANNEL_USERNAME.replace('@', '')}/${messageId}`;
    }
    // For private channels, we use c/ID format. 
    // Telegram IDs usually start with -100, we need to remove it for the link.
    const cleanId = Math.abs(chatId).toString().replace(/^100/, '');
    return `https://t.me/c/${cleanId}/${messageId}`;
}

/**
 * Formats a user mention link based on available information.
 * 
 * @param {number} userId - Telegram user ID.
 * @param {string} [name] - User's name to display.
 * @param {string} [username] - Telegram @username.
 * @returns {string} HTML-formatted link.
 */
export function formatUserLink(userId, name, username) {
    const displayName = escapeHtml(name || (username ? `@${username}` : `ID ${userId}`));
    if (username) {
        return `<a href="https://t.me/${username}">${displayName}</a>`;
    }
    return `<a href="tg://user?id=${userId}">${displayName}</a>`;
}

/**
 * Formats a contact link (either username or tg://user?id=...) with a display name.
 * 
 * @param {string} nickname - The contact nickname or link.
 * @returns {string} HTML-formatted link.
 */
export function formatContactLink(nickname) {
    if (!nickname) return t('admin.not_set');

    if (nickname.startsWith('tg://')) {
        const idMatch = nickname.match(/id=(\d+)/);
        if (idMatch) {
            const userId = Number(idMatch[1]);
            const user = q.getUserFromAnywhere.get(userId, userId, userId, userId);
            const name = user?.name || `ID ${userId}`;
            return `<a href="${nickname}">${escapeHtml(name)}</a>`;
        }
        return `<a href="${nickname}">${escapeHtml(nickname)}</a>`;
    }

    const cleanNick = nickname.replace('@', '');
    return `<a href="https://t.me/${cleanNick}">${escapeHtml(nickname)}</a>`;
}

/**
 * Escapes HTML special characters to prevent injection when using HTML parse mode.
 * 
 * @param {string} str - String to escape.
 * @returns {string} Escaped string.
 */
export function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Sanitizes a string containing HTML, allowing only tags supported by Telegram.
 * It also handles common Markdown-to-HTML tags like <p> or <div> by converting them to newlines.
 * 
 * Supported tags: <b>, <i>, <u>, <s>, <a>, <code>, <pre>.
 * 
 * @param {string} html - HTML string to sanitize.
 * @returns {string} Sanitized string.
 */
export function sanitizeHtml(html) {
    if (!html) return '';

    // Convert <p>, <div>, <br>, <li> to newlines
    let text = html
        .replace(/<(p|div|br|li)[^>]*>/gi, '\n')
        .replace(/<\/(p|div|li)>/gi, '');

    // Define supported tags
    const supportedTags = ['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'a', 'code', 'pre'];

    // This regex matches any tag: <(/?)tag( [^>]*)?>
    // We replace it with either the original tag (if supported) or an empty string/escaped version.
    text = text.replace(/<(\/?)([a-z1-6]+)([^>]*)>/gi, (match, closingSlash, tagName, attributes) => {
        const lowerTagName = tagName.toLowerCase();
        
        // Map common synonyms to Telegram-supported tags
        let finalTagName = lowerTagName;
        if (lowerTagName === 'strong') finalTagName = 'b';
        if (lowerTagName === 'em') finalTagName = 'i';
        if (lowerTagName === 'ins') finalTagName = 'u';
        if (lowerTagName === 'strike' || lowerTagName === 'del') finalTagName = 's';

        if (supportedTags.includes(finalTagName)) {
            if (finalTagName === 'a') {
                // For <a> tags, we only allow href attribute
                const hrefMatch = attributes.match(/href=["']([^"']*)["']/i);
                if (hrefMatch) {
                    return `<${closingSlash}${finalTagName} href="${hrefMatch[1]}">`;
                }
                // If no href, just strip the tag but keep content (handled by returning empty string for tag)
                return '';
            }
            return `<${closingSlash}${finalTagName}>`;
        }

        // If not supported, strip the tag
        return '';
    });

    // Cleanup multiple consecutive newlines and leading/trailing whitespace
    return text.replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Constructs the auction post text based on the provided data and settings.
 * 
 * @param {Object} data - Auction data (full_text, min_bid, step, end_at, user_id, is_continuous, continuous_minutes).
 * @param {boolean} includeUserLabel - Whether to include the subscriber label.
 * @param {boolean} includeSettings - Whether to wrap with header/footer from settings.
 * @returns {string} Formatted auction text.
 */
export function buildAuctionText(data, includeUserLabel = true, includeSettings = true) {
    const cur = getCurrency();
    const header = includeSettings ? sanitizeHtml(q.getSetting.get('AUCTION_HEADER')?.value || t('parse.defaults.header')) : '';
    const minBidText = sanitizeHtml(q.getSetting.get('AUCTION_MIN_BID_TEXT')?.value || t('parse.defaults.min_bid'));
    const bidStepText = sanitizeHtml(q.getSetting.get('AUCTION_BID_STEP_TEXT')?.value || t('parse.defaults.bid_step'));
    const endDateText = sanitizeHtml(q.getSetting.get('AUCTION_END_DATE_TEXT')?.value || t('parse.defaults.end_date'));
    const footer = includeSettings ? sanitizeHtml(q.getSetting.get('AUCTION_FOOTER')?.value || t('parse.defaults.footer')) : '';

    const formattedEnd = formatInTimeZone(new Date(data.end_at), TZ, 'dd.MM о HH:mm');

    let userLabel = '';
    if (includeUserLabel && data.user_id) {
        const count = q.countApprovedAuctionsByUser.get(data.user_id).count;
        if (count >= 5) {
            userLabel = t('admin.kb.lot_from_verified_subscriber') + '\n\n';
        } else {
            userLabel = t('admin.kb.lot_from_subscriber') + '\n\n';
        }
    }

    let text = '';
    if (header) text += `${header}\n\n`;
    text += `${sanitizeHtml(data.full_text)}\n\n${userLabel}` +
        `${minBidText}: <b>${data.min_bid} ${cur}</b>\n` +
        `${bidStepText}: <b>${data.step} ${cur}</b>\n` +
        `${endDateText}: <b>${formattedEnd}</b>\n\n`;
    
    if (data.is_continuous !== undefined && includeSettings === false) {
        text += `Continuous: ${data.is_continuous ? t('admin.kb.yes') : t('admin.kb.no')}\n\n`;
    }

    if (footer) text += `${footer}`;

    return text.trim();
}

/**
 * Sends a media group (gallery) as a reply to a main message.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number|string} chatId - Chat ID to send to.
 * @param {string[]} photoIds - Array of photo file IDs.
 * @param {number} replyToId - Message ID to reply to.
 */
export async function sendAuctionGallery(bot, chatId, photoIds, replyToId) {
    if (!photoIds || photoIds.length <= 1) return;

    const media = photoIds.slice(1).map(id => ({
        type: 'photo',
        media: id
    }));

    await bot.sendMediaGroup(chatId, media, {
        reply_to_message_id: replyToId
    });
}

/**
 * Calculates the default end date for an auction.
 * 
 * @returns {Date} Default end date.
 */
export function getDefaultEndDate() {
    const defDays = parseInt(q.getSetting.get('DEFAULT_END_DAYS')?.value || '5');
    const defTime = q.getSetting.get('DEFAULT_END_TIME')?.value || '21:00';
    
    let defDate = addDays(new Date(), defDays);
    const [hours, minutes] = defTime.split(':').map(Number);
    defDate = set(defDate, { hours, minutes, seconds: 0, milliseconds: 0 });
    
    return defDate;
}
