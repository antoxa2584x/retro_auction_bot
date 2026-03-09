import { q } from '../../services/db.js';
import { closeAuction } from "../../services/scheduler.js";
import { escapeHtml } from '../../utils/utils.js';
import { t } from '../../services/i18n.js';

/**
 * Registers handlers for auction information (bid history).
 * 
 * @param {import('telegraf').Telegraf} bot - Telegraf bot instance.
 */
export function registerInfoHandlers(bot) {
    bot.action('none', async (ctx) => {
        await ctx.answerCbQuery(t('bid.no_bids'), { show_alert: true });
    });

    bot.action(/^info:(.+)$/, async (ctx) => {
        const data = ctx.match[1];
        const [chatIdStr, msgIdStr] = data.split(':');
        const chat_id = Number(chatIdStr);
        const message_id = Number(msgIdStr);

        const row = q.getAuction.get(chat_id, message_id);
        if (!row) return ctx.answerCbQuery(t('bid.not_found'), { show_alert: true });

        const now = new Date();
        const end = new Date(row.end_at);
        if (now >= end && row.status === 'active') {
            await closeAuction(ctx, chat_id, message_id);
            return ctx.answerCbQuery(t('bid.finished'), { show_alert: true });
        }

        const allBids = q.selectBidsForInfo.all(chat_id, message_id);
        if (allBids.length === 0) return ctx.answerCbQuery(t('bid.no_bids'), { show_alert: true });

        const coalesced = [];
        for (const b of allBids) {
            const last = coalesced[coalesced.length - 1];
            if (last && last.user_id === b.user_id) coalesced[coalesced.length - 1] = b;
            else coalesced.push(b);
        }
        if (coalesced.length === 0) return ctx.answerCbQuery(t('bid.no_bids'), { show_alert: true });

        const totalBids = allBids.length;

        const nameOf = (b) => {
            const name = b.first_name ? (b.last_name ? `${b.first_name} ${b.last_name}` : b.first_name)
                : (b.username ? `@${b.username}` : `ID ${b.user_id}`);
            return escapeHtml(name);
        };

        const limit = 15;
        const take = coalesced.slice(-limit).reverse();
        const header = t('bid.info_header', { total: totalBids });
        let text = header, shown = 0;

        for (let i = 0; i < take.length; i++) {
            const b = take[i];
            const line = t('bid.info_item', {
                index: i + 1,
                name: nameOf(b),
                price: b.amount
            });
            if ((text + line).length > 1000) break;
            text += line;
            shown++;
        }
        const hidden = coalesced.length - shown;
        if (hidden > 0) text += t('bid.info_more', { count: hidden });

        await ctx.answerCbQuery(text, { show_alert: true, parse_mode: 'HTML' });
    });
}
