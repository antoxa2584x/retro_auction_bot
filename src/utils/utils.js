import { CHANNEL_USERNAME } from '../config/env.js';

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
