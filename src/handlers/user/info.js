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
            await bot.answerCallbackQuery(query.id, { text: t('bid.no_bids'), show_alert: true });
        }

        const infoMatch = data.match(/^info:(.+)$/);
        if (infoMatch) {
            const params = infoMatch[1];
            const [chatIdStr, msgIdStr] = params.split(':');
            const target_chat_id = Number(chatIdStr);
            const target_message_id = Number(msgIdStr);

            const row = q.getAuction.get(target_chat_id, target_message_id);
            if (!row) return bot.answerCallbackQuery(query.id, { text: t('bid.not_found'), show_alert: true });

            const now = new Date();
            const end = new Date(row.end_at);
            if (now >= end && row.status === 'active') {
                await closeAuction(bot, target_chat_id, target_message_id);
                return bot.answerCallbackQuery(query.id, { text: t('bid.finished'), show_alert: true });
            }

            const allBids = q.selectBidsForInfo.all(target_chat_id, target_message_id);
            if (allBids.length === 0) return bot.answerCallbackQuery(query.id, { text: t('bid.no_bids'), show_alert: true });

            const coalesced = [];
            for (const b of allBids) {
                const last = coalesced[coalesced.length - 1];
                if (last && last.user_id === b.user_id) coalesced[coalesced.length - 1] = b;
                else coalesced.push(b);
            }
            if (coalesced.length === 0) return bot.answerCallbackQuery(query.id, { text: t('bid.no_bids'), show_alert: true });

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
                if ((text + line).length > 200) break; // Telegram alerts have limits
                text += line;
                shown++;
            }
            const hidden = coalesced.length - shown;
            if (hidden > 0) text += t('bid.info_more', { count: hidden });

            await bot.answerCallbackQuery(query.id, { text: text, show_alert: true });
        }
    });
}
