import schedule from 'node-schedule';
import { q } from './db.js';
import { makeEmptyFinishKb, winnerKeyboard } from '../utils/keyboards.js';
import { getContactNickname, CHANNEL_USERNAME } from "../config/env.js";
import { getAuctionLink, escapeHtml, formatUserLink, formatContactLink, truncateCaption, setStatusTag } from '../utils/utils.js';
import { t, getCurrency } from './i18n.js';

/**
 * Schedules the automatic closing of an auction and related reminders.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} chat_id - The chat ID where the auction is posted.
 * @param {number} message_id - The message ID of the auction post.
 * @param {Date} when - The date and time when the auction should close.
 */
export function scheduleClose(bot, chat_id, message_id, when) {
    const id = `${chat_id}:${message_id}`;
    schedule.cancelJob(id);
    schedule.scheduleJob(id, when, async () => closeAuction(bot, chat_id, message_id));

    // Schedule 30m reminder
    const reminderId = `reminder:${chat_id}:${message_id}`;
    schedule.cancelJob(reminderId);
    scheduleReminder(bot, chat_id, message_id, when);

    // Schedule custom notifications
    scheduleCustomNotifications(bot, chat_id, message_id, when);
}

/**
 * Cancels every scheduled job belonging to an auction (close, reminder and
 * per-user custom notifications). Must be called when an auction is deleted,
 * otherwise the jobs stay in node-schedule's registry and fire against a
 * missing row.
 *
 * @param {number} chat_id - The chat ID.
 * @param {number} message_id - The message ID.
 */
export function cancelAuctionJobs(chat_id, message_id) {
    schedule.cancelJob(`${chat_id}:${message_id}`);
    schedule.cancelJob(`reminder:${chat_id}:${message_id}`);
    const notifyPrefix = `notify:${chat_id}:${message_id}:`;
    for (const name of Object.keys(schedule.scheduledJobs)) {
        if (name.startsWith(notifyPrefix)) schedule.cancelJob(name);
    }
}

/**
 * Schedules custom notifications set by users for an auction.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} chat_id - The chat ID.
 * @param {number} message_id - The message ID.
 * @param {Date} endAt - The end date.
 */
export function scheduleCustomNotifications(bot, chat_id, message_id, endAt) {
    const notifications = q.getAuctionNotifications.all(chat_id, message_id);
    for (const n of notifications) {
        scheduleOneCustomNotification(bot, chat_id, message_id, n.user_id, n.hours, endAt);
    }
}

/**
 * Schedules a single custom notification.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} chat_id - Chat ID.
 * @param {number} message_id - Message ID.
 * @param {number} userId - User ID.
 * @param {number} hours - Hours before end.
 * @param {Date} endAt - End date.
 */
export function scheduleOneCustomNotification(bot, chat_id, message_id, userId, hours, endAt) {
    const id = `notify:${chat_id}:${message_id}:${userId}`;
    schedule.cancelJob(id);

    return _scheduleOneCustomNotification(bot, chat_id, message_id, userId, hours, endAt, id);
}

/**
 * Cancels a single user's custom notification job (e.g. when the user removes
 * their reminder). Without this the node-schedule job lingers in the registry
 * until its fire time even though the DB row is gone.
 *
 * @param {number} chat_id - Chat ID.
 * @param {number} message_id - Message ID.
 * @param {number} userId - User ID.
 */
export function cancelCustomNotification(chat_id, message_id, userId) {
    schedule.cancelJob(`notify:${chat_id}:${message_id}:${userId}`);
}

function _scheduleOneCustomNotification(bot, chat_id, message_id, userId, hours, endAt, id) {

    const notifyTime = new Date(endAt.getTime() - hours * 60 * 60 * 1000);
    if (notifyTime > new Date()) {
        schedule.scheduleJob(id, notifyTime, async () => {
            const row = q.getAuction.get(chat_id, message_id);
            if (!row || row.status !== 'active') return;

            // Check if this notification still exists in DB (not removed by user)
            const exists = q.getNotification.get(chat_id, message_id, userId);
            if (!exists || exists.hours !== hours) return;

            const link = getAuctionLink(chat_id, message_id);
            const cur = getCurrency();
            const text = t('admin.notify_reminder', {
                link,
                title: row.title,
                hours,
                price: row.current_price,
                cur
            });

            try {
                await bot.sendMessage(userId, text, { parse_mode: 'HTML' });
            } catch (err) {
                console.error(`Failed to send custom notify to ${userId}:`, err.message);
            }
        });
    }
}

/**
 * Schedules a reminder 30 minutes before the auction ends.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} chat_id - The chat ID where the auction is posted.
 * @param {number} message_id - The message ID of the auction post.
 * @param {Date} endAt - The date and time when the auction ends.
 */
export function scheduleReminder(bot, chat_id, message_id, endAt) {
    const reminderId = `reminder:${chat_id}:${message_id}`;
    schedule.cancelJob(reminderId);

    const reminderTime = new Date(endAt.getTime() - 30 * 60 * 1000);
    if (reminderTime > new Date()) {
        schedule.scheduleJob(reminderId, reminderTime, async () => sendReminder(bot, chat_id, message_id));
    }
}

/**
 * Sends a reminder to all bidders of an auction.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} chat_id - The chat ID where the auction is posted.
 * @param {number} message_id - The message ID of the auction post.
 */
export async function sendReminder(bot, chat_id, message_id) {
    const row = q.getAuction.get(chat_id, message_id);
    if (!row || row.status !== 'active') return;

    const bidders = q.getBidders.all(chat_id, message_id);
    if (bidders.length === 0) return;

    const auctionLink = getAuctionLink(chat_id, message_id);
    const reminderText = t('scheduler.reminder_30m', {
        link: auctionLink,
        title: row.title,
        price: row.current_price
    });

    // Send in bounded-concurrency chunks instead of one-by-one: parallel within
    // a chunk for speed, chunked to stay under Telegram's ~30 msg/s limit.
    const CHUNK = 25;
    for (let i = 0; i < bidders.length; i += CHUNK) {
        await Promise.allSettled(bidders.slice(i, i + CHUNK).map(bidder =>
            bot.sendMessage(bidder.user_id, reminderText, { parse_mode: 'HTML' })
                .catch(err => console.error(`Failed to send reminder to ${bidder.user_id}:`, err.message))
        ));
        if (i + CHUNK < bidders.length) {
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

/**
 * Closes an auction, updates the UI, and notifies the winner and admins.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} chat_id - The chat ID where the auction is posted.
 * @param {number} message_id - The message ID of the auction post.
 * @param {boolean} [force=false] - Close even if end_at is still in the future (manual admin close).
 */
export async function closeAuction(bot, chat_id, message_id, force = false) {
    const row = q.getAuction.get(chat_id, message_id);
    if (!row) return;

    // Guard against stale close jobs: if the auction was extended (continuous mode)
    // after this job was scheduled, don't close early — reschedule to the real end time.
    if (!force && row.status === 'active') {
        const endAt = new Date(row.end_at);
        if (endAt > new Date()) {
            console.warn(`Stale close job for auction ${chat_id}:${message_id} — end_at is ${row.end_at}, rescheduling.`);
            scheduleClose(bot, chat_id, message_id, endAt);
            return;
        }
    }

    const alreadyFinished = row.status === 'finished';
    if (!alreadyFinished) {
        q.finish.run(chat_id, message_id);
    }

    const freshRow = q.getAuction.get(chat_id, message_id);
    if (!freshRow) return;

    const rescheduleIfLimit = async (err) => {
        if (err.message.includes('Too Many Requests') || (err.response && err.response.status === 429)) {
            const delay = Math.floor(Math.random() * (60 - 30 + 1) + 30) * 1000;
            console.warn(`Too Many Requests while updating keyboard for auction ${chat_id}:${message_id}. Rescheduling in ${delay / 1000}s`);
            setTimeout(() => closeAuction(bot, chat_id, message_id), delay);
            return true;
        }
        return false;
    };

    const auctionLink = getAuctionLink(chat_id, message_id);
    const admins = q.getAllAdmins.all();

    // Flip the status hashtag in the post header (#активний → #завершений, in the
    // bot's language). setStatusTag rewrites the header tag instead of patching
    // occurrences, so a post that picked up a stray tag from an older restart is
    // cleaned up here — the winner/empty keyboard is re-applied by the branches below.
    if (!alreadyFinished && freshRow.full_text) {
        const updatedText = setStatusTag(freshRow.full_text, 'finished');
        if (updatedText && updatedText !== freshRow.full_text) {
            try {
                if (freshRow.photo_id) {
                    await bot.editMessageCaption(truncateCaption(updatedText), {
                        chat_id, message_id, parse_mode: 'HTML'
                    });
                } else {
                    await bot.editMessageText(updatedText, {
                        chat_id, message_id, parse_mode: 'HTML'
                    });
                }
                q.updateAuctionFullText.run(updatedText, chat_id, message_id);
                freshRow.full_text = updatedText;
            } catch (err) {
                if (!(await rescheduleIfLimit(err)) && !err.message.includes('message is not modified')) {
                    console.error(`Failed to update status tag for auction ${chat_id}:${message_id}:`, err.message);
                }
            }
        }
    }

    if (freshRow.leader_id) {
        try {
            await bot.editMessageReplyMarkup(
                winnerKeyboard(freshRow.leader_id, freshRow.leader_name, freshRow.current_price),
                { chat_id: chat_id, message_id: message_id }
            ).catch(async (err) => {
                if (await rescheduleIfLimit(err)) return;
                if (err.message.includes('BUTTON_USER_PRIVACY_RESTRICTED')) {
                    // Privacy settings prevent profile link, retry without it
                    await bot.editMessageReplyMarkup(
                        winnerKeyboard(freshRow.leader_id, freshRow.leader_name, freshRow.current_price, false),
                        { chat_id: chat_id, message_id: message_id }
                    ).catch(async (e) => {
                        if (await rescheduleIfLimit(e)) return;
                        console.error(`Failed to update winner keyboard (no-link) for auction ${chat_id}:${message_id}:`, e.message);
                    });
                } else if (!err.message.includes('message is not modified')) {
                    console.error(`Failed to update winner keyboard for auction ${chat_id}:${message_id}:`, err.message);
                }
            });

            if (!alreadyFinished) {
                // Notify winner
                const nickname = freshRow.admin_contact || getContactNickname();
                const adminLink = formatContactLink(nickname);
                
                const winnerText = t('scheduler.winner_notify', {
                    link: auctionLink,
                    title: freshRow.title,
                    price: freshRow.current_price,
                    admin_link: adminLink
                });
                try {
                    if (freshRow.photo_id) {
                        await bot.sendPhoto(freshRow.leader_id, freshRow.photo_id, {
                            caption: truncateCaption(winnerText),
                            parse_mode: 'HTML'
                        });
                    } else {
                        await bot.sendMessage(freshRow.leader_id, winnerText, { parse_mode: 'HTML' });
                    }
                } catch (err) {
                    console.error(`Failed to notify winner ${freshRow.leader_id}:`, err.message);
                }

                // Notify admins
                const escapedWinnerName = escapeHtml(freshRow.leader_name);
                const adminNotifyText = t('scheduler.admin_finished_notify', {
                    link: auctionLink,
                    title: freshRow.title,
                    price: freshRow.current_price,
                    user_id: freshRow.leader_id,
                    name: escapedWinnerName,
                    mention: formatUserLink(freshRow.leader_id, freshRow.leader_name)
                });
                await Promise.allSettled(admins.map(admin =>
                    bot.sendMessage(admin.user_id, adminNotifyText, { parse_mode: 'HTML' })
                        .catch(e => console.error(`Failed to notify admin ${admin.user_id}:`, e.message))
                ));
            }
        } catch (e) {
            console.error('Error closing auction with winner:', e.message);
        }
    } else {
        try {
            await bot.editMessageReplyMarkup(
                makeEmptyFinishKb(),
                { chat_id: chat_id, message_id: message_id }
            ).catch(async (err) => {
                if (await rescheduleIfLimit(err)) return;
                if (!err.message.includes('message is not modified')) {
                    console.error(`Failed to update empty finish keyboard for auction ${chat_id}:${message_id}:`, err.message);
                }
            });

            if (!alreadyFinished) {
                // Notify admins about no bids
                const adminNotifyText = t('scheduler.admin_no_bids_notify', {
                    link: auctionLink,
                    title: freshRow.title
                });
                await Promise.allSettled(admins.map(admin =>
                    bot.sendMessage(admin.user_id, adminNotifyText, { parse_mode: 'HTML' })
                        .catch(e => console.error(`Failed to notify admin ${admin.user_id}:`, e.message))
                ));
            }
        } catch (e) {
            console.error('Error closing auction without winner:', e.message);
        }
    }
}

/**
 * Restores all scheduled closing jobs for active auctions after a bot restart.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 */
export function restoreJobs(bot) {
    const rows = q.selectActive.all();
    // Stagger overdue closes: each one edits the channel message and notifies
    // winner + all admins, so firing them all at once on restart would burst
    // straight into Telegram's rate limit. Space them ~3s apart.
    let overdueIndex = 0;
    for (const r of rows) {
        const when = new Date(r.end_at);
        if (when > new Date()) {
            scheduleClose(bot, r.chat_id, r.message_id, when);
        } else {
            setTimeout(() => closeAuction(bot, r.chat_id, r.message_id), 2_000 + overdueIndex * 3_000);
            overdueIndex++;
        }
    }

    // Restore custom notifications
    const notifications = q.getAllActiveNotifications.all();
    for (const n of notifications) {
        const endAt = new Date(n.end_at);
        scheduleOneCustomNotification(bot, n.chat_id, n.message_id, n.user_id, n.hours, endAt);
    }
}
