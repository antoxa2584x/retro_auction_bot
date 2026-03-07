import {q, placeBidTransaction} from '../db.js';
import { confirmBidKb, makeKb } from '../keyboards.js';
import { closeAuction } from "../scheduler.js";
import { CHANNEL_USERNAME, TZ } from "../env.js";
import { formatInTimeZone } from 'date-fns-tz';
import { getAuctionLink, escapeHtml } from '../utils.js';

export function registerCallbackHandler(bot) {
    bot.start(async (ctx) => {
        const payload = ctx.startPayload;
        if (payload && payload.startsWith('bid_')) {
            const parts = payload.split('_');
            if (parts.length === 3) {
                const chatId = -Math.abs(Number(parts[1]));
                const messageId = Number(parts[2]);

                const row = q.getAuction.get(chatId, messageId);
                if (!row) return ctx.reply('Аукціон не знайдено');

                const now = new Date();
                const end = new Date(row.end_at);
                if (now >= end || row.status !== 'active') {
                    await closeAuction(ctx, chatId, messageId);
                    return ctx.reply('Аукціон вже завершено');
                }

                const newPrice = row.leader_id ? row.current_price + row.step : row.current_price;
                const messageText = `Ви збираєтесь зробити ставку на аукціон:\n\n${row.full_text || row.title}\n\nСума ставки: <b>${newPrice} грн</b>`;
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
            await ctx.reply('Привіт! Я бот для аукціонів. Ви можете робити ставки в каналі.\n\nКоманди:\n/my - Мої активні аукціони\n/won - Мої виграні аукціони');
        }
    });

    bot.command('my', async (ctx) => {
        const userId = ctx.from.id;
        const auctions = q.getParticipatingAuctions.all(userId);

        if (auctions.length === 0) {
            return ctx.reply('Ви ще не брали участі в активних аукціонах.');
        }

        await ctx.reply('<b>Ваші активні аукціони:</b>', { parse_mode: 'HTML' });

        for (const a of auctions) {
            const link = getAuctionLink(a.chat_id, a.message_id);
            const status = a.leader_id === userId ? '✅ Ви лідируєте' : '❌ Вашу ставку перебито';
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
            return ctx.reply('Ви ще не виграли жодного аукціону.');
        }

        let text = '<b>Ваші виграні аукціони (останні 10):</b>\n\n';
        for (const a of auctions) {
            const link = getAuctionLink(a.chat_id, a.message_id);
            const endDate = formatInTimeZone(new Date(a.end_at), TZ, 'dd.MM HH:mm');
            text += `🏆 <a href="${link}">${a.title}</a>\nЦіна викупу: <b>${a.current_price} грн</b>\nДата: <b>${endDate}</b>\n\n`;
        }

        await ctx.reply(text, { parse_mode: 'HTML', disable_web_page_preview: true });
    });

    bot.on('callback_query', async (ctx, next) => {
        const data = ctx.callbackQuery.data || '';

        if (data === 'cancelbid') {
            await ctx.deleteMessage().catch(() => {});
            await ctx.answerCbQuery('Відмінено');
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
                    return ctx.answerCbQuery('Аукціон не знайдено', { show_alert: true });
                }
                if (res.reason === 'finished') {
                    await closeAuction(ctx, chat_id, message_id);
                    await ctx.answerCbQuery('Аукціон завершено', { show_alert: true });
                    await ctx.deleteMessage().catch(() => {});
                    return;
                }
                if (res.reason === 'price_changed' || res.reason === 'bid_exists') {
                    const expectedPrice = res.expectedPrice;
                    const alertText = res.reason === 'bid_exists' 
                        ? `Ставка ${price} грн вже існує! Спробуйте зробити ставку ${expectedPrice} грн`
                        : `Ціна змінилася! Нова ціна: ${expectedPrice} грн`;

                    await ctx.answerCbQuery(alertText, { show_alert: true });
                    
                    const row = q.getAuction.get(chat_id, message_id);
                    const newText = `${alertText}\n\n${row.full_text || row.title}\n\nНова сума ставки: <b>${expectedPrice} грн</b>`;
                    const newKb = confirmBidKb(chat_id, message_id, expectedPrice);

                    if (ctx.callbackQuery.message.photo) {
                        await ctx.editMessageCaption(newText, { parse_mode: 'HTML', reply_markup: newKb });
                    } else {
                        await ctx.editMessageText(newText, { parse_mode: 'HTML', reply_markup: newKb });
                    }
                    return;
                }
                return ctx.answerCbQuery('Помилка, спробуй ще раз');
            }

            // Success
            await ctx.answerCbQuery(`Ставка ${price} грн прийнята!`, { show_alert: true });

            // Notify previous leader if overbidden
            if (res.previousLeaderId && res.previousLeaderId !== user.id) {
                try {
                    const auctionLink = getAuctionLink(chat_id, message_id);
                    const overbidText = `🔔 Вашу ставку в аукціоні <a href="${auctionLink}">"${res.auctionTitle}"</a> перебито!\nНова ціна: <b>${price} грн</b>`;
                    await ctx.telegram.sendMessage(res.previousLeaderId, overbidText, { parse_mode: 'HTML' });
                } catch (err) {
                    console.error(`Failed to notify previous leader ${res.previousLeaderId}:`, err.message);
                }
            }

            const successText = `✅ Ваша ставка <b>${price} грн</b> прийнята!`;
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
            await ctx.answerCbQuery('Ставок не було', {show_alert: true});
            return;
        }

        // --- info ---
        if (data.startsWith('info:')) {
            const [, chatIdStr, msgIdStr] = data.split(':');
            const chat_id = Number(chatIdStr);
            const message_id = Number(msgIdStr);

            const row = q.getAuction.get(chat_id, message_id);
            if (!row) return ctx.answerCbQuery('Аукціон не знайдено', {show_alert: true});

            const now = new Date();
            const end = new Date(row.end_at);
            if (now >= end && row.status === 'active') {
                await closeAuction(ctx, chat_id, message_id);
                return ctx.answerCbQuery('Аукціон завершено', {show_alert: true});
            }

            const allBids = q.selectBidsForInfo.all(chat_id, message_id);
            if (allBids.length === 0) return ctx.answerCbQuery('Ще немає ставок.', {show_alert: true});

            // Coalesce consecutive bids from the same user into the last one
            const coalesced = [];
            for (const b of allBids) {
                const last = coalesced[coalesced.length - 1];
                if (last && last.user_id === b.user_id) coalesced[coalesced.length - 1] = b;
                else coalesced.push(b);
            }
            if (coalesced.length === 0) return ctx.answerCbQuery('Ще немає ставок.', {show_alert: true});

            const totalBids = allBids.length;

            const nameOf = (b) => {
                const name = b.first_name ? (b.last_name ? `${b.first_name} ${b.last_name}` : b.first_name)
                    : (b.username ? `@${b.username}` : `ID ${b.user_id}`);
                return escapeHtml(name);
            };

            const limit = 15;
            const take = coalesced.slice(-limit).reverse();
            const header = `Останні ставки (всього: ${totalBids}):\n\n`;
            let text = header, shown = 0;

            for (let i = 0; i < take.length; i++) {
                const b = take[i];
                const line = `${i + 1}. ${nameOf(b)} — ${b.amount} грн\n`;
                if ((text + line).length > 1000) break; // Increased limit for HTML
                text += line;
                shown++;
            }
            const hidden = coalesced.length - shown;
            if (hidden > 0) text += `…та ще ${hidden}`;

            await ctx.answerCbQuery(text, {show_alert: true, parse_mode: 'HTML'});
            return;
        }

        return next();
    });
}
