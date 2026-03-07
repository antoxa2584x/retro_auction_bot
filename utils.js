import { CHANNEL_USERNAME } from './env.js';

export function getAuctionLink(chatId, messageId) {
    if (CHANNEL_USERNAME) {
        return `https://t.me/${CHANNEL_USERNAME.replace('@', '')}/${messageId}`;
    }
    // For private channels, we use c/ID format. 
    // Telegram IDs usually start with -100, we need to remove it for the link.
    const cleanId = Math.abs(chatId).toString().replace(/^100/, '');
    return `https://t.me/c/${cleanId}/${messageId}`;
}

export function escapeHtml(str) {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
