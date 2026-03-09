import { q, placeBidTransaction } from '../../services/db.js';
import { makeKb, confirmBidKb } from '../../utils/keyboards.js';
import { closeAuction } from "../../services/scheduler.js";
import { getAuctionLink } from '../../utils/utils.js';
import { t } from '../../services/i18n.js';

/**
 * Registers handlers for the bidding process (confirmation and placement).
 * 
 * @param {import('telegraf').Telegraf} bot - Telegraf bot instance.
 */
export function registerBidHandlers(bot) {
    bot.action('cancelbid', async (ctx) => {
        await ctx.deleteMessage().catch(() => {});
        await ctx.answerCbQuery(t('bid.cancel_bid'));
    });

    bot.action(/^confbid:(.+)$/, async (ctx) => {
        const data = ctx.match[1];
        const [chatIdStr, msgIdStr, priceStr] = data.split(':');
        const chat_id = Number(chatIdStr);
        const message_id = Number(msgIdStr);
        const price = Number(priceStr);

        const user = ctx.from;
        const res = placeBidTransaction(chat_id, message_id, user, price);

        if (!res.success) {
            if (res.reason === 'not_found') {
                return ctx.answerCbQuery(t('bid.not_found'), { show_alert: true });
            }

            if (res.reason === 'finished') {
                await closeAuction(ctx, chat_id, message_id);
                await ctx.answerCbQuery(t('bid.finished'), { show_alert: true });
                await ctx.deleteMessage().catch(() => {});
                return;
            }

            if (res.reason === 'price_changed' || res.reason === 'bid_exists') {
                const expectedPrice = res.expectedPrice;
                const alertText = res.reason === 'bid_exists' 
                    ? t('bid.bid_exists_alert', { price, expectedPrice })
                    : t('bid.price_changed_alert', { expectedPrice });

                await ctx.answerCbQuery(alertText, { show_alert: true });
                
                const row = q.getAuction.get(chat_id, message_id);
                const newText = t('bid.alert_with_details', {
                    alert: alertText,
                    title: row.full_text || row.title,
                    expectedPrice: expectedPrice
                });
                const newKb = confirmBidKb(chat_id, message_id, expectedPrice);

                if (ctx.callbackQuery.message.photo) {
                    await ctx.editMessageCaption(newText, { parse_mode: 'HTML', reply_markup: newKb });
                } else {
                    await ctx.editMessageText(newText, { parse_mode: 'HTML', reply_markup: newKb });
                }
                return;
            }

            return ctx.answerCbQuery(t('common.error_try_again'));
        }

        // Success
        await ctx.answerCbQuery(t('bid.accepted_alert', { price }), { show_alert: true });

        // Notify previous leader if outbid
        if (res.previousLeaderId && res.previousLeaderId !== user.id) {
            try {
                const auctionLink = getAuctionLink(chat_id, message_id);
                const outbidText = t('bid.outbid_notify', {
                    link: auctionLink,
                    title: res.auctionTitle,
                    price: price
                });
                await ctx.telegram.sendMessage(res.previousLeaderId, outbidText, { parse_mode: 'HTML' });
            } catch (err) {
                console.error(`Failed to notify previous leader ${res.previousLeaderId}:`, err.message);
            }
        }

        const successText = t('bid.accepted_text', { price });
        if (ctx.callbackQuery.message.photo) {
            await ctx.editMessageCaption(successText, { parse_mode: 'HTML' });
        } else {
            await ctx.editMessageText(successText, { parse_mode: 'HTML' });
        }

        await ctx.telegram.editMessageReplyMarkup(
            chat_id,
            message_id,
            null,
            makeKb(chat_id, message_id, price, res.participantsCount)
        );
    });
}
