import { q, undoLastBidTransaction } from '../../services/db.js';
import { makeKb, makeAdminActiveKb, makeAdminFinishedKb, makeAdminAuctionActionKb, makeAdminPanelKb, winnerKeyboard, makeEmptyFinishKb } from '../../utils/keyboards.js';
import { TZ, getContactNickname } from "../../config/env.js";
import { formatInTimeZone } from 'date-fns-tz';
import { scheduleClose, closeAuction } from '../../services/scheduler.js';
import { getAuctionLink, formatUserLink } from '../../utils/utils.js';
import { t, getCurrency } from '../../services/i18n.js';

function isAdmin(userId) {
    const admin = q.getAdmin.get(userId);
    return admin && admin.otp_code === null;
}

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
            try {
                if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
                await bot.answerCallbackQuery(query.id);
            } catch (e) {
                console.error('Error answering adm_list callback:', e.message);
            }
            await sendAdminPanel(bot, chatId, true, messageId);
        }

        if (data === 'adm_active') {
            try {
                if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
                await bot.answerCallbackQuery(query.id);
            } catch (e) {
                console.error('Error answering adm_active callback:', e.message);
            }

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
            try {
                if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
                await bot.answerCallbackQuery(query.id);
            } catch (e) {
                console.error('Error answering adm_finished callback:', e.message);
            }

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
            try {
                if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
                await bot.answerCallbackQuery(query.id);
            } catch (e) {
                console.error('Error answering adm_view callback:', e.message);
            }

            const targetChatId = Number(viewMatch[1]);
            const targetMsgId = Number(viewMatch[2]);
            const a = q.getAuction.get(targetChatId, targetMsgId);

            if (!a) {
                try {
                    return bot.answerCallbackQuery(query.id, { text: t('bid.not_found'), show_alert: true });
                } catch (e) {
                    console.error('Error answering adm_view not_found callback:', e.message);
                    return;
                }
            }

            const endDate = formatInTimeZone(new Date(a.end_at), TZ, 'dd.MM.yyyy HH:mm');
            const link = getAuctionLink(targetChatId, targetMsgId);
            
            const statusText = a.status === 'active' ? t('admin.status_active') : t('admin.status_finished');
            
            const winner = a.leader_id 
                ? formatUserLink(a.leader_id, a.leader_name)
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
            try {
                if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
                await bot.answerCallbackQuery(query.id);
            } catch (e) {
                console.error('Error answering adm_restart callback:', e.message);
            }

            const targetChatId = Number(restartMatch[1]);
            const targetMsgId = Number(restartMatch[2]);
            const a = q.getAuction.get(targetChatId, targetMsgId);

            if (!a) {
                try {
                    return bot.answerCallbackQuery(query.id, { text: t('bid.not_found'), show_alert: true });
                } catch (e) {
                    console.error('Error answering adm_restart not_found callback:', e.message);
                    return;
                }
            }
            if (a.status !== 'finished') {
                try {
                    return bot.answerCallbackQuery(query.id, { text: 'Only finished auctions can be restarted', show_alert: true });
                } catch (e) {
                    console.error('Error answering adm_restart not_finished callback:', e.message);
                    return;
                }
            }

            const originalEnd = new Date(a.end_at);
            const newEnd = new Date();
            newEnd.setDate(newEnd.getDate() + 4);
            newEnd.setHours(originalEnd.getHours(), originalEnd.getMinutes(), originalEnd.getSeconds(), originalEnd.getMilliseconds());

            const newEndStr = formatInTimeZone(newEnd, TZ, 'dd.MM');
            const newTimeStr = formatInTimeZone(newEnd, TZ, 'HH:mm');

            // Find the line that starts with what's in admin.auction_end_date_text ("Завершення аукціону")
            const endDateText = q.getSetting.get('AUCTION_END_DATE_TEXT')?.value || t('parse.defaults.end_date');
            const reEnd = new RegExp(`(${endDateText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:?\\s*)[0-3]?\\d\\.[01]?\\d\\s*о\\s*[0-2]?\\d:[0-5]\\d`, 'i');
            
            let updatedFullText;
            if (reEnd.test(a.full_text)) {
                updatedFullText = a.full_text.replace(reEnd, `$1${newEndStr} о ${newTimeStr}`);
            } else {
                // If regex doesn't match for some reason, we might need a more generic fallback 
                const fallbackRe = /([0-3]?\d\.[01]?\d)\s*о\s*([0-2]?\d:[0-5]\d)/;
                if (fallbackRe.test(a.full_text)) {
                    updatedFullText = a.full_text.replace(fallbackRe, `${newEndStr} о ${newTimeStr}`);
                } else {
                    updatedFullText = a.full_text;
                }
            }

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
                try {
                    return bot.answerCallbackQuery(query.id, { text: t('common.error_try_again'), show_alert: true });
                } catch (err) {
                    console.error('Error answering adm_restart error callback:', err.message);
                    return;
                }
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
                end_at: newEnd.toISOString(),
                is_continuous: a.is_continuous,
                continuous_minutes: a.continuous_minutes
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
            try {
                if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
                await bot.answerCallbackQuery(query.id);
            } catch (e) {
                console.error('Error answering adm_finish_now callback:', e.message);
            }

            const targetChatId = Number(finishNowMatch[1]);
            const targetMsgId = Number(finishNowMatch[2]);
            const a = q.getAuction.get(targetChatId, targetMsgId);

            if (!a) {
                try {
                    return bot.answerCallbackQuery(query.id, { text: t('bid.not_found'), show_alert: true });
                } catch (e) {
                    console.error('Error answering adm_finish_now not_found callback:', e.message);
                    return;
                }
            }
            if (a.status !== 'active') {
                try {
                    return bot.answerCallbackQuery(query.id, { text: 'Only active auctions can be finished', show_alert: true });
                } catch (e) {
                    console.error('Error answering adm_finish_now not_active callback:', e.message);
                    return;
                }
            }

            await closeAuction(bot, targetChatId, targetMsgId);

            await bot.sendMessage(chatId, t('admin.finish_success', { title: a.title }), { parse_mode: 'HTML' });
            await sendAdminPanel(bot, chatId, true, messageId);
        }

        const undoBidMatch = data.match(/^adm_undo_bid:(.+):(.+)$/);
        if (undoBidMatch) {
            try {
                if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
                await bot.answerCallbackQuery(query.id);
            } catch (e) {
                console.error('Error answering adm_undo_bid callback:', e.message);
            }

            const targetChatId = Number(undoBidMatch[1]);
            const targetMsgId = Number(undoBidMatch[2]);
            
            const res = undoLastBidTransaction(targetChatId, targetMsgId);

            if (!res.success) {
                const errorKey = res.reason === 'no_bids' ? 'admin.undo_bid_no_bids' : 'bid.not_found';
                return bot.sendMessage(chatId, t(errorKey), { parse_mode: 'HTML' });
            }

            const auctionLink = getAuctionLink(targetChatId, targetMsgId);

            // 1. Notify the user whose bid was removed
            try {
                await bot.sendMessage(res.removedBidUserId, t('bid.bid_removed_notify', {
                    link: auctionLink,
                    title: res.auctionTitle
                }), { parse_mode: 'HTML' });
            } catch (err) {
                console.error(`Failed to notify user ${res.removedBidUserId} about removed bid:`, err.message);
            }

            // 2. Update channel post keyboard
            try {
                const a = q.getAuction.get(targetChatId, targetMsgId);
                let newKb;
                if (a.status === 'active') {
                    newKb = makeKb(targetChatId, targetMsgId, res.newPrice, res.participantsCount);
                    
                    // Notify new leader if any
                    if (res.newLeaderId) {
                        try {
                            await bot.sendMessage(res.newLeaderId, t('bid.new_winner_notify', {
                                link: auctionLink,
                                title: res.auctionTitle,
                                price: res.newPrice,
                                cur: getCurrency()
                            }), { parse_mode: 'HTML' });
                        } catch (err) {
                            console.error(`Failed to notify new leader ${res.newLeaderId} in active auction:`, err.message);
                        }
                    }
                } else {
                    // Finished auction
                    if (res.newLeaderId) {
                        newKb = winnerKeyboard(res.newLeaderId, res.newLeaderName, res.newPrice);
                        
                        // Notify new winner
                        const nickname = a.admin_contact || getContactNickname();
                        const adminContact = nickname.startsWith('@') ? nickname : `@${nickname}`;
                        const winnerText = t('scheduler.winner_notify', {
                            link: auctionLink,
                            title: res.auctionTitle,
                            price: res.newPrice,
                            admin: adminContact
                        });
                        try {
                            if (a.photo_id) {
                                await bot.sendPhoto(res.newLeaderId, a.photo_id, { caption: winnerText, parse_mode: 'HTML' });
                            } else {
                                await bot.sendMessage(res.newLeaderId, winnerText, { parse_mode: 'HTML' });
                            }
                        } catch (err) {
                            console.error(`Failed to notify new winner ${res.newLeaderId}:`, err.message);
                        }
                    } else {
                        newKb = makeEmptyFinishKb();
                    }
                }
                await bot.editMessageReplyMarkup(newKb, { chat_id: targetChatId, message_id: targetMsgId });
            } catch (err) {
                console.error('Failed to update channel post keyboard after undo bid:', err.message);
            }

            // 3. Confirm to admin
            await bot.sendMessage(chatId, t('admin.undo_bid_success', {
                price: res.newPrice,
                cur: getCurrency()
            }), { parse_mode: 'HTML' });
            
            await sendAdminPanel(bot, chatId, true, messageId);
        }
        
        const deleteMatch = data.match(/^adm_delete:(.+):(.+)$/);
        if (deleteMatch) {
            try {
                if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
                await bot.answerCallbackQuery(query.id);
            } catch (e) {
                console.error('Error answering adm_delete callback:', e.message);
            }

            const targetChatId = Number(deleteMatch[1]);
            const targetMsgId = Number(deleteMatch[2]);
            
            q.deleteAuction.run(targetChatId, targetMsgId);
            
            await bot.sendMessage(chatId, "Аукціон видалено з бази даних.");
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
