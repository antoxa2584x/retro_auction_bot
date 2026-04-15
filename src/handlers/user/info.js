import { q } from '../../services/db.js';
import { closeAuction } from "../../services/scheduler.js";
import { escapeHtml } from '../../utils/utils.js';
import { t, getCurrency } from '../../services/i18n.js';

/**
 * Registers handlers for auction information (bid history).
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 */
export function registerInfoHandlers(bot) {
    bot.on('callback_query', async (query) => {
        const { data, message } = query;
        const chatId = message.chat.id;
        const messageId = message.message_id;

        if (data === 'none') {
            try {
                return bot.answerCallbackQuery(query.id, { text: t('bid.no_bids'), show_alert: true });
            } catch (e) {
                console.error('Error answering none callback:', e.message);
                return;
            }
        }

        if (data.startsWith('winner_info:')) {
            const userId = data.split(':')[1];
            try {
                const text = `${t('bid.privacy_warning_alert')}\n\nID: ${userId}\nLink: tg://user?id=${userId}`;
                return bot.answerCallbackQuery(query.id, { text, show_alert: true });
            } catch (e) {
                console.error('Error answering winner_info callback:', e.message);
                return;
            }
        }

        const infoMatch = data.match(/^info:(.+)$/);
        if (infoMatch) {
            const params = infoMatch[1];
            const [chatIdStr, msgIdStr] = params.split(':');
            const target_chat_id = Number(chatIdStr);
            const target_message_id = Number(msgIdStr);

            const row = q.getAuction.get(target_chat_id, target_message_id);
            if (!row) {
                try {
                    return bot.answerCallbackQuery(query.id, { text: t('bid.not_found'), show_alert: true });
                } catch (e) {
                    console.error('Error answering info not_found callback:', e.message);
                    return;
                }
            }

            const now = new Date();
            const end = new Date(row.end_at);
            if (now >= end && row.status === 'active') {
                await closeAuction(bot, target_chat_id, target_message_id);
                try {
                    return bot.answerCallbackQuery(query.id, { text: t('bid.finished'), show_alert: true });
                } catch (e) {
                    console.error('Error answering info finished callback:', e.message);
                    return;
                }
            }

            const allBids = q.selectBidsForInfo.all(target_chat_id, target_message_id);
            if (allBids.length === 0) {
                try {
                    return bot.answerCallbackQuery(query.id, { text: t('bid.no_bids'), show_alert: true });
                } catch (e) {
                    console.error('Error answering info no_bids callback:', e.message);
                    return;
                }
            }

            const coalesced = [];
            for (const b of allBids) {
                const last = coalesced[coalesced.length - 1];
                if (last && last.user_id === b.user_id) coalesced[coalesced.length - 1] = b;
                else coalesced.push(b);
            }
            if (coalesced.length === 0) {
                try {
                    return bot.answerCallbackQuery(query.id, { text: t('bid.no_bids'), show_alert: true });
                } catch (e) {
                    console.error('Error answering info no_bids coalesced callback:', e.message);
                    return;
                }
            }

            const totalBids = allBids.length;

            const nameOf = (b) => {
                const name = b.first_name ? (b.last_name ? `${b.first_name} ${b.last_name}` : b.first_name)
                    : (b.username ? `@${b.username}` : `ID ${b.user_id}`);
                return name;
            };

            const limit = 15;
            const take = coalesced.slice(-limit).reverse();
            let text = t('bid.info_header', { total: totalBids });
            let shown = 0;

            for (let i = 0; i < take.length; i++) {
                const b = take[i];
                const line = t('bid.info_item', {
                    index: i + 1,
                    name: nameOf(b),
                    price: b.amount,
                    cur: getCurrency()
                });

                const remaining = coalesced.length - (shown + 1);
                const moreText = remaining > 0 ? t('bid.info_more', { count: remaining }) : '';
                
                if ((text + line + moreText).length > 200) break; 
                
                text += line;
                shown++;
            }
            const hidden = coalesced.length - shown;
            if (hidden > 0) text += t('bid.info_more', { count: hidden });

            try {
                return bot.answerCallbackQuery(query.id, { text: text, show_alert: true });
            } catch (e) {
                console.error('Error answering info success callback:', e.message);
                return;
            }
        }
    });
}
