import schedule from 'node-schedule';
import { q } from './db.js';
import { makeEmptyFinishKb, winnerKeyboard } from './keyboards.js';

export function scheduleClose(ctx, chat_id, message_id, when) {
    const id = `${chat_id}:${message_id}`;
    schedule.cancelJob(id);
    schedule.scheduleJob(id, when, async () => closeAuction(ctx, chat_id, message_id));
}

export async function closeAuction(ctx, chat_id, message_id) {
    const row = q.getAuction.get(chat_id, message_id);

    q.finish.run(chat_id, message_id);

    if (row.leader_id) {
        try {
            await ctx.telegram.editMessageReplyMarkup(
                chat_id,
                message_id,
                null,
                winnerKeyboard(row.leader_id, row.leader_name, row.current_price)
            );
        } catch {}
    } else {
        await ctx.telegram.editMessageReplyMarkup(
            chat_id,
            message_id,
            null,
            makeEmptyFinishKb(chat_id, message_id)
        );
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
