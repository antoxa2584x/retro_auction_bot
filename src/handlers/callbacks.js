import {q, placeBidTransaction} from '../services/db.js';
import { confirmBidKb, makeKb } from '../utils/keyboards.js';
import { closeAuction } from "../services/scheduler.js";
import { CHANNEL_USERNAME, TZ } from "../config/env.js";
import { formatInTimeZone } from 'date-fns-tz';
import { getAuctionLink, escapeHtml } from '../utils/utils.js';
import { t } from '../services/i18n.js';

export function registerCallbackHandler(bot) {
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

    bot.on('callback_query', async (ctx, next) => {
        const data = ctx.callbackQuery.data || '';

        if (data === 'cancelbid') {
            await ctx.deleteMessage().catch(() => {});
            await ctx.answerCbQuery(t('bid.cancel_bid'));
            return;
        }

        if (data.startsWith('confbid:')) {
            const [, chatIdStr, msgIdStr, priceStr] = data.split(':');
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
            return;
        }

        if (data === 'none') {
            await ctx.answerCbQuery(t('bid.no_bids'), {show_alert: true});
            return;
        }

        // --- info ---
        if (data.startsWith('info:')) {
            const [, chatIdStr, msgIdStr] = data.split(':');
            const chat_id = Number(chatIdStr);
            const message_id = Number(msgIdStr);

            const row = q.getAuction.get(chat_id, message_id);
            if (!row) return ctx.answerCbQuery(t('bid.not_found'), {show_alert: true});

            const now = new Date();
            const end = new Date(row.end_at);
            if (now >= end && row.status === 'active') {
                await closeAuction(ctx, chat_id, message_id);
                return ctx.answerCbQuery(t('bid.finished'), {show_alert: true});
            }

            const allBids = q.selectBidsForInfo.all(chat_id, message_id);
            if (allBids.length === 0) return ctx.answerCbQuery(t('bid.no_bids'), {show_alert: true});

            // Coalesce consecutive bids from the same user into the last one
            const coalesced = [];
            for (const b of allBids) {
                const last = coalesced[coalesced.length - 1];
                if (last && last.user_id === b.user_id) coalesced[coalesced.length - 1] = b;
                else coalesced.push(b);
            }
            if (coalesced.length === 0) return ctx.answerCbQuery(t('bid.no_bids'), {show_alert: true});

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
                if ((text + line).length > 1000) break; // Increased limit for HTML
                text += line;
                shown++;
            }
            const hidden = coalesced.length - shown;
            if (hidden > 0) text += t('bid.info_more', { count: hidden });

            await ctx.answerCbQuery(text, {show_alert: true, parse_mode: 'HTML'});
            return;
        }

        return next();
    });
}
