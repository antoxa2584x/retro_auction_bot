import { q, undoLastBidTransaction } from '../../services/db.js';
import { 
    makeKb, 
    makeAdminActiveKb, 
    makeAdminFinishedKb, 
    makeAdminAuctionActionKb, 
    makeAdminPanelKb, 
    winnerKeyboard, 
    makeEmptyFinishKb,
    makeAdminPendingKb,
    makeAdminPendingViewKb,
    makeAdminPendingRejectKb
} from '../../utils/keyboards.js';
import { getChannelId, TZ, getContactNickname } from "../../config/env.js";
import { formatInTimeZone } from 'date-fns-tz';
import { scheduleClose, closeAuction } from '../../services/scheduler.js';
import { getAuctionLink, formatUserLink, formatContactLink, buildAuctionText, sendAuctionGallery } from '../../utils/utils.js';
import { t, getCurrency } from '../../services/i18n.js';

function isAdmin(userId) {
    const admin = q.getAdmin.get(userId);
    return admin && admin.otp_code === null;
}

/** @type {Map<number, {pending_id: string}>} */
const adminSessions = new Map();

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
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});
            await sendAdminPanel(bot, chatId, true, messageId);
        }

        if (data === 'adm_pending') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});

            const pending = q.getPendingAuctions.all();
            if (pending.length === 0) {
                const noPendingText = t('admin.no_pending_auctions') || "No pending auctions.";
                const noPendingKb = makeAdminPanelKb();
                try {
                    return await bot.editMessageText(noPendingText, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'HTML',
                        reply_markup: noPendingKb
                    });
                } catch (e) {
                    await bot.deleteMessage(chatId, messageId).catch(() => {});
                    return await bot.sendMessage(chatId, noPendingText, {
                        parse_mode: 'HTML',
                        reply_markup: noPendingKb
                    });
                }
            }

            const pendingHeader = t('admin.pending_auctions_header') || "Pending auctions:";
            const pendingKb = makeAdminPendingKb(pending);
            try {
                await bot.editMessageText(pendingHeader, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML',
                    reply_markup: pendingKb
                });
            } catch (e) {
                await bot.deleteMessage(chatId, messageId).catch(() => {});
                await bot.sendMessage(chatId, pendingHeader, {
                    parse_mode: 'HTML',
                    reply_markup: pendingKb
                });
            }
        }

        if (data.startsWith('adm_pen_view:')) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});

            const id = data.split(':')[1];
            const p = q.getPendingAuction.get(id);
            if (!p) return bot.sendMessage(chatId, "Not found.");

            const userContact = formatContactLink(p.user_id ? `tg://user?id=${p.user_id}` : null);
            const headerText = t('admin.pending_auction_view_header', { contact: userContact });

            const text = headerText + '\n\n' + buildAuctionText(p, true, false);

            const photoIds = p.photo_ids ? p.photo_ids.split(',') : [];
            if (photoIds.length > 0) {
                await bot.sendPhoto(chatId, photoIds[0], {
                    caption: text,
                    parse_mode: 'HTML',
                    reply_markup: makeAdminPendingViewKb(id)
                });
            } else {
                await bot.sendMessage(chatId, text, {
                    parse_mode: 'HTML',
                    reply_markup: makeAdminPendingViewKb(id)
                });
            }
        }

        if (data.startsWith('adm_pen_approve:')) {
            const id = data.split(':')[1];
            const p = q.getPendingAuction.get(id);
            if (!p) return;

            try {
                const channelId = getChannelId();
                const auctionPost = buildAuctionText(p);

                const kb = makeKb(channelId, 0, p.min_bid, 0);
                const photoIds = p.photo_ids ? p.photo_ids.split(',') : [];
                let sentMsg;

                if (photoIds.length > 0) {
                    sentMsg = await bot.sendPhoto(channelId, photoIds[0], {
                        caption: auctionPost,
                        parse_mode: 'HTML',
                        reply_markup: kb
                    });

                    await sendAuctionGallery(bot, channelId, photoIds, sentMsg.message_id);
                } else {
                    sentMsg = await bot.sendMessage(channelId, auctionPost, {
                        parse_mode: 'HTML',
                        reply_markup: kb
                    });
                }

                const finalKb = makeKb(channelId, sentMsg.message_id, p.min_bid, 0);
                await bot.editMessageReplyMarkup(finalKb, {
                    chat_id: channelId,
                    message_id: sentMsg.message_id
                });

                q.insertAuction.run({
                    chat_id: channelId,
                    message_id: sentMsg.message_id,
                    title: p.title,
                    full_text: auctionPost,
                    photo_id: photoIds[0] || null,
                    min_bid: p.min_bid,
                    step: p.step,
                    current_price: p.min_bid,
                    admin_contact: p.user_id ? `tg://user?id=${p.user_id}` : getContactNickname(),
                    end_at: new Date(p.end_at).toISOString(),
                    is_continuous: p.is_continuous,
                    continuous_minutes: p.continuous_minutes
                });

                scheduleClose(bot, channelId, sentMsg.message_id, new Date(p.end_at));
                q.updatePendingAuctionStatus.run('approved', id);

                await bot.answerCallbackQuery(query.id, { text: t('admin.pending_auction_alert_approved') }).catch(() => {});
                await bot.sendMessage(p.user_id, t('admin.pending_auction_approved')).catch(() => {});
                await sendAdminPanel(bot, chatId, false);
            } catch (e) {
                console.error(e);
                await bot.answerCallbackQuery(query.id, { text: "Error: " + e.message });
            }
        }

        if (data.startsWith('adm_pen_reject:')) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            const id = data.split(':')[1];
            const p = q.getPendingAuction.get(id);
            if (!p) return bot.answerCallbackQuery(query.id, { text: "Not found." }).catch(() => {});

            bot.answerCallbackQuery(query.id).catch(() => {});
            adminSessions.set(from.id, { pending_id: id });

            const text = t('admin.pending_auction_reject_prompt', { title: p.title });
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                reply_markup: makeAdminPendingRejectKb(id)
            });
        }

        if (data.startsWith('adm_pen_reject_confirm:')) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            const id = data.split(':')[1];
            const p = q.getPendingAuction.get(id);
            if (!p) return;

            adminSessions.delete(from.id);
            q.updatePendingAuctionStatus.run('rejected', id);
            await bot.answerCallbackQuery(query.id, { text: t('admin.pending_auction_alert_rejected') }).catch(() => {});
            await bot.sendMessage(p.user_id, t('admin.pending_auction_rejected'), { parse_mode: 'HTML' }).catch(() => {});
            await sendAdminPanel(bot, chatId, false);
        }

        if (data === 'adm_pen_reject_cancel') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            adminSessions.delete(from.id);
            bot.answerCallbackQuery(query.id, { text: t('admin.pending_auction_reject_cancelled') }).catch(() => {});
            await sendAdminPanel(bot, chatId, false);
        }

        if (data.startsWith('adm_active')) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});

            const page = data.includes(':') ? parseInt(data.split(':')[1]) : 0;
            const auctions = q.getActiveAuctionsPaginated.all(10, page * 10);
            const totalCount = q.countActiveAuctions.get().count;

            if (auctions.length === 0 && page === 0) {
                const noActiveText = t('admin.panel_header') + '\n\n' + t('admin.no_active_auctions');
                const noActiveKb = {
                    inline_keyboard: [[{ text: t('admin.kb.back_to_panel'), callback_data: 'adm_list' }]]
                };
                try {
                    await bot.editMessageText(noActiveText, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'HTML',
                        reply_markup: noActiveKb
                    });
                } catch (e) {
                    await bot.deleteMessage(chatId, messageId).catch(() => {});
                    await bot.sendMessage(chatId, noActiveText, {
                        parse_mode: 'HTML',
                        reply_markup: noActiveKb
                    });
                }
                return;
            }

            const activeHeaderText = t('admin.panel_header') + '\n\n' + t('admin.active_auctions_header');
            const activeHeaderKb = makeAdminActiveKb(auctions, page, totalCount);
            try {
                await bot.editMessageText(activeHeaderText, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML',
                    reply_markup: activeHeaderKb
                });
            } catch (e) {
                await bot.deleteMessage(chatId, messageId).catch(() => {});
                await bot.sendMessage(chatId, activeHeaderText, {
                    parse_mode: 'HTML',
                    reply_markup: activeHeaderKb
                });
            }
        }

        if (data.startsWith('adm_finished')) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});

            const page = data.includes(':') ? parseInt(data.split(':')[1]) : 0;
            const auctions = q.getFinishedAuctionsPaginated.all(10, page * 10);
            const totalCount = q.countFinishedAuctions.get().count;

            if (auctions.length === 0 && page === 0) {
                const noFinishedText = t('admin.panel_header') + '\n\n' + t('admin.no_finished_auctions');
                const noFinishedKb = {
                    inline_keyboard: [[{ text: t('admin.kb.back_to_panel'), callback_data: 'adm_list' }]]
                };
                try {
                    await bot.editMessageText(noFinishedText, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'HTML',
                        reply_markup: noFinishedKb
                    });
                } catch (e) {
                    await bot.deleteMessage(chatId, messageId).catch(() => {});
                    await bot.sendMessage(chatId, noFinishedText, {
                        parse_mode: 'HTML',
                        reply_markup: noFinishedKb
                    });
                }
                return;
            }

            const finishedHeaderText = t('admin.panel_header') + '\n\n' + t('admin.finished_auctions_header');
            const finishedHeaderKb = makeAdminFinishedKb(auctions, page, totalCount);
            try {
                await bot.editMessageText(finishedHeaderText, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML',
                    reply_markup: finishedHeaderKb
                });
            } catch (e) {
                await bot.deleteMessage(chatId, messageId).catch(() => {});
                await bot.sendMessage(chatId, finishedHeaderText, {
                    parse_mode: 'HTML',
                    reply_markup: finishedHeaderKb
                });
            }
        }

        const viewMatch = data.match(/^adm_view:(.+):(.+)$/);
        if (viewMatch) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});

            const targetChatId = Number(viewMatch[1]);
            const targetMsgId = Number(viewMatch[2]);
            const a = q.getAuction.get(targetChatId, targetMsgId);

            if (!a) {
                try {
                    return bot.answerCallbackQuery(query.id, { text: t('bid.not_found'), show_alert: true }).catch(() => {});
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

            const contactLink = formatContactLink(a.admin_contact);

            const text = t('admin.panel_header') + '\n\n' +
                t('admin.auction_details', {
                    title: a.title,
                    chat_id: targetChatId,
                    message_id: targetMsgId,
                    price: a.current_price,
                    status: statusText,
                    end_at: endDate,
                    winner: winner,
                    contact_link: contactLink,
                    link: link
                });

            const kb = makeAdminAuctionActionKb(targetChatId, targetMsgId, a.status);
            try {
                await bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML',
                    reply_markup: kb
                });
            } catch (e) {
                await bot.deleteMessage(chatId, messageId).catch(() => {});
                await bot.sendMessage(chatId, text, {
                    parse_mode: 'HTML',
                    reply_markup: kb
                });
            }
        }

        const restartMatch = data.match(/^adm_restart:(.+):(.+)$/);
        if (restartMatch) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});

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
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});

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
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});

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
                        const adminLink = formatContactLink(nickname);
                        
                        const winnerText = t('scheduler.winner_notify', {
                            link: auctionLink,
                            title: res.auctionTitle,
                            price: res.newPrice,
                            admin_link: adminLink
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
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});

            const targetChatId = Number(deleteMatch[1]);
            const targetMsgId = Number(deleteMatch[2]);
            
            q.deleteAuction.run(targetChatId, targetMsgId);
            
            await bot.sendMessage(chatId, "Аукціон видалено з бази даних.");
            await sendAdminPanel(bot, chatId, true, messageId);
        }
    });

    bot.on('message', async (msg) => {
        if (msg.chat.type !== 'private') return;
        if (msg.text?.startsWith('/')) return;

        const session = adminSessions.get(msg.from.id);
        if (session && session.pending_id) {
            if (!isAdmin(msg.from.id)) {
                adminSessions.delete(msg.from.id);
                return;
            }

            const reason = msg.text;
            const id = session.pending_id;
            const p = q.getPendingAuction.get(id);

            if (p) {
                adminSessions.delete(msg.from.id);
                q.updatePendingAuctionStatus.run('rejected', id);
                
                await bot.sendMessage(msg.chat.id, t('admin.pending_auction_alert_rejected'), { parse_mode: 'HTML' }).catch(() => {});
                await bot.sendMessage(p.user_id, t('admin.pending_auction_rejected_reason', { reason }), { parse_mode: 'HTML' }).catch(() => {});
                await sendAdminPanel(bot, msg.chat.id, false);
            } else {
                adminSessions.delete(msg.from.id);
                await bot.sendMessage(msg.chat.id, "Auction not found.").catch(() => {});
            }
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
            if (e.message.includes('there is no text in the message to edit')) {
                await bot.deleteMessage(chatId, messageId).catch(() => {});
                await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
            } else if (!e.message.includes('message is not modified')) {
                await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
            }
        }
    } else {
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
    }
}
