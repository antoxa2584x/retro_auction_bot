import {q} from '../../services/db.js';
import {
    makeAdminPostAIConfirmKb,
    makeAdminPostAIGenKb,
    makeAdminPostCancelKb,
    makeAdminPostConfirmKb,
    makeAdminPostContactKb,
    makeAdminPostContinuousKb,
    makeAdminPostDurationKb,
    makeAdminPostStepKb,
    makeKb
} from '../../utils/keyboards.js';
import {getChannelId, getContactNickname, TZ} from "../../config/env.js";
import {logError} from '../../services/logger.js';
import {verifyAuctionStored} from '../../services/diagnostics.js';
import {formatInTimeZone} from 'date-fns-tz';
import {addDays, parse, set} from 'date-fns';
import {scheduleClose} from '../../services/scheduler.js';
import {getCurrency, getLocale, t} from '../../services/i18n.js';
import {sendAdminPanel} from './manage.js';
import {calculateImageHash, generateAuctionDetails} from '../../services/openai.js';
import {buildWatermarkedPhoto, WATERMARK_FILE_OPTIONS} from '../../services/watermark.js';
import {
    buildAuctionText,
    deriveTitle,
    getDefaultEndDate,
    sanitizeHtml,
    sendAuctionGallery,
    truncateCaption
} from '../../utils/utils.js';
import fs from 'fs';
import os from 'os';

/** @type {Map<number, {step: string, data: any}>} */
const postSessions = new Map();

/**
 * Registers handlers for posting a new auction.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 */
export function registerPostHandlers(bot) {
    bot.on('callback_query', async (query) => {
        const { data, message, from } = query;
        const chatId = message.chat.id;
        const messageId = message.message_id;

        if (data === 'adm_post') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});
            
            postSessions.set(from.id, { step: 'IMAGE', data: {} });
            await bot.editMessageText(t('admin.post_step_img'), {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                reply_markup: makeAdminPostCancelKb(true)
            });
        }

        if (data === 'post_skip' || data === 'post_continue') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});
            const session = postSessions.get(from.id);
            if (!session) return;

            if (session.step === 'IMAGE' || session.step === 'AI_PROMPT') {
                if (session.data.photo_ids && session.data.photo_ids.length > 0) {
                    session.data.photo_id = session.data.photo_ids[0];
                }
                session.step = 'TITLE';
                await bot.editMessageText(t('admin.post_step_title'), {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML',
                    reply_markup: makeAdminPostCancelKb()
                });
            } else if (session.step === 'DATE') {
                session.data.end_at = session.data.default_date;
                await goToContinuousStep(bot, chatId, session);
            }
        }

        if (data === 'post_cancel') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});
            const cancelledSession = postSessions.get(from.id);
            if (cancelledSession?.media_timer) clearTimeout(cancelledSession.media_timer);
            postSessions.delete(from.id);
            await bot.editMessageText(t('admin.post_cancelled'), {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML'
            });
            await sendAdminPanel(bot, chatId, false);
        }

        if (data === 'post_ai_gen') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            const session = postSessions.get(from.id);
            if (!session || session.step !== 'AI_PROMPT' || !session.data.photo_id) {
                return bot.answerCallbackQuery(query.id, { text: t('common.error_try_again') }).catch(() => {});
            }
            bot.answerCallbackQuery(query.id).catch(() => {});

            const statusMsg = await bot.sendMessage(chatId, t('admin.kb.ai_generating'), { parse_mode: 'HTML' });

            try {
                // Download file to temp
                const tempPath = await bot.downloadFile(session.data.photo_id, os.tmpdir());

                session.data.image_hash = calculateImageHash(tempPath);

                const aiText = sanitizeHtml(await generateAuctionDetails(tempPath, getLocale()));
                
                fs.unlinkSync(tempPath);

                session.data.full_text = aiText;
                session.data.title = deriveTitle(aiText);
                session.step = 'AI_CONFIRM';

                await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
                await bot.sendMessage(chatId, `${t('admin.kb.ai_generated_title')}\n\n<code>${aiText}</code>`, {
                    parse_mode: 'HTML',
                    reply_markup: makeAdminPostAIConfirmKb()
                });
            } catch (e) {
                console.error('AI Gen error:', e);
                const errorKey = e.message === 'OPENAI_API_KEY_NOT_SET' ? 'Set OpenAI API Key in settings first!' : t('common.error_try_again');
                await bot.sendMessage(chatId, `❌ Error: ${errorKey}`, { parse_mode: 'HTML' });
                
                // Re-show manual title input
                session.step = 'TITLE';
                await bot.sendMessage(chatId, t('admin.post_step_title'), {
                    parse_mode: 'HTML',
                    reply_markup: makeAdminPostCancelKb()
                });
            }
        }

        if (data === 'post_ai_confirm') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            const session = postSessions.get(from.id);
            if (!session || session.step !== 'AI_CONFIRM') {
                return bot.answerCallbackQuery(query.id, { text: t('common.error_try_again') }).catch(() => {});
            }
            bot.answerCallbackQuery(query.id).catch(() => {});

            // Save confirmed text for training
            if (session.data.image_hash && session.data.full_text) {
                q.insertAiTrainingData.run(session.data.image_hash, session.data.full_text, getLocale());
            }

            session.step = 'MIN_BID';
            await bot.sendMessage(chatId, t('admin.post_step_min_bid'), {
                parse_mode: 'HTML',
                reply_markup: makeAdminPostCancelKb()
            });
        }

        if (data === 'post_ai_edit') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            const session = postSessions.get(from.id);
            if (!session || session.step !== 'AI_CONFIRM') {
                return bot.answerCallbackQuery(query.id, { text: t('common.error_try_again') }).catch(() => {});
            }
            bot.answerCallbackQuery(query.id).catch(() => {});

            session.step = 'AI_EDIT';
            await bot.sendMessage(chatId, t('admin.kb.ai_edit_prompt'), {
                parse_mode: 'HTML',
                reply_markup: makeAdminPostCancelKb()
            });
        }

        const stepMatch = data.match(/^post_step:(.+)$/);
        if (stepMatch) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});
            const session = postSessions.get(from.id);
            if (!session || session.step !== 'STEP') return;

            const val = stepMatch[1];
            if (val === 'custom') {
                await bot.sendMessage(chatId, t('admin.post_step_step'), {
                    parse_mode: 'HTML',
                    reply_markup: makeAdminPostCancelKb()
                });
            } else {
                session.data.step = parseInt(val);
                await goToDateStep(bot, chatId, session);
            }
        }

        const contactMatch = data.match(/^post_contact:(.+)$/);
        if (contactMatch) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});
            const session = postSessions.get(from.id);
            if (!session || session.step !== 'CONTACT') return;

            const val = contactMatch[1];
            if (val === 'default') {
                session.data.admin_contact = getContactNickname();
                await goToConfirmStep(bot, chatId, session);
            } else {
                session.step = 'CONTACT_MANUAL';
                await bot.editMessageText(t('admin.kb.enter_contact_manually'), {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML',
                    reply_markup: makeAdminPostCancelKb()
                });
            }
        }

        if (data.startsWith('post_dur:')) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});
            const session = postSessions.get(from.id);
            if (!session || session.step !== 'DATE') return;

            const days = parseInt(data.split(':')[1]);
            const defTime = q.getSetting.get('DEFAULT_END_TIME')?.value || '21:00';
            let date = addDays(new Date(), days);
            const [hours, minutes] = defTime.split(':').map(Number);
            date = set(date, { hours, minutes, seconds: 0, milliseconds: 0 });

            session.data.end_at = date;
            await goToContinuousStep(bot, chatId, session);
        }

        if (data.startsWith('post_cont:')) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});
            const session = postSessions.get(from.id);
            if (!session) return;

            session.data.is_continuous = parseInt(data.split(':')[1]);
            session.data.continuous_minutes = parseInt(q.getSetting.get('CONTINUOUS_MINUTES')?.value || '5');
            
            await goToContactStep(bot, chatId, session);
        }

        if (data === 'post_confirm') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});
            const session = postSessions.get(from.id);
            if (!session || session.step !== 'CONFIRM') return;

            // Guard against double-clicks / duplicate callback delivery: a second
            // press would otherwise post the same auction to the channel twice.
            // Claim the session synchronously before any await so a re-entrant
            // call bails out here.
            if (session.posting) return;
            session.posting = true;

            const { data: sessionData } = session;
            const channelId = getChannelId();

            if (!channelId) {
                session.posting = false;
                return bot.sendMessage(chatId, "Channel ID is not set in settings!").catch(() => {});
            }

            let posted = false;
            // Hoisted so the catch below can report which channel message was left
            // orphaned when a step after the send fails.
            let sentMsg = null;
            try {
                const auctionPost = buildAuctionText(sessionData);

                const kb = makeKb(channelId, 0, sessionData.min_bid, 0);
                // The main photo of an admin-posted auction carries the watermark.
                // Gallery photos and user-submitted auctions are left untouched.
                let mainPhotoId = sessionData.photo_id || null;
                if (sessionData.photo_id) {
                    const watermarked = await buildWatermarkedPhoto(bot, sessionData.photo_id);
                    sentMsg = await bot.sendPhoto(channelId, watermarked || sessionData.photo_id, {
                        caption: truncateCaption(auctionPost),
                        parse_mode: 'HTML',
                        reply_markup: kb
                    }, watermarked ? WATERMARK_FILE_OPTIONS : undefined);

                    // Uploading a buffer mints a brand new file_id. Persist that one
                    // rather than the original so every later re-send (restart, winner
                    // DM, /my_bids preview) shows the watermarked image too.
                    if (watermarked) {
                        mainPhotoId = sentMsg.photo?.[sentMsg.photo.length - 1]?.file_id || sessionData.photo_id;
                    }
                } else {
                    sentMsg = await bot.sendMessage(channelId, auctionPost, {
                        parse_mode: 'HTML',
                        reply_markup: kb
                    });
                }

                // Insert the auction row synchronously, immediately after the send
                // and before any further await. This guarantees the record (with
                // the real message_id) exists before Telegram's channel_post
                // update for this same message can be processed, so channelPost.js
                // dedupes instead of racing/double-inserting.
                q.insertAuction.run({
                    chat_id: channelId,
                    message_id: sentMsg.message_id,
                    title: sessionData.title,
                    full_text: auctionPost,
                    photo_id: mainPhotoId,
                    photo_ids: buildPhotoIdsColumn(sessionData.photo_ids, mainPhotoId),
                    min_bid: sessionData.min_bid,
                    step: sessionData.step,
                    current_price: sessionData.min_bid,
                    admin_contact: sessionData.admin_contact || getContactNickname(),
                    end_at: sessionData.end_at.toISOString(),
                    is_continuous: sessionData.is_continuous || 0,
                    continuous_minutes: sessionData.continuous_minutes || 5,
                    creator_id: from.id
                });
                posted = true;

                verifyAuctionStored('admin_post', channelId, sentMsg.message_id, {
                    creator_id: from.id,
                    photo_count: sessionData.photo_ids?.length || (sessionData.photo_id ? 1 : 0)
                });

                // Patch the keyboard with the real message_id. The deep-link bid
                // button encodes it; without this it points at message_id 0 and
                // every bid fails with "auction not found".
                const finalKb = makeKb(channelId, sentMsg.message_id, sessionData.min_bid, 0);
                await bot.editMessageReplyMarkup(finalKb, {
                    chat_id: channelId,
                    message_id: sentMsg.message_id
                }).catch(err => {
                    if (!err.message.includes('message is not modified')) {
                        console.error(`Failed to update keyboard for admin post ${channelId}:${sentMsg.message_id}:`, err.message);
                        // The buttons still encode message_id 0, so every bid on
                        // this post resolves to a lookup for (channel, 0) and
                        // reports "auction not found".
                        logError('auction_keyboard_patch_failed', {
                            source: 'admin_post',
                            chat_id: channelId,
                            message_id: sentMsg.message_id,
                            creator_id: from.id,
                            error: err
                        });
                    }
                });

                if (sessionData.photo_ids && sessionData.photo_ids.length > 1) {
                    const galleryMsgs = await sendAuctionGallery(bot, channelId, sessionData.photo_ids, sentMsg.message_id);
                    if (Array.isArray(galleryMsgs) && galleryMsgs.length > 0) {
                        q.setGalleryMsgIds.run(galleryMsgs.map(m => m.message_id).join(','), channelId, sentMsg.message_id);
                    }
                }

                scheduleClose(bot, channelId, sentMsg.message_id, sessionData.end_at);

                postSessions.delete(from.id);
                await bot.editMessageText(t('admin.post_success'), {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML'
                });
                await sendAdminPanel(bot, chatId, false);
            } catch (e) {
                console.error('Failed to post auction:', e);
                // `posted` only covers the insert. If the send succeeded but the
                // insert (or anything before it) threw, the post is live in the
                // channel with no row behind it — its buttons will report
                // "auction not found" until someone deletes the message.
                logError('auction_post_failed', {
                    source: 'admin_post',
                    creator_id: from.id,
                    channel_id: channelId,
                    channel_message_id: sentMsg?.message_id ?? null,
                    row_inserted: posted,
                    orphaned_channel_post: Boolean(sentMsg) && !posted,
                    error: e
                });
                if (posted) {
                    // Auction is already live in the channel; the failure was in a
                    // follow-up step (gallery / panel). Don't allow a re-post.
                    postSessions.delete(from.id);
                } else {
                    session.posting = false; // nothing posted yet — allow retry
                }
                await bot.sendMessage(chatId, t('common.error_try_again') + ': ' + e.message, { parse_mode: 'HTML' });
            }
        }
    });
}

/**
 * Handles message input for the auction posting wizard.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {Object} msg - Telegram message object.
 * @returns {Promise<boolean>} True if the message was handled.
 */
export async function handlePostInput(bot, msg) {
    const session = postSessions.get(msg.from.id);
    if (!session) return false;

    const text = msg.text;
    const photo = msg.photo;
    const chatId = msg.chat.id;

    switch (session.step) {
        case 'IMAGE':
            if (photo) {
                const fileId = photo[photo.length - 1].file_id;
                const mediaGroupId = msg.media_group_id;
                
                if (!session.data.photo_ids) {
                    session.data.photo_ids = [fileId];
                } else {
                    if (session.data.photo_ids.length >= 11) {
                        // Only send one notification if we exceed the limit
                        if (!session.limit_alert_sent) {
                            session.limit_alert_sent = true;
                            await bot.sendMessage(chatId, t('admin.error_too_many_photos'), { parse_mode: 'HTML' });
                        }
                        return true;
                    }
                    session.data.photo_ids.push(fileId);
                }

                if (mediaGroupId) {
                    if (session.media_timer) clearTimeout(session.media_timer);
                    session.media_timer = setTimeout(async () => {
                        delete session.media_timer;
                        // Session may have been cancelled while the album timer was pending
                        if (postSessions.get(msg.from.id) !== session) return;
                        await showPhotoReceivedOptions(bot, chatId, session);
                    }, 500);
                } else {
                    await showPhotoReceivedOptions(bot, chatId, session);
                }
                return true;
            }
            return false;

        case 'TITLE':
        case 'AI_EDIT':
            if (text) {
                const sanitizedText = sanitizeHtml(text);
                if (sanitizedText.length > 500) {
                    await bot.sendMessage(chatId, t('admin.error_too_long', { length: sanitizedText.length }), { parse_mode: 'HTML' });
                    return true;
                }
                // Save edited text for training if it was an AI edit
                if (session.step === 'AI_EDIT' && session.data.image_hash) {
                    q.insertAiTrainingData.run(session.data.image_hash, sanitizedText, getLocale());
                }

                session.data.full_text = sanitizedText;
                session.data.title = deriveTitle(sanitizedText);
                session.step = 'MIN_BID';
                await bot.sendMessage(chatId, t('admin.post_step_min_bid'), {
                    parse_mode: 'HTML',
                    reply_markup: makeAdminPostCancelKb()
                });
                return true;
            }
            break;

        case 'MIN_BID':
            if (text) {
                if (text.includes('.') || text.includes(',')) {
                    await bot.sendMessage(chatId, t('admin.invalid_number'), { parse_mode: 'HTML' });
                    return true;
                }
                const val = parseInt(text);
                if (isNaN(val) || val < 0) {
                    await bot.sendMessage(chatId, t('admin.invalid_number'), { parse_mode: 'HTML' });
                    return true;
                }
                if (val > Number.MAX_SAFE_INTEGER) {
                    await bot.sendMessage(chatId, t('bid.error_too_high'), { parse_mode: 'HTML' });
                    return true;
                }
                session.data.min_bid = val;
                session.step = 'STEP';
                await bot.sendMessage(chatId, t('admin.post_step_step'), {
                    parse_mode: 'HTML',
                    reply_markup: makeAdminPostStepKb()
                });
                return true;
            }
            break;

        case 'STEP':
            if (text) {
                if (text.includes('.') || text.includes(',')) {
                    await bot.sendMessage(chatId, t('admin.invalid_number'), { parse_mode: 'HTML' });
                    return true;
                }
                const val = parseInt(text);
                if (isNaN(val) || val <= 0) {
                    await bot.sendMessage(chatId, t('admin.invalid_number'), { parse_mode: 'HTML' });
                    return true;
                }
                if (val > Number.MAX_SAFE_INTEGER) {
                    await bot.sendMessage(chatId, t('bid.error_too_high'), { parse_mode: 'HTML' });
                    return true;
                }
                session.data.step = val;
                await goToDateStep(bot, chatId, session);
                return true;
            }
            break;

        case 'DATE':
            if (text) {
                let date;
                // Check if it's a number (days)
                if (/^\d+$/.test(text)) {
                    const days = parseInt(text);
                    const defTime = q.getSetting.get('DEFAULT_END_TIME')?.value || '21:00';
                    date = addDays(new Date(), days);
                    const [hours, minutes] = defTime.split(':').map(Number);
                    date = set(date, { hours, minutes, seconds: 0, milliseconds: 0 });
                } else {
                    try {
                        date = parse(text, 'dd.MM.yyyy HH:mm', new Date());
                        if (isNaN(date.getTime())) throw new Error();
                    } catch (e) {
                        await bot.sendMessage(chatId, t('admin.invalid_date'), { parse_mode: 'HTML' });
                        return true;
                    }
                }
                session.data.end_at = date;
                await goToContinuousStep(bot, chatId, session);
                return true;
            }
            break;

        case 'CONTACT_MANUAL':
            if (text) {
                session.data.admin_contact = text.startsWith('@') ? text : '@' + text;
                await goToConfirmStep(bot, chatId, session);
                return true;
            }
            break;
    }

    return false;
}

/**
 * Builds the comma-separated photo_ids column, swapping in the watermarked
 * file_id for the main photo so a restart reposts the watermarked version while
 * the untouched gallery photos are preserved as-is.
 *
 * @param {string[]|undefined} photoIds - Session photo file_ids (main first).
 * @param {string|null} mainPhotoId - file_id actually posted as the main photo.
 * @returns {string|null} Column value, or null when there are no photos.
 */
function buildPhotoIdsColumn(photoIds, mainPhotoId) {
    if (!photoIds || photoIds.length === 0) return null;
    const ids = [...photoIds];
    if (mainPhotoId) ids[0] = mainPhotoId;
    return ids.join(',');
}

async function showPhotoReceivedOptions(bot, chatId, session) {
    if (session.data.photo_ids.length > 1) {
        await bot.sendMessage(chatId, t('admin.post_photo_added', { count: session.data.photo_ids.length }), {
            reply_markup: makeAdminPostCancelKb(false, false, true)
        });
        return;
    }

    const hasApiKey = !!q.getSetting.get('OPENAI_API_KEY')?.value || !!process.env.OPENAI_API_KEY;
    if (hasApiKey) {
        session.step = 'AI_PROMPT';
        session.data.photo_id = session.data.photo_ids[0]; // For AI gen
        await bot.sendMessage(chatId, t('admin.kb.ai_received'), {
            parse_mode: 'HTML',
            reply_markup: makeAdminPostAIGenKb()
        });
    } else {
        session.step = 'TITLE';
        await bot.sendMessage(chatId, t('admin.post_step_title'), {
            parse_mode: 'HTML',
            reply_markup: makeAdminPostCancelKb()
        });
    }
}

async function goToDateStep(bot, chatId, session) {
    session.step = 'DATE';
    
    // Calculate default date
    const defDate = getDefaultEndDate();
    
    session.data.default_date = defDate;
    const formattedDef = formatInTimeZone(defDate, TZ, 'dd.MM.yyyy HH:mm');

    await bot.sendMessage(chatId, t('admin.post_step_end', { default: formattedDef }), {
        parse_mode: 'HTML',
        reply_markup: makeAdminPostDurationKb()
    });
}

async function goToContinuousStep(bot, chatId, session) {
    session.step = 'CONTINUOUS';
    const min = parseInt(q.getSetting.get('CONTINUOUS_MINUTES')?.value || '5');
    await bot.sendMessage(chatId, t('admin.post_step_continuous', { min }), {
        parse_mode: 'HTML',
        reply_markup: makeAdminPostContinuousKb(min)
    });
}

async function goToContactStep(bot, chatId, session) {
    session.step = 'CONTACT';
    const defaultContact = getContactNickname();
    await bot.sendMessage(chatId, t('admin.post_step_contact', { default: defaultContact }), {
        parse_mode: 'HTML',
        reply_markup: makeAdminPostContactKb()
    });
}

// Special skip for date step
export async function handleDateSkip(bot, chatId, userId) {
    const session = postSessions.get(userId);
    if (!session || session.step !== 'DATE') return false;
    
    session.data.end_at = session.data.default_date;
    await goToContinuousStep(bot, chatId, session);
    return true;
}

async function goToConfirmStep(bot, chatId, session) {
    session.step = 'CONFIRM';
    const { data } = session;
    const text = t('admin.post_confirm', {
        full_text: buildAuctionText(data, false, false),
        min_bid: data.min_bid,
        step: data.step,
        end_at: formatInTimeZone(data.end_at, TZ, 'dd.MM.yyyy HH:mm'),
        continuous: data.is_continuous ? t('admin.continuous_yes', { min: data.continuous_minutes }) : t('admin.continuous_no'),
        contact: data.admin_contact,
        cur: getCurrency()
    });

    await bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: makeAdminPostConfirmKb()
    });
}

function isAdmin(userId) {
    const admin = q.getAdmin.get(userId);
    return admin && admin.otp_code === null;
}
