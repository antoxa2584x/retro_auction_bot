import { q } from '../../services/db.js';
import { getAuctionLink } from '../../utils/utils.js';
import { formatInTimeZone } from 'date-fns-tz';
import { TZ } from "../../config/env.js";
import { closeAuction } from "../../services/scheduler.js";
import { t } from '../../services/i18n.js';
import { confirmBidKb } from '../../utils/keyboards.js';

/**
 * Registers user commands (/start, /my, /won).
 * 
 * @param {import('telegraf').Telegraf} bot - Telegraf bot instance.
 */
export function registerUserCommands(bot) {
    bot.start(async (ctx) => {
        const payload = ctx.startPayload;
        if (payload && payload.startsWith('bid_')) {
            const parts = payload.split('_');
            if (parts.length === 3) {
                const chatId = -Math.abs(Number(parts[1]));
                const messageId = Number(parts[2]);

                const row = q.getAuction.get(chatId, messageId);
                if (!row) return ctx.reply(t('bid.not_found'));

                const now = new Date();
                const end = new Date(row.end_at);
                if (now >= end || row.status !== 'active') {
                    await closeAuction(ctx, chatId, messageId);
                    return ctx.reply(t('bid.finished'));
                }

                const newPrice = row.leader_id ? row.current_price + row.step : row.current_price;
                const messageText = t('bid.confirm_text', {
                    title: row.full_text || row.title,
                    price: newPrice
                });
                const replyMarkup = confirmBidKb(chatId, messageId, newPrice);

                if (row.photo_id) {
                    await ctx.replyWithPhoto(row.photo_id, {
                        caption: messageText,
                        parse_mode: 'HTML',
                        reply_markup: replyMarkup
                    });
                } else {
                    await ctx.reply(messageText, {
                        parse_mode: 'HTML',
                        reply_markup: replyMarkup
                    });
                }
            }
        } else {
            await ctx.reply(t('bid.welcome'));
        }
    });

    bot.command('my', async (ctx) => {
        const userId = ctx.from.id;
        const auctions = q.getParticipatingAuctions.all(userId);

        if (auctions.length === 0) {
            return ctx.reply(t('bid.no_my_active'));
        }

        await ctx.reply(t('bid.my_active_header'), { parse_mode: 'HTML' });

        for (const a of auctions) {
            const link = getAuctionLink(a.chat_id, a.message_id);
            const status = a.leader_id === userId ? t('bid.status_leading') : t('bid.status_outbid');
            const endDate = formatInTimeZone(new Date(a.end_at), TZ, 'dd.MM HH:mm');
            
            const caption = `🔹 <a href="${link}">${a.title}</a>\n` +
                          `Поточна ціна: <b>${a.current_price} грн</b>\n` +
                          `Завершення: <b>${endDate}</b>\n` +
                          `Статус: ${status}`;

            if (a.photo_id) {
                await ctx.replyWithPhoto(a.photo_id, {
                    caption,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
            } else {
                await ctx.reply(caption, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
            }
        }
    });

    bot.command('won', async (ctx) => {
        const userId = ctx.from.id;
        const auctions = q.getWonAuctions.all(userId);

        if (auctions.length === 0) {
            return ctx.reply(t('bid.no_won'));
        }

        let text = t('bid.won_header');
        for (const a of auctions) {
            const link = getAuctionLink(a.chat_id, a.message_id);
            const endDate = formatInTimeZone(new Date(a.end_at), TZ, 'dd.MM HH:mm');
            text += t('bid.won_item', {
                link: link,
                title: a.title,
                price: a.current_price,
                date: endDate
            });
        }

        await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true });
    });
}
