import schedule from 'node-schedule';
import { q } from './db.js';
import { makeEmptyFinishKb, winnerKeyboard } from './keyboards.js';
import {ADMIN_NICKNAME, CHANNEL_USERNAME} from "./env.js";

function getAuctionLink(chatId, messageId) {
    if (CHANNEL_USERNAME) {
        return `https://t.me/${CHANNEL_USERNAME.replace('@', '')}/${messageId}`;
    }
    const cleanId = Math.abs(chatId).toString().replace(/^100/, '');
    return `https://t.me/c/${cleanId}/${messageId}`;
}

export function scheduleClose(ctx, chat_id, message_id, when) {
    const id = `${chat_id}:${message_id}`;
    schedule.cancelJob(id);
    schedule.scheduleJob(id, when, async () => closeAuction(ctx, chat_id, message_id));
}

export async function closeAuction(ctx, chat_id, message_id) {
    const row = q.getAuction.get(chat_id, message_id);
    if (!row || row.status === 'finished') return;

    q.finish.run(chat_id, message_id);

    if (row.leader_id) {
        try {
            await ctx.telegram.editMessageReplyMarkup(
                chat_id,
                message_id,
                null,
                winnerKeyboard(row.leader_id, row.leader_name, row.current_price)
            ).catch(() => {});

            // Notify winner
            try {
                const auctionLink = getAuctionLink(chat_id, message_id);
                const adminContact = ADMIN_NICKNAME.startsWith('@') ? ADMIN_NICKNAME : `@${ADMIN_NICKNAME}`;
                const winnerText = `🏆 Вітаємо! Ви перемогли в аукціоні <a href="${auctionLink}">"${row.title}"</a>!\n` +
                                 `Фінальна ціна: <b>${row.current_price} грн</b>\n\n` +
                                 `Для подальших кроків, звяжіться з ${adminContact}`;
                await ctx.telegram.sendMessage(row.leader_id, winnerText, { parse_mode: 'HTML' });
            } catch (err) {
                console.error(`Failed to notify winner ${row.leader_id}:`, err.message);
            }
        } catch {}
    } else {
        try {
            await ctx.telegram.editMessageReplyMarkup(
                chat_id,
                message_id,
                null,
                makeEmptyFinishKb()
            ).catch(() => {});
        } catch {}
    }
}

export function restoreJobs(ctx) {
    const rows = q.selectActive.all();
    for (const r of rows) {
        const when = new Date(r.end_at);
        if (when > new Date()) {
            scheduleClose(ctx, r.chat_id, r.message_id, when);
        } else {
            setTimeout(() => closeAuction(ctx, r.chat_id, r.message_id), 2_000);
        }
    }
}
