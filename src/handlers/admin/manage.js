import { q } from '../../services/db.js';
import { makeKb, makeAdminActiveKb, makeAdminFinishedKb, makeAdminAuctionActionKb, makeAdminPanelKb } from '../../utils/keyboards.js';
import { TZ } from "../../config/env.js";
import { formatInTimeZone } from 'date-fns-tz';
import { scheduleClose, closeAuction } from '../../services/scheduler.js';
import { getAuctionLink } from '../../utils/utils.js';
import { t } from '../../services/i18n.js';

/**
 * Registers handlers for managing auctions in the admin panel.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 */
export function registerManageHandlers(bot) {
    bot.on('callback_query', async (query) => {
        const { data, message, from } = query;
        const chatId = message.chat.id;
        const messageId = message.message_id;

        if (data === 'adm_list') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);
            await sendAdminPanel(bot, chatId, true, messageId);
        }

        if (data === 'adm_active') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);

            const auctions = q.getAllActiveAuctions.all();

            if (auctions.length === 0) {
                await bot.editMessageText(t('admin.panel_header') + '\n\n' + t('admin.no_active_auctions'), {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[{ text: t('admin.kb.back_to_panel'), callback_data: 'adm_list', style: 'primary' }]]
                    }
                });
                return;
            }

            await bot.editMessageText(t('admin.panel_header') + '\n\n' + t('admin.active_auctions_header'), {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                reply_markup: makeAdminActiveKb(auctions)
            });
        }

        if (data === 'adm_finished') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);

            const auctions = q.getRecentlyFinishedAuctions.all();

            if (auctions.length === 0) {
                await bot.editMessageText(t('admin.panel_header') + '\n\n' + t('admin.no_finished_auctions'), {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML',
                    reply_markup: {
                        inline_keyboard: [[{ text: t('admin.kb.back_to_panel'), callback_data: 'adm_list', style: 'primary' }]]
                    }
                });
                return;
            }

            await bot.editMessageText(t('admin.panel_header') + '\n\n' + t('admin.finished_auctions_header'), {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                reply_markup: makeAdminFinishedKb(auctions)
            });
        }

        const viewMatch = data.match(/^adm_view:(.+):(.+)$/);
        if (viewMatch) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);

            const targetChatId = Number(viewMatch[1]);
            const targetMsgId = Number(viewMatch[2]);
            const a = q.getAuction.get(targetChatId, targetMsgId);

            if (!a) return bot.answerCallbackQuery(query.id, { text: t('bid.not_found'), show_alert: true });

            const endDate = formatInTimeZone(new Date(a.end_at), TZ, 'dd.MM.yyyy HH:mm');
            const link = getAuctionLink(targetChatId, targetMsgId);
            
            const statusText = a.status === 'active' ? t('admin.status_active') : t('admin.status_finished');
            
            const winner = a.leader_id 
                ? `<a href="tg://user?id=${a.leader_id}">${a.leader_name || a.leader_id}</a>`
                : t('bid.no_bids');

            const text = t('admin.panel_header') + '\n\n' +
                t('admin.auction_details', {
                    title: a.title,
                    chat_id: targetChatId,
                    message_id: targetMsgId,
                    price: a.current_price,
                    status: statusText,
                    end_at: endDate,
                    winner: winner,
                    link: link
                });

            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                reply_markup: makeAdminAuctionActionKb(targetChatId, targetMsgId, a.status)
            });
        }

        const restartMatch = data.match(/^adm_restart:(.+):(.+)$/);
        if (restartMatch) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);

            const targetChatId = Number(restartMatch[1]);
            const targetMsgId = Number(restartMatch[2]);
            const a = q.getAuction.get(targetChatId, targetMsgId);

            if (!a) return bot.answerCallbackQuery(query.id, { text: t('bid.not_found'), show_alert: true });
            if (a.status !== 'finished') return bot.answerCallbackQuery(query.id, { text: 'Only finished auctions can be restarted', show_alert: true });

            const originalEnd = new Date(a.end_at);
            const newEnd = new Date();
            newEnd.setDate(newEnd.getDate() + 4);
            newEnd.setHours(originalEnd.getHours(), originalEnd.getMinutes(), originalEnd.getSeconds(), originalEnd.getMilliseconds());

            const newEndStr = formatInTimeZone(newEnd, TZ, 'dd.MM');
            const newTimeStr = formatInTimeZone(newEnd, TZ, 'HH:mm');
            const reEnd = /Завершення\s+аукціону:\s*([0-3]?\d\.[01]?\d)\s*о\s*([0-2]?\d:[0-5]\d)/i;
            const updatedFullText = a.full_text.replace(reEnd, `Завершення аукціону: ${newEndStr} о ${newTimeStr}`);

            let newMsg;
            try {
                const kb = makeKb(targetChatId, 0, a.min_bid, 0);
                if (a.photo_id) {
                    newMsg = await bot.sendPhoto(targetChatId, a.photo_id, {
                        caption: updatedFullText,
                        parse_mode: 'HTML',
                        reply_markup: kb
                    });
                } else {
                    newMsg = await bot.sendMessage(targetChatId, updatedFullText, {
                        parse_mode: 'HTML',
                        reply_markup: kb
                    });
                }
            } catch (e) {
                console.error('Failed to create new post for restart:', e.message);
                return bot.answerCallbackQuery(query.id, { text: t('common.error_try_again'), show_alert: true });
            }

            try {
                const finalKb = makeKb(targetChatId, newMsg.message_id, a.min_bid, 0);
                await bot.editMessageReplyMarkup(finalKb, {
                    chat_id: targetChatId,
                    message_id: newMsg.message_id
                });
            } catch (e) {
                console.error('Failed to update new post keyboard:', e.message);
            }

            q.insertAuction.run({
                chat_id: targetChatId,
                message_id: newMsg.message_id,
                title: a.title,
                full_text: updatedFullText,
                photo_id: a.photo_id,
                min_bid: a.min_bid,
                step: a.step,
                current_price: a.min_bid,
                admin_contact: a.admin_contact,
                end_at: newEnd.toISOString()
            });

            scheduleClose(bot, targetChatId, newMsg.message_id, newEnd);

            await bot.sendMessage(chatId, t('admin.restart_success', { 
                title: a.title, 
                date: formatInTimeZone(newEnd, TZ, 'dd.MM.yyyy HH:mm') 
            }), { parse_mode: 'HTML' });
            await sendAdminPanel(bot, chatId, true, messageId);
        }

        const finishNowMatch = data.match(/^adm_finish_now:(.+):(.+)$/);
        if (finishNowMatch) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);

            const targetChatId = Number(finishNowMatch[1]);
            const targetMsgId = Number(finishNowMatch[2]);
            const a = q.getAuction.get(targetChatId, targetMsgId);

            if (!a) return bot.answerCallbackQuery(query.id, { text: t('bid.not_found'), show_alert: true });
            if (a.status !== 'active') return bot.answerCallbackQuery(query.id, { text: 'Only active auctions can be finished', show_alert: true });

            await closeAuction(bot, targetChatId, targetMsgId);

            await bot.sendMessage(chatId, t('admin.finish_success', { title: a.title }), { parse_mode: 'HTML' });
            await sendAdminPanel(bot, chatId, true, messageId);
        }
    });
}

/**
 * Sends or updates the main admin panel message.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} chatId - Chat ID.
 * @param {boolean} isEdit - Whether to edit the existing message instead of sending a new one.
 * @param {number} [messageId] - Message ID to edit.
 */
export async function sendAdminPanel(bot, chatId, isEdit = false, messageId = null) {
    const active = q.getAllActiveAuctions.all();
    const finished = q.getRecentlyFinishedAuctions.all();

    let text = t('admin.panel_header') + '\n\n';
    let kb = makeAdminPanelKb();

    if (active.length === 0 && finished.length === 0) {
        text += t('admin.no_auctions_in_db');
    } else {
        text += t('admin.choose_category');
    }

    if (isEdit && messageId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: kb });
        } catch (e) {
            if (!e.message.includes('message is not modified')) {
                await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
            }
        }
    } else {
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
    }
}

function isAdmin(userId) {
    const admin = q.getAdmin.get(userId);
    return admin && admin.otp_code === null;
}
