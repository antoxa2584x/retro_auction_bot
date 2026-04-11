import schedule from 'node-schedule';
import { q } from './db.js';
import { makeEmptyFinishKb, winnerKeyboard } from '../utils/keyboards.js';
import { getContactNickname, CHANNEL_USERNAME } from "../config/env.js";
import { getAuctionLink, escapeHtml, formatUserLink, formatContactLink } from '../utils/utils.js';
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

    for (const bidder of bidders) {
        try {
            await bot.sendMessage(bidder.user_id, reminderText, { parse_mode: 'HTML' });
        } catch (err) {
            console.error(`Failed to send reminder to ${bidder.user_id}:`, err.message);
        }
    }
}

/**
 * Closes an auction, updates the UI, and notifies the winner and admins.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} chat_id - The chat ID where the auction is posted.
 * @param {number} message_id - The message ID of the auction post.
 */
export async function closeAuction(bot, chat_id, message_id) {
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
            await bot.editMessageReplyMarkup(
                winnerKeyboard(row.leader_id, row.leader_name, row.current_price),
                { chat_id: chat_id, message_id: message_id }
            ).catch(() => {});

            if (!alreadyFinished) {
                // Notify winner
                const nickname = row.admin_contact || getContactNickname();
                const adminLink = formatContactLink(nickname);
                
                const winnerText = t('scheduler.winner_notify', {
                    link: auctionLink,
                    title: row.title,
                    price: row.current_price,
                    admin_link: adminLink
                });
                try {
                    if (row.photo_id) {
                        await bot.sendPhoto(row.leader_id, row.photo_id, {
                            caption: winnerText,
                            parse_mode: 'HTML'
                        });
                    } else {
                        await bot.sendMessage(row.leader_id, winnerText, { parse_mode: 'HTML' });
                    }
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
                    name: escapedWinnerName,
                    mention: formatUserLink(row.leader_id, row.leader_name)
                });
                for (const admin of admins) {
                    try {
                        await bot.sendMessage(admin.user_id, adminNotifyText, { parse_mode: 'HTML' });
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
            await bot.editMessageReplyMarkup(
                makeEmptyFinishKb(),
                { chat_id: chat_id, message_id: message_id }
            ).catch(() => {});

            if (!alreadyFinished) {
                // Notify admins about no bids
                const adminNotifyText = t('scheduler.admin_no_bids_notify', {
                    link: auctionLink,
                    title: row.title
                });
                for (const admin of admins) {
                    try {
                        await bot.sendMessage(admin.user_id, adminNotifyText, { parse_mode: 'HTML' });
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

/**
 * Restores all scheduled closing jobs for active auctions after a bot restart.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 */
export function restoreJobs(bot) {
    const rows = q.selectActive.all();
    for (const r of rows) {
        const when = new Date(r.end_at);
        if (when > new Date()) {
            scheduleClose(bot, r.chat_id, r.message_id, when);
        } else {
            setTimeout(() => closeAuction(bot, r.chat_id, r.message_id), 2_000);
        }
    }

    // Restore custom notifications
    const notifications = q.getAllActiveNotifications.all();
    for (const n of notifications) {
        const endAt = new Date(n.end_at);
        scheduleOneCustomNotification(bot, n.chat_id, n.message_id, n.user_id, n.hours, endAt);
    }
}
