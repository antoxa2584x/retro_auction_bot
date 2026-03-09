import schedule from 'node-schedule';
import { q } from './db.js';
import { makeEmptyFinishKb, winnerKeyboard } from '../utils/keyboards.js';
import { getAdminNickname, CHANNEL_USERNAME } from "../config/env.js";
import { getAuctionLink, escapeHtml } from '../utils/utils.js';
import { t } from './i18n.js';

export function scheduleClose(ctx, chat_id, message_id, when) {
    const id = `${chat_id}:${message_id}`;
    schedule.cancelJob(id);
    schedule.scheduleJob(id, when, async () => closeAuction(ctx, chat_id, message_id));
}

export async function closeAuction(ctx, chat_id, message_id) {
    const row = q.getAuction.get(chat_id, message_id);
    if (!row) return;

    const alreadyFinished = row.status === 'finished';
    if (!alreadyFinished) {
        q.finish.run(chat_id, message_id);
    }

    const auctionLink = getAuctionLink(chat_id, message_id);
    const admins = q.getAllAdmins.all();

    if (row.leader_id) {
        try {
            await ctx.telegram.editMessageReplyMarkup(
                chat_id,
                message_id,
                null,
                winnerKeyboard(row.leader_id, row.leader_name, row.current_price)
            ).catch(() => {});

            if (!alreadyFinished) {
                // Notify winner
                const nickname = getAdminNickname();
                const adminContact = nickname.startsWith('@') ? nickname : `@${nickname}`;
                const winnerText = t('scheduler.winner_notify', {
                    link: auctionLink,
                    title: row.title,
                    price: row.current_price,
                    admin: adminContact
                });
                try {
                    await ctx.telegram.sendMessage(row.leader_id, winnerText, { parse_mode: 'HTML' });
                } catch (err) {
                    console.error(`Failed to notify winner ${row.leader_id}:`, err.message);
                }

                // Notify admins
                const escapedWinnerName = escapeHtml(row.leader_name);
                const adminNotifyText = t('scheduler.admin_finished_notify', {
                    link: auctionLink,
                    title: row.title,
                    price: row.current_price,
                    user_id: row.leader_id,
                    name: escapedWinnerName
                });
                for (const admin of admins) {
                    try {
                        await ctx.telegram.sendMessage(admin.user_id, adminNotifyText, { parse_mode: 'HTML' });
                    } catch (e) {
                        console.error(`Failed to notify admin ${admin.user_id}:`, e.message);
                    }
                }
            }
        } catch (e) {
            console.error('Error closing auction with winner:', e.message);
        }
    } else {
        try {
            await ctx.telegram.editMessageReplyMarkup(
                chat_id,
                message_id,
                null,
                makeEmptyFinishKb()
            ).catch(() => {});

            if (!alreadyFinished) {
                // Notify admins about no bids
                const adminNotifyText = t('scheduler.admin_no_bids_notify', {
                    link: auctionLink,
                    title: row.title
                });
                for (const admin of admins) {
                    try {
                        await ctx.telegram.sendMessage(admin.user_id, adminNotifyText, { parse_mode: 'HTML' });
                    } catch (e) {
                        console.error(`Failed to notify admin ${admin.user_id}:`, e.message);
                    }
                }
            }
        } catch (e) {
            console.error('Error closing auction without winner:', e.message);
        }
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
