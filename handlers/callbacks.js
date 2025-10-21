import {q} from '../db.js';
import {makeActiveKb, winnerKeyboard} from '../keyboards.js';

export function registerCallbackHandler(bot) {
    bot.on('callback_query', async ctx => {
        const data = ctx.callbackQuery.data || '';
        const [, chatIdStr, msgIdStr] = data.split(':');
        const chat_id = Number(chatIdStr);
        const message_id = Number(msgIdStr);

        const row = q.getAuction.get(chat_id, message_id);
        if (!row) return ctx.answerCbQuery('Аукціон не знайдено', {show_alert: true});

        // --- info ---
        if (data.startsWith('info:')) {

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
            const header = 'Учасники (останні серії):\n\n';
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

        if (row.status !== 'active') {
            try {
                await ctx.telegram.editMessageReplyMarkup(
                    chat_id,
                    message_id,
                    null,
                    winnerKeyboard(row.leader_id, row.leader_name, row.current_price, chat_id, message_id)
                );
            } catch (e) {
                console.log(e)
            }

            return ctx.answerCbQuery('Аукціон завершено', {show_alert: true});
        }

        if (data.startsWith('confirm:')) {
            const [, chatIdStr, msgIdStr, priceStr] = data.split(':');
            const price = Number(priceStr) + (row.participants_count > 0 ? row.step : 0);
            return ctx.answerCbQuery(`Підтвердити ставку ${price} грн?`, {show_alert: false}).then(() => {
                try {
                    return ctx.editMessageReplyMarkup({
                        inline_keyboard: [
                            [
                                {
                                    text: `✅ Так, підтвердити ${price} грн`,
                                    callback_data: `bid:${chatIdStr}:${msgIdStr}:${price}`
                                }
                            ],
                            [
                                {text: '❌ Скасувати', callback_data: `cancel:${chatIdStr}:${msgIdStr}`}
                            ]
                        ]
                    });
                } catch (e) {
                }
            });
        }

        // --- cancel ---
        if (data.startsWith('cancel:')) {
            await ctx.answerCbQuery('Ставку скасовано');

            const participants = row.participants_count;
            const price = row.current_price;

            try {
                await ctx.telegram.editMessageReplyMarkup(
                    chat_id,
                    message_id,
                    null,
                    makeActiveKb(chat_id, message_id, price, participants, row.leader_id, row.leader_name)
                );
            } catch {
            }
        }

        // --- bid ---
        if (data.startsWith('bid:')) {
            const parts = data.split(':');
            const chat_id = Number(parts[1]);
            const message_id = Number(parts[2]);
            let newPrice = parts[3] ? Number(parts[3]) : null;

            const now = new Date();
            const end = new Date(row.end_at);
            if (now >= end) {
                await ctx.answerCbQuery('Аукціон завершено', {show_alert: true});
                return;
            }

            // якщо не передали ціну з confirm - рахуємо тут
            if (!newPrice) {
                newPrice = row.leader_id ? row.current_price + row.step : row.current_price;
            }

            const user = ctx.from;
            let participants = row.participants_count;

            const ins = q.upsertParticipant.run(
                chat_id, message_id, user.id,
                user.username || null, user.first_name || null, user.last_name || null
            );
            if (ins.changes > 0) participants += 1;

            q.updateState.run(
                newPrice,
                user.id,
                user.first_name + (user.last_name ? ` ${user.last_name}` : ''),
                participants,
                chat_id, message_id
            );

            q.insertBid.run(chat_id, message_id, user.id, newPrice, new Date().toISOString());

            try {
                await ctx.telegram.editMessageReplyMarkup(
                    chat_id,
                    message_id,
                    null,
                    makeActiveKb(chat_id, message_id, newPrice, participants, row.leader_id, row.leader_name)
                );
            } catch (e) {
                console.log(e)
            }

            return ctx.answerCbQuery(`Ставка підтверджена: ${newPrice} грн`);
        }
    });
}
