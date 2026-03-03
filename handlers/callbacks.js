import {q} from '../db.js';
import {confirmBidKb, makeKb} from '../keyboards.js';
import {closeAuction} from "../scheduler.js";
import {CHANNEL_USERNAME, TZ} from "../env.js";
import {formatInTimeZone} from 'date-fns-tz';

function getAuctionLink(chatId, messageId) {
    if (CHANNEL_USERNAME) {
        return `https://t.me/${CHANNEL_USERNAME.replace('@', '')}/${messageId}`;
    }
    // For private channels, we use c/ID format. 
    // Telegram IDs usually start with -100, we need to remove it for the link.
    const cleanId = Math.abs(chatId).toString().replace(/^100/, '');
    return `https://t.me/c/${cleanId}/${messageId}`;
}

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

    bot.on('callback_query', async ctx => {
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

            const row = q.getAuction.get(chat_id, message_id);
            if (!row) return ctx.answerCbQuery('Аукціон не знайдено', {show_alert: true});

            const now = new Date();
            const end = new Date(row.end_at);
            if (now >= end || row.status !== 'active') {
                await closeAuction(ctx, chat_id, message_id);
                await ctx.answerCbQuery('Аукціон завершено', {show_alert: true});
                await ctx.deleteMessage().catch(() => {});
                return;
            }

            // check if current price hasn't changed
            const expectedPrice = row.leader_id ? row.current_price + row.step : row.current_price;
            if (price !== expectedPrice) {
                await ctx.answerCbQuery(`Ціна змінилася! Нова ціна: ${expectedPrice} грн`, {show_alert: true});
                const newText = `Ціна змінилася! Ви збираєтесь зробити ставку на аукціон:\n\n${row.full_text || row.title}\n\nНова сума ставки: <b>${expectedPrice} грн</b>`;
                const newKb = confirmBidKb(chat_id, message_id, expectedPrice);

                if (ctx.callbackQuery.message.photo) {
                    await ctx.editMessageCaption(newText, {
                        parse_mode: 'HTML',
                        reply_markup: newKb
                    });
                } else {
                    await ctx.editMessageText(newText, {
                        parse_mode: 'HTML',
                        reply_markup: newKb
                    });
                }
                return;
            }

            const user = ctx.from;
            q.upsertParticipant.run(
                chat_id, message_id, user.id,
                user.username || null, user.first_name || null, user.last_name || null
            );

            try {
                const previousLeaderId = row.leader_id;
                const previousPrice = row.current_price;

                q.insertBid.run(chat_id, message_id, user.id, price, new Date().toISOString());
                const finalBidsCount = q.countBids.get(chat_id, message_id);
                const finalParticipants = finalBidsCount?.cnt ?? 0;

                const leaderName = user.first_name + (user.last_name ? ` ${user.last_name}` : '');

                q.updateState.run(
                    price,
                    user.id,
                    leaderName,
                    finalParticipants,
                    chat_id, message_id
                );

                await ctx.answerCbQuery(`Ставка ${price} грн прийнята!`, {show_alert: true});

                // Notify previous leader if overbidden
                if (previousLeaderId && previousLeaderId !== user.id) {
                    try {
                        const auctionLink = getAuctionLink(chat_id, message_id);
                        const overbidText = `🔔 Вашу ставку в аукціоні <a href="${auctionLink}">"${row.title}"</a> перебито!\nНова ціна: <b>${price} грн</b>`;
                        await ctx.telegram.sendMessage(previousLeaderId, overbidText, { parse_mode: 'HTML' });
                    } catch (err) {
                        console.error(`Failed to notify previous leader ${previousLeaderId}:`, err.message);
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
                    makeKb(chat_id, message_id, price, finalParticipants)
                );
            } catch (e) {
                console.error('Bid error:', e);
                await ctx.answerCbQuery(`Помилка, спробуй ще раз`);
            }
            return;
        }

        const [, chatIdStr, msgIdStr] = data.split(':');
        const chat_id = Number(chatIdStr);
        const message_id = Number(msgIdStr);

        if (data.startsWith('none')) {
            await ctx.answerCbQuery('Ставок не було', {show_alert: true});
            return;
        }

        // --- info ---
        if (data.startsWith('info:')) {
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

            // Згортаємо послідовні ставки одного користувача в останню
            const coalesced = [];
            for (const b of allBids) {
                const last = coalesced[coalesced.length - 1];
                if (last && last.user_id === b.user_id) coalesced[coalesced.length - 1] = b;
                else coalesced.push(b);
            }
            if (coalesced.length === 0) return ctx.answerCbQuery('Ще немає ставок.', {show_alert: true});

            const nameOf = (b) => b.first_name ? (b.last_name ? `${b.first_name} ${b.last_name}` : b.first_name)
                : (b.username ? `@${b.username}` : `ID ${b.user_id}`);

            const limit = 15;
            const take = coalesced.slice(-limit).reverse();
            const header = 'Останні ставки:\n\n';
            let text = header, shown = 0;

            for (let i = 0; i < take.length; i++) {
                const b = take[i];
                const line = `${i + 1}. ${nameOf(b)} — ${b.amount} грн\n`;
                if ((text + line).length > 190) break;
                text += line;
                shown++;
            }
            const hidden = coalesced.length - shown;
            if (hidden > 0 && (text + `…та ще ${hidden}`).length <= 200) text += `…та ще ${hidden}`;

            await ctx.answerCbQuery(text, {show_alert: true});
            return;
        }
    });
}
