import {q} from '../db.js';
import {makeKb} from '../keyboards.js';
import {closeAuction} from "../scheduler.js";

// 🔒 Лок на аукціон (щоб одночасно не крутилося кілька оновлень однієї ставки)
const activeLocks = new Map(); // key: `${chat_id}:${message_id}` → true

// 🚦 Ліміт частоти натискань (анти-спам)
const userRateLimit = new Map(); // key: `${chat_id}:${message_id}:${user_id}` → timestamp
const RATE_LIMIT_MS = 1000; // 1 сек — можна підкрутити

export function registerCallbackHandler(bot) {
    bot.on('callback_query', async ctx => {
        const data = ctx.callbackQuery.data || '';
        const [, chatIdStr, msgIdStr] = data.split(':');
        const chat_id = Number(chatIdStr);
        const message_id = Number(msgIdStr);

        // --- info ---
        if (data.startsWith('info:')) {
            // ... тут нічого не міняємо ...
            const row = q.getAuction.get(chat_id, message_id);
            if (!row) return ctx.answerCbQuery('Аукціон не знайдено', {show_alert: true});

            const allBids = q.selectBidsForInfo.all(chat_id, message_id);
            if (allBids.length === 0) return ctx.answerCbQuery('Ще немає ставок.', {show_alert: true});

            // ...
            await ctx.answerCbQuery(text, {show_alert: true});
            return;
        }

        if (!data.startsWith('bid:')) return;

        const user = ctx.from;
        const lockKey = `${chat_id}:${message_id}`;
        const nowTs = Date.now();
        const userKey = `${lockKey}:${user.id}`;

        // 🚦 Простий rate limit по юзеру на цей аукціон
        const lastTs = userRateLimit.get(userKey);
        if (lastTs && (nowTs - lastTs) < RATE_LIMIT_MS) {
            return ctx.answerCbQuery('Занадто часто, спробуй за мить 😉', {show_alert: false});
        }
        userRateLimit.set(userKey, nowTs);

        // 🔒 Лок на рівні аукціону — щоб 2 callback-и одночасно не міняли ціну
        if (activeLocks.get(lockKey)) {
            return ctx.answerCbQuery('Ставка вже обробляється, спробуй ще раз…', {show_alert: false});
        }
        activeLocks.set(lockKey, true);

        try {
            const row = q.getAuction.get(chat_id, message_id);
            if (!row) return ctx.answerCbQuery('Аукціон не знайдено', {show_alert: true});
            if (row.status !== 'active') {
                await closeAuction(ctx, chat_id, message_id)
                return ctx.answerCbQuery('Аукціон завершено', {show_alert: true});
            }

            const now = new Date();
            const end = new Date(row.end_at);
            if (now >= end) {
                await ctx.answerCbQuery('Аукціон завершено', {show_alert: true});
                return;
            }

            let newPrice = 0;
            let participants = row.participants_count;
            let removeBid = false;

            const lastBid = q.getLastBid.get(chat_id, message_id);

            if (lastBid && lastBid.user_id === user.id) {
                // ⏱ обмеження в 5 хвилин
                const bidTime = new Date(lastBid.ts);
                const diffMs = Date.now() - bidTime.getTime();
                const FIVE_MINUTES = 5 * 60 * 1000;

                if (diffMs < FIVE_MINUTES) {
                    q.deleteBidByRowId.run(lastBid.rid);
                    removeBid = true;

                    // захист від негативу/нижче старту
                    newPrice = Math.max(row.start_price, row.current_price - row.step);
                } else {
                    // якщо 5 хвилин минуло — просто не дозволяємо відміняти
                    await ctx.answerCbQuery('Ставку можна відмінити лише протягом 5 хвилин', {show_alert: true});
                    return;
                }
            } else {
                // звичайна нова ставка
                newPrice = row.leader_id
                    ? row.current_price + row.step
                    : row.start_price;
            }

            const ins = q.upsertParticipant.run(
                chat_id, message_id, user.id,
                user.username || null, user.first_name || null, user.last_name || null
            );

            if (removeBid) {
                if (ins.changes > 0) participants -= 1;
            } else {
                if (ins.changes > 0) participants += 1;
            }

            await ctx.telegram.editMessageReplyMarkup(
                chat_id,
                message_id,
                null,
                makeKb(chat_id, message_id, newPrice, participants)
            );

            q.updateState.run(
                newPrice,
                user.id,
                user.first_name + (user.last_name ? ` ${user.last_name}` : ''),
                participants,
                chat_id, message_id
            );

            if (removeBid) {
                await ctx.answerCbQuery(`Ставка відмінена`);
            } else {
                q.insertBid.run(chat_id, message_id, user.id, newPrice, new Date().toISOString());
                await ctx.answerCbQuery(`Ваша ставка: ${newPrice} грн`);
            }
        } catch (err) {
            console.error('Bid handler error', err);
            await ctx.answerCbQuery(`Забагато ставок, спробуй ще раз`, {show_alert: true});
        } finally {
            // обовʼязково знімаємо лок
            activeLocks.delete(lockKey);
        }
    });
}

