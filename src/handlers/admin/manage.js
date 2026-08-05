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
    makeAdminPendingRejectKb,
    REJECT_REASONS
} from '../../utils/keyboards.js';
import { getChannelId, TZ, getContactNickname } from "../../config/env.js";
import { logError, logWarn } from '../../services/logger.js';
import { verifyAuctionStored } from '../../services/diagnostics.js';
import { formatInTimeZone } from 'date-fns-tz';
import { scheduleClose, closeAuction, cancelAuctionJobs } from '../../services/scheduler.js';
import { 
    getAuctionLink, 
    formatUserLink, 
    formatUserLinkById,
    formatContactLink, 
    buildAuctionText,
    sendAuctionGallery,
    safeEditMessage,
    stripHtml,
    truncateCaption,
    setStatusTag
} from '../../utils/utils.js';
import { t, getCurrency } from '../../services/i18n.js';
import { reconstructAuctionText } from '../../utils/parse.js';

function isAdmin(userId) {
    const admin = q.getAdmin.get(userId);
    return admin && admin.otp_code === null;
}

/** @type {Map<number, {pending_id: string, gallery_msg_ids: number[]}>} */
const adminSessions = new Map();

/**
 * Cleanup gallery if exists for the user.
 * 
 * @param {TelegramBot} bot 
 * @param {number} chatId 
 * @param {number} userId 
 */
async function cleanupGallery(bot, chatId, userId) {
    const session = adminSessions.get(userId);
    if (session?.gallery_msg_ids) {
        for (const msgId of session.gallery_msg_ids) {
            await bot.deleteMessage(chatId, msgId).catch(() => {});
        }
        session.gallery_msg_ids = [];
    }
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

        if (data.startsWith('adm_res_approve:')) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            
            const parts = data.split(':');
            const targetUserId = Number(parts[1]);
            const targetChatId = Number(parts[2]);
            const targetMsgId = Number(parts[3]);

            const a = q.getAuction.get(targetChatId, targetMsgId);
            if (!a) return bot.answerCallbackQuery(query.id, { text: t('bid.not_found'), show_alert: true });

            // Atomically claim this restart request. If another admin already
            // approved or rejected it, the claim fails and we bail out so the
            // auction isn't posted to the channel twice.
            if (q.claimRestart.run(targetChatId, targetMsgId).changes === 0) {
                await bot.answerCallbackQuery(query.id, { text: t('admin.restart_already_handled'), show_alert: true }).catch(() => {});
                await bot.editMessageText(t('admin.restart_already_handled'), {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML'
                }).catch(() => {});
                return;
            }

            await bot.answerCallbackQuery(query.id).catch(() => {});

            let minBid = a.min_bid;
            let step = a.step;
            let durationDays = 4;
            let endHour = new Date(a.end_at).getHours();

            if (parts.length >= 8) {
                minBid = Number(parts[4]);
                step = Number(parts[5]);
                durationDays = Number(parts[6]);
                endHour = Number(parts[7]);
            }

            const newEnd = new Date();
            newEnd.setDate(newEnd.getDate() + durationDays);
            newEnd.setHours(endHour, 0, 0, 0);

            const updatedFullText = reconstructAuctionText(a.full_text, {
                min_bid: minBid,
                step: step,
                end_at: newEnd.toISOString(),
                is_continuous: a.is_continuous,
                continuous_minutes: a.continuous_minutes
            });

            // All photos of the auction (main + additional). Fall back to the
            // single main photo_id for auctions posted before photo_ids was tracked.
            const photoIds = a.photo_ids ? a.photo_ids.split(',') : (a.photo_id ? [a.photo_id] : []);

            try {
                let newMsg;
                const kb = makeKb(targetChatId, 0, minBid, 0);
                if (a.photo_id) {
                    newMsg = await bot.sendPhoto(targetChatId, a.photo_id, {
                        caption: truncateCaption(updatedFullText),
                        parse_mode: 'HTML',
                        reply_markup: kb
                    });
                } else {
                    newMsg = await bot.sendMessage(targetChatId, updatedFullText, {
                        parse_mode: 'HTML',
                        reply_markup: kb
                    });
                }

                // Insert synchronously right after the send (before any further
                // await) so the row with the real message_id exists before the
                // channel_post update for this message can race in.
                q.insertAuction.run({
                    chat_id: targetChatId,
                    message_id: newMsg.message_id,
                    title: a.title,
                    full_text: updatedFullText,
                    photo_id: a.photo_id,
                    photo_ids: a.photo_ids || null,
                    min_bid: minBid,
                    step: step,
                    current_price: minBid,
                    admin_contact: a.admin_contact,
                    end_at: newEnd.toISOString(),
                    is_continuous: a.is_continuous,
                    continuous_minutes: a.continuous_minutes,
                    creator_id: a.creator_id
                });

                verifyAuctionStored('restart_request_approval', targetChatId, newMsg.message_id, {
                    creator_id: a.creator_id,
                    approved_by: from.id,
                    replaced_message_id: targetMsgId
                });

                // Patch the keyboard with the real message_id so the deep-link bid
                // button resolves instead of pointing at message_id 0.
                const finalKb = makeKb(targetChatId, newMsg.message_id, minBid, 0);
                await bot.editMessageReplyMarkup(finalKb, {
                    chat_id: targetChatId,
                    message_id: newMsg.message_id
                }).catch(err => {
                    if (!err.message.includes('message is not modified')) {
                        // Buttons keep message_id 0 → bids report "not found".
                        logError('auction_keyboard_patch_failed', {
                            source: 'restart_request_approval',
                            chat_id: targetChatId,
                            message_id: newMsg.message_id,
                            error: err
                        });
                    }
                });

                // Repost the additional photos as a gallery under the new post and
                // remember their message_ids so a future restart can clean them up.
                if (photoIds.length > 1) {
                    try {
                        const galleryMsgs = await sendAuctionGallery(bot, targetChatId, photoIds, newMsg.message_id);
                        if (Array.isArray(galleryMsgs) && galleryMsgs.length > 0) {
                            q.setGalleryMsgIds.run(galleryMsgs.map(m => m.message_id).join(','), targetChatId, newMsg.message_id);
                        }
                    } catch (e) {
                        console.error('Failed to repost gallery on restart approval:', e.message);
                    }
                }

                // Remove the old finished post and its old gallery so only the
                // freshly reposted auction remains in the channel.
                await bot.deleteMessage(targetChatId, targetMsgId).catch(() => {});
                if (a.gallery_msg_ids) {
                    for (const oldMsgId of a.gallery_msg_ids.split(',')) {
                        await bot.deleteMessage(targetChatId, Number(oldMsgId)).catch(() => {});
                    }
                }
                // The old row is keyed by the deleted message_id — drop it so it no
                // longer surfaces in admin lists or scheduler scans.
                q.deleteAuction.run(targetChatId, targetMsgId);

                scheduleClose(bot, targetChatId, newMsg.message_id, newEnd);

                const successDate = formatInTimeZone(newEnd, TZ, 'dd.MM.yyyy HH:mm');
                await bot.editMessageText(t('admin.post_restart_approved', { title: a.title, date: successDate }), {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML'
                }).catch(() => {});

                await bot.sendMessage(targetUserId, t('admin.post_restart_approved', { title: a.title, date: successDate }), { parse_mode: 'HTML' }).catch(() => {});
            } catch (e) {
                // Posting the restart failed — release the claim so it can be retried.
                console.error('Error approving auction restart:', e.message);
                q.releaseRestart.run(targetChatId, targetMsgId);
                await bot.answerCallbackQuery(query.id, { text: t('common.error_try_again'), show_alert: true }).catch(() => {});
            }
        }

        if (data.startsWith('adm_res_reject:')) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            
            const [, userIdParam, targetChatIdParam, targetMsgIdParam] = data.split(':');
            const targetUserId = Number(userIdParam);
            const targetChatId = Number(targetChatIdParam);
            const targetMsgId = Number(targetMsgIdParam);

            const a = q.getAuction.get(targetChatId, targetMsgId);
            const title = a?.title || '';

            // Claim the request so it can't also be approved/rejected by another admin.
            if (a && q.claimRestart.run(targetChatId, targetMsgId).changes === 0) {
                await bot.answerCallbackQuery(query.id, { text: t('admin.restart_already_handled'), show_alert: true }).catch(() => {});
                await bot.editMessageText(t('admin.restart_already_handled'), {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML'
                }).catch(() => {});
                return;
            }

            await bot.answerCallbackQuery(query.id).catch(() => {});

            await bot.editMessageText(t('admin.post_restart_rejected', { title }), {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML'
            }).catch(() => {});

            await bot.sendMessage(targetUserId, t('admin.post_restart_rejected', { title }), { parse_mode: 'HTML' }).catch(() => {});
        }

        if (data === 'adm_list') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});

            // Cleanup gallery if exists
            await cleanupGallery(bot, chatId, from.id);
            adminSessions.delete(from.id);

            // Always delete if previous message had a photo, ensuring text-only panel
            const isPhoto = !!message.photo;
            await sendAdminPanel(bot, chatId, !isPhoto, messageId);
        }

        if (data === 'adm_pending') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});

            // Cleanup gallery if exists
            await cleanupGallery(bot, chatId, from.id);
            adminSessions.delete(from.id);

            const pending = q.getPendingAuctions.all();
            if (pending.length === 0) {
                const noPendingText = t('admin.no_pending_auctions') || "No pending auctions.";
                const noPendingKb = makeAdminPanelKb();
                
                // If previous message was photo, delete it to keep list text-only
                if (message.photo) {
                    await bot.deleteMessage(chatId, messageId).catch(() => {});
                    return await bot.sendMessage(chatId, noPendingText, {
                        parse_mode: 'HTML',
                        reply_markup: noPendingKb
                    });
                }

                try {
                    return await safeEditMessage(bot, chatId, messageId, noPendingText, {
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

            // If previous message was photo, delete it to keep list text-only
            if (message.photo) {
                await bot.deleteMessage(chatId, messageId).catch(() => {});
                return await bot.sendMessage(chatId, pendingHeader, {
                    parse_mode: 'HTML',
                    reply_markup: pendingKb
                });
            }

            try {
                await safeEditMessage(bot, chatId, messageId, pendingHeader, {
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

            const userContact = formatUserLinkById(p.user_id);
            const headerText = t('admin.pending_auction_view_header', { contact: userContact });

            const text = headerText + '\n\n' + buildAuctionText(p, true, false);

            const photoIds = p.photo_ids ? p.photo_ids.split(',') : [];
            if (photoIds.length > 0) {
                // If it's already a photo message with caption, we might want to update it
                // But adm_pen_view: usually sends a NEW message with the photo.
                // If we are coming from 'adm_pending' list, we are editing the message.
                try {
                    await bot.deleteMessage(chatId, messageId).catch(() => {});
                } catch (e) {}
                
                const sentMsg = await bot.sendPhoto(chatId, photoIds[0], {
                    caption: truncateCaption(text),
                    parse_mode: 'HTML',
                    reply_markup: makeAdminPendingViewKb(id)
                });

                if (photoIds.length > 1) {
                    const galleryMsgs = await sendAuctionGallery(bot, chatId, photoIds, sentMsg.message_id);
                    if (galleryMsgs && Array.isArray(galleryMsgs)) {
                        adminSessions.set(from.id, { 
                            ...adminSessions.get(from.id),
                            gallery_msg_ids: galleryMsgs.map(m => m.message_id)
                        });
                    }
                }
            } else {
                try {
                    await safeEditMessage(bot, chatId, messageId, text, {
                        parse_mode: 'HTML',
                        reply_markup: makeAdminPendingViewKb(id)
                    });
                } catch (e) {
                    await bot.sendMessage(chatId, text, {
                        parse_mode: 'HTML',
                        reply_markup: makeAdminPendingViewKb(id)
                    });
                }
            }
        }

        if (data.startsWith('adm_pen_approve:')) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            const id = data.split(':')[1];
            const p = q.getPendingAuction.get(id);
            if (!p) return bot.answerCallbackQuery(query.id, { text: "Not found." }).catch(() => {});

            // Idempotency guard: claim the pending auction synchronously, before
            // any await. A rapid second click (or duplicate callback delivery)
            // would otherwise re-read it as still 'pending' and post the auction
            // to the channel twice.
            if (p.status !== 'pending') {
                return bot.answerCallbackQuery(query.id, { text: t('admin.pending_auction_alert_approved') }).catch(() => {});
            }
            q.updatePendingAuctionStatus.run('approved', id);

            // Cleanup gallery if exists
            await cleanupGallery(bot, chatId, from.id);
            adminSessions.delete(from.id);

            let posted = false;
            // Hoisted so the catch below can report which channel message was left
            // orphaned when a step after the send fails.
            let sentMsg = null;
            try {
                const channelId = getChannelId();
                const auctionPost = buildAuctionText(p);

                const kb = makeKb(channelId, 0, p.min_bid, 0);
                const photoIds = p.photo_ids ? p.photo_ids.split(',') : [];

                if (photoIds.length > 0) {
                    sentMsg = await bot.sendPhoto(channelId, photoIds[0], {
                        caption: truncateCaption(auctionPost),
                        parse_mode: 'HTML',
                        reply_markup: kb
                    });
                } else {
                    sentMsg = await bot.sendMessage(channelId, auctionPost, {
                        parse_mode: 'HTML',
                        reply_markup: kb
                    });
                }

                // Insert synchronously right after the send (before any further
                // await) so the row with the real message_id exists before
                // Telegram's channel_post update for this message can race in.
                q.insertAuction.run({
                    chat_id: channelId,
                    message_id: sentMsg.message_id,
                    title: p.title,
                    full_text: auctionPost,
                    photo_id: photoIds[0] || null,
                    photo_ids: photoIds.length > 0 ? photoIds.join(',') : null,
                    min_bid: p.min_bid,
                    step: p.step,
                    current_price: p.min_bid,
                    admin_contact: p.user_id ? `tg://user?id=${p.user_id}` : getContactNickname(),
                    end_at: new Date(p.end_at).toISOString(),
                    is_continuous: p.is_continuous,
                    continuous_minutes: p.continuous_minutes,
                    creator_id: p.user_id
                });
                posted = true;

                verifyAuctionStored('pending_approval', channelId, sentMsg.message_id, {
                    pending_id: Number(id),
                    creator_id: p.user_id,
                    approved_by: from.id,
                    photo_count: photoIds.length
                });

                // Patch the keyboard with the real message_id so the deep-link bid
                // button resolves (otherwise it points at message_id 0 → bids fail
                // with "auction not found").
                const finalKb = makeKb(channelId, sentMsg.message_id, p.min_bid, 0);
                await bot.editMessageReplyMarkup(finalKb, {
                    chat_id: channelId,
                    message_id: sentMsg.message_id
                }).catch(err => {
                    if (!err.message.includes('message is not modified')) {
                        console.error(`Failed to update keyboard after approval:`, err.message);
                        // The buttons still encode message_id 0, so every bid on
                        // this post resolves to a lookup for (channel, 0) and
                        // reports "auction not found".
                        logError('auction_keyboard_patch_failed', {
                            source: 'pending_approval',
                            chat_id: channelId,
                            message_id: sentMsg.message_id,
                            pending_id: Number(id),
                            error: err
                        });
                    }
                });

                if (photoIds.length > 1) {
                    const galleryMsgs = await sendAuctionGallery(bot, channelId, photoIds, sentMsg.message_id);
                    if (Array.isArray(galleryMsgs) && galleryMsgs.length > 0) {
                        q.setGalleryMsgIds.run(galleryMsgs.map(m => m.message_id).join(','), channelId, sentMsg.message_id);
                    }
                }

                scheduleClose(bot, channelId, sentMsg.message_id, new Date(p.end_at));

                await bot.answerCallbackQuery(query.id, { text: t('admin.pending_auction_alert_approved') }).catch(() => {});
                await bot.sendMessage(p.user_id, t('admin.pending_auction_approved')).catch(() => {});
                await sendAdminPanel(bot, chatId, false);
            } catch (e) {
                console.error(e);
                // `posted` only covers the insert. If the send succeeded but the
                // insert (or anything before it) threw, the post is live in the
                // channel with no row behind it — its buttons will report
                // "auction not found" until someone deletes the message.
                logError('auction_post_failed', {
                    source: 'pending_approval',
                    pending_id: Number(id),
                    creator_id: p.user_id,
                    channel_message_id: sentMsg?.message_id ?? null,
                    row_inserted: posted,
                    orphaned_channel_post: Boolean(sentMsg) && !posted,
                    error: e
                });
                // Roll the claim back only if nothing was actually posted, so the
                // admin can retry. If the post already landed, leave it 'approved'
                // to avoid a duplicate on retry.
                if (!posted) q.updatePendingAuctionStatus.run('pending', id);
                await bot.answerCallbackQuery(query.id, { text: "Error: " + e.message }).catch(() => {});
            }
        }

        if (data.startsWith('adm_pen_reject:')) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            const id = data.split(':')[1];
            const p = q.getPendingAuction.get(id);
            if (!p) return bot.answerCallbackQuery(query.id, { text: "Not found." }).catch(() => {});

            bot.answerCallbackQuery(query.id).catch(() => {});
            
            // Cleanup gallery if exists
            await cleanupGallery(bot, chatId, from.id);
            adminSessions.set(from.id, { pending_id: id });

            // Older rows may have a title built from truncated raw HTML (e.g. a
            // dangling "<b>"); strip tags so the prompt's own <b> wrapper stays valid.
            const text = t('admin.pending_auction_reject_prompt', { title: stripHtml(p.title) });
            await safeEditMessage(bot, chatId, messageId, text, {
                parse_mode: 'HTML',
                reply_markup: makeAdminPendingRejectKb(id)
            });
        }

        if (data.startsWith('adm_pen_reject_confirm:')) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            const id = data.split(':')[1];
            const p = q.getPendingAuction.get(id);
            if (!p) return;

            await cleanupGallery(bot, chatId, from.id);
            adminSessions.delete(from.id);
            q.updatePendingAuctionStatus.run('rejected', id);
            await bot.answerCallbackQuery(query.id, { text: t('admin.pending_auction_alert_rejected') }).catch(() => {});
            await bot.sendMessage(p.user_id, t('admin.pending_auction_rejected'), { parse_mode: 'HTML' }).catch(() => {});
            await sendAdminPanel(bot, chatId, false);
        }

        if (data.startsWith('adm_pen_reject_reason:')) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            const [, id, indexStr] = data.split(':');
            const p = q.getPendingAuction.get(id);
            if (!p) return bot.answerCallbackQuery(query.id, { text: "Not found." }).catch(() => {});

            // The callback carries a 1-based index into the predefined reasons.
            const preset = REJECT_REASONS[Number(indexStr) - 1];
            if (!preset) return bot.answerCallbackQuery(query.id, { text: t('common.error_try_again'), show_alert: true }).catch(() => {});

            // Short label as the reason line, plus the optional how-to-fix note.
            let notification = t('admin.pending_auction_rejected_reason', { reason: t(preset.label) });
            if (preset.details) notification += '\n\n' + t(preset.details);
            // "Read the rules" is only actionable with the link, and the link is
            // optional in settings — skip the line when it isn't configured.
            const rulesLink = preset.showRules ? q.getSetting.get('RULES_LINK')?.value : null;
            if (rulesLink) notification += '\n\n' + t('admin.pending_auction_reject_rules_link', { link: rulesLink });

            await cleanupGallery(bot, chatId, from.id);
            adminSessions.delete(from.id);
            q.updatePendingAuctionStatus.run('rejected', id);
            await bot.answerCallbackQuery(query.id, { text: t('admin.pending_auction_alert_rejected') }).catch(() => {});
            await bot.sendMessage(p.user_id, notification, { parse_mode: 'HTML' }).catch(() => {});
            await sendAdminPanel(bot, chatId, false);
        }

        if (data === 'adm_pen_reject_cancel') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            await cleanupGallery(bot, chatId, from.id);
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
                    await safeEditMessage(bot, chatId, messageId, noActiveText, {
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
                await safeEditMessage(bot, chatId, messageId, activeHeaderText, {
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
                    await safeEditMessage(bot, chatId, messageId, noFinishedText, {
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
                await safeEditMessage(bot, chatId, messageId, finishedHeaderText, {
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

            const currentBidText = q.getSetting.get('AUCTION_CURRENT_BID_TEXT')?.value || t('bid.current_bid_label');
            const priceLabel = a.leader_id ? currentBidText : t('admin.auction_min_bid_text').replace(/^(🔸|💰)\s*/, '');

            const text = t('admin.panel_header') + '\n\n' +
                t('admin.auction_details', {
                    title: a.title,
                    chat_id: targetChatId,
                    message_id: targetMsgId,
                    price: `${a.current_price} (${priceLabel})`,
                    status: statusText,
                    end_at: endDate,
                    winner: winner,
                    contact_link: contactLink,
                    link: link
                });

            const kb = makeAdminAuctionActionKb(targetChatId, targetMsgId, a.status);
            try {
                await safeEditMessage(bot, chatId, messageId, text, {
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

            // Atomically claim this auction so two admins can't restart it twice.
            if (q.claimRestart.run(targetChatId, targetMsgId).changes === 0) {
                return bot.answerCallbackQuery(query.id, { text: t('admin.restart_already_handled'), show_alert: true }).catch(() => {});
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

            // Restart makes the auction active again — retag the header
            // (#завершений → #активний) to match the new state. setStatusTag drops
            // any existing tags first, so a post carrying a stray tag from an older
            // restart ends up with a single #активний instead of two.
            updatedFullText = setStatusTag(updatedFullText, 'active');

            // All photos of the auction (main + additional). Fall back to the
            // single main photo_id for auctions posted before photo_ids was tracked.
            const photoIds = a.photo_ids ? a.photo_ids.split(',') : (a.photo_id ? [a.photo_id] : []);

            let restartOk = false;
            try {
                let newMsg;
                try {
                    const kb = makeKb(targetChatId, 0, a.min_bid, 0);
                    if (a.photo_id) {
                        newMsg = await bot.sendPhoto(targetChatId, a.photo_id, {
                            caption: truncateCaption(updatedFullText),
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

                // Insert synchronously right after the send (before any further
                // await) so the row with the real message_id exists before the
                // channel_post update for this message can race in.
                q.insertAuction.run({
                    chat_id: targetChatId,
                    message_id: newMsg.message_id,
                    title: a.title,
                    full_text: updatedFullText,
                    photo_id: a.photo_id,
                    photo_ids: a.photo_ids || null,
                    min_bid: a.min_bid,
                    step: a.step,
                    current_price: a.min_bid,
                    admin_contact: a.admin_contact,
                    end_at: newEnd.toISOString(),
                    is_continuous: a.is_continuous,
                    continuous_minutes: a.continuous_minutes,
                    creator_id: a.creator_id
                });

                verifyAuctionStored('admin_restart', targetChatId, newMsg.message_id, {
                    creator_id: a.creator_id,
                    restarted_by: from.id,
                    replaced_message_id: targetMsgId
                });

                // Patch the keyboard with the real message_id so the deep-link bid
                // button resolves instead of pointing at message_id 0.
                try {
                    const finalKb = makeKb(targetChatId, newMsg.message_id, a.min_bid, 0);
                    await bot.editMessageReplyMarkup(finalKb, {
                        chat_id: targetChatId,
                        message_id: newMsg.message_id
                    });
                } catch (e) {
                    console.error('Failed to update new post keyboard:', e.message);
                    // Buttons keep message_id 0 → bids report "not found".
                    logError('auction_keyboard_patch_failed', {
                        source: 'admin_restart',
                        chat_id: targetChatId,
                        message_id: newMsg.message_id,
                        error: e
                    });
                }

                // Repost the additional photos as a gallery under the new post and
                // remember their message_ids so a future restart can clean them up.
                if (photoIds.length > 1) {
                    try {
                        const galleryMsgs = await sendAuctionGallery(bot, targetChatId, photoIds, newMsg.message_id);
                        if (Array.isArray(galleryMsgs) && galleryMsgs.length > 0) {
                            q.setGalleryMsgIds.run(galleryMsgs.map(m => m.message_id).join(','), targetChatId, newMsg.message_id);
                        }
                    } catch (e) {
                        console.error('Failed to repost gallery on restart:', e.message);
                    }
                }

                // Remove the old finished post and its old gallery so only the
                // freshly reposted auction remains in the channel.
                await bot.deleteMessage(targetChatId, targetMsgId).catch(() => {});
                if (a.gallery_msg_ids) {
                    for (const oldMsgId of a.gallery_msg_ids.split(',')) {
                        await bot.deleteMessage(targetChatId, Number(oldMsgId)).catch(() => {});
                    }
                }
                // The old row is keyed by the deleted message_id — drop it so it no
                // longer surfaces in admin lists or scheduler scans.
                q.deleteAuction.run(targetChatId, targetMsgId);

                scheduleClose(bot, targetChatId, newMsg.message_id, newEnd);

                await bot.sendMessage(chatId, t('admin.restart_success', {
                    title: a.title,
                    date: formatInTimeZone(newEnd, TZ, 'dd.MM.yyyy HH:mm')
                }), { parse_mode: 'HTML' });
                await sendAdminPanel(bot, chatId, true, messageId);
                restartOk = true;
            } finally {
                // Release the claim if the restart didn't complete, so it can be retried.
                if (!restartOk) q.releaseRestart.run(targetChatId, targetMsgId);
            }
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

            await closeAuction(bot, targetChatId, targetMsgId, true);

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
                                await bot.sendPhoto(res.newLeaderId, a.photo_id, { caption: truncateCaption(winnerText), parse_mode: 'HTML' });
                            } else {
                                await bot.sendMessage(res.newLeaderId, truncateCaption(winnerText), { parse_mode: 'HTML' });
                            }
                        } catch (err) {
                            console.error(`Failed to notify new winner ${res.newLeaderId}:`, err.message);
                        }
                    } else {
                        newKb = makeEmptyFinishKb();
                    }
                }
                await bot.editMessageReplyMarkup(newKb, { chat_id: targetChatId, message_id: targetMsgId }).catch(async (err) => {
                    if (err.message.includes('BUTTON_USER_PRIVACY_RESTRICTED')) {
                        const fallbackKb = winnerKeyboard(res.newLeaderId, res.newLeaderName, res.newPrice, false);
                        await bot.editMessageReplyMarkup(fallbackKb, { chat_id: targetChatId, message_id: targetMsgId }).catch(e => {
                            console.error(`Failed to update fallback winner keyboard after undo bid:`, e.message);
                        });
                    } else if (!err.message.includes('message is not modified')) {
                        throw err;
                    }
                });
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

            // Only the row goes away; the channel post stays up. Its buttons will
            // report "auction not found" from here on, so record who dropped it.
            const deleted = q.deleteAuction.run(targetChatId, targetMsgId).changes;
            logWarn('auction_row_deleted', {
                source: 'admin_delete',
                chat_id: targetChatId,
                message_id: targetMsgId,
                deleted_by: from.id,
                rows_deleted: deleted
            });
            cancelAuctionJobs(targetChatId, targetMsgId);

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
                await cleanupGallery(bot, msg.chat.id, msg.from.id);
                adminSessions.delete(msg.from.id);
                q.updatePendingAuctionStatus.run('rejected', id);
                
                await bot.sendMessage(msg.chat.id, t('admin.pending_auction_alert_rejected'), { parse_mode: 'HTML' }).catch(() => {});
                await bot.sendMessage(p.user_id, t('admin.pending_auction_rejected_reason', { reason }), { parse_mode: 'HTML' }).catch(() => {});
                await sendAdminPanel(bot, msg.chat.id, false);
            } else {
                await cleanupGallery(bot, msg.chat.id, msg.from.id);
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
            await safeEditMessage(bot, chatId, messageId, text, { parse_mode: 'HTML', reply_markup: kb });
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
