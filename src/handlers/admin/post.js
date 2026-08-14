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
    makeKb,
    withBackButton
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

/** @type {Map<number, {step: string, data: any, views: string[], viewMsgId: ?number}>} */
const postSessions = new Map();

/**
 * Prompt and keyboard for every screen of the posting wizard, keyed by view name.
 *
 * A view is what the admin sees; `session.step` is what handlePostInput
 * dispatches on. They match except where one step has two screens — STEP offers
 * preset buttons, STEP_CUSTOM asks for a typed amount — so that "back" can
 * return to the preset buttons instead of skipping the whole step.
 *
 * Each entry returns `{ text, kb, step? }` and may prime session.data with
 * whatever the prompt shows (see DATE), which is why a view is re-run rather
 * than cached when the admin navigates back to it.
 *
 * @type {Object<string, function(Object): {text: string, kb: Object, step?: string}>}
 */
const POST_VIEWS = {
    IMAGE: () => ({
        text: t('admin.post_step_img'),
        kb: makeAdminPostCancelKb(true)
    }),
    AI_PROMPT: () => ({
        text: t('admin.kb.ai_received'),
        kb: makeAdminPostAIGenKb()
    }),
    AI_CONFIRM: (session) => ({
        text: `${t('admin.kb.ai_generated_title')}\n\n<code>${session.data.full_text}</code>`,
        kb: makeAdminPostAIConfirmKb()
    }),
    AI_EDIT: () => ({
        text: t('admin.kb.ai_edit_prompt'),
        kb: makeAdminPostCancelKb()
    }),
    TITLE: () => ({
        text: t('admin.post_step_title'),
        kb: makeAdminPostCancelKb()
    }),
    MIN_BID: () => ({
        text: t('admin.post_step_min_bid'),
        kb: makeAdminPostCancelKb()
    }),
    STEP: () => ({
        text: t('admin.post_step_step'),
        kb: makeAdminPostStepKb()
    }),
    STEP_CUSTOM: () => ({
        step: 'STEP',
        text: t('admin.post_step_step'),
        kb: makeAdminPostCancelKb()
    }),
    DATE: (session) => {
        const defDate = getDefaultEndDate();
        session.data.default_date = defDate;
        return {
            text: t('admin.post_step_end', { default: formatInTimeZone(defDate, TZ, 'dd.MM.yyyy HH:mm') }),
            kb: makeAdminPostDurationKb()
        };
    },
    CONTINUOUS: () => {
        const min = parseInt(q.getSetting.get('CONTINUOUS_MINUTES')?.value || '5');
        return {
            text: t('admin.post_step_continuous', { min }),
            kb: makeAdminPostContinuousKb(min)
        };
    },
    CONTACT: () => ({
        text: t('admin.post_step_contact', { default: getContactNickname() }),
        kb: makeAdminPostContactKb()
    }),
    CONTACT_MANUAL: () => ({
        text: t('admin.kb.enter_contact_manually'),
        kb: makeAdminPostCancelKb()
    }),
    CONFIRM: (session) => ({
        text: buildConfirmText(session.data),
        kb: makeAdminPostConfirmKb()
    })
};

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
            
            const session = { step: 'IMAGE', data: {}, views: ['IMAGE'], viewMsgId: null };
            postSessions.set(from.id, session);

            // First step: rendered into the panel message instead of a new one,
            // and with no back button since there is nothing behind it.
            const { text, kb } = POST_VIEWS.IMAGE(session);
            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                reply_markup: kb
            });
            session.viewMsgId = messageId;
        }

        if (data === 'post_back') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});
            const session = postSessions.get(from.id);
            if (!session) return;

            await goBack(bot, chatId, session);
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
                await goToView(bot, chatId, session, 'TITLE');
            } else if (session.step === 'DATE') {
                session.data.end_at = session.data.default_date;
                await goToView(bot, chatId, session, 'CONTINUOUS');
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

                await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
                await goToView(bot, chatId, session, 'AI_CONFIRM');
            } catch (e) {
                console.error('AI Gen error:', e);
                const errorKey = e.message === 'OPENAI_API_KEY_NOT_SET' ? 'Set OpenAI API Key in settings first!' : t('common.error_try_again');
                await bot.sendMessage(chatId, `❌ Error: ${errorKey}`, { parse_mode: 'HTML' });

                // Re-show manual title input
                await goToView(bot, chatId, session, 'TITLE');
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

            await goToView(bot, chatId, session, 'MIN_BID');
        }

        if (data === 'post_ai_edit') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            const session = postSessions.get(from.id);
            if (!session || session.step !== 'AI_CONFIRM') {
                return bot.answerCallbackQuery(query.id, { text: t('common.error_try_again') }).catch(() => {});
            }
            bot.answerCallbackQuery(query.id).catch(() => {});

            await goToView(bot, chatId, session, 'AI_EDIT');
        }

        const stepMatch = data.match(/^post_step:(.+)$/);
        if (stepMatch) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});
            const session = postSessions.get(from.id);
            if (!session || session.step !== 'STEP') return;

            const val = stepMatch[1];
            if (val === 'custom') {
                await goToView(bot, chatId, session, 'STEP_CUSTOM');
            } else {
                session.data.step = parseInt(val);
                await goToView(bot, chatId, session, 'DATE');
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
                await goToView(bot, chatId, session, 'CONFIRM');
            } else {
                await goToView(bot, chatId, session, 'CONTACT_MANUAL');
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
            await goToView(bot, chatId, session, 'CONTINUOUS');
        }

        if (data.startsWith('post_cont:')) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});
            const session = postSessions.get(from.id);
            if (!session) return;

            session.data.is_continuous = parseInt(data.split(':')[1]);
            session.data.continuous_minutes = parseInt(q.getSetting.get('CONTINUOUS_MINUTES')?.value || '5');

            await goToView(bot, chatId, session, 'CONTACT');
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
                await goToView(bot, chatId, session, 'MIN_BID');
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
                await goToView(bot, chatId, session, 'STEP');
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
                await goToView(bot, chatId, session, 'DATE');
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
                await goToView(bot, chatId, session, 'CONTINUOUS');
                return true;
            }
            break;

        case 'CONTACT_MANUAL':
            if (text) {
                session.data.admin_contact = text.startsWith('@') ? text : '@' + text;
                await goToView(bot, chatId, session, 'CONFIRM');
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
        // Still on the IMAGE step — this only offers to move on, so it replaces
        // the step's live keyboard rather than opening a new view.
        await clearActiveKeyboard(bot, chatId, session);
        const sent = await bot.sendMessage(chatId, t('admin.post_photo_added', { count: session.data.photo_ids.length }), {
            reply_markup: makeAdminPostCancelKb(false, false, true)
        });
        session.viewMsgId = sent.message_id;
        return;
    }

    const hasApiKey = !!q.getSetting.get('OPENAI_API_KEY')?.value || !!process.env.OPENAI_API_KEY;
    if (hasApiKey) {
        session.data.photo_id = session.data.photo_ids[0]; // For AI gen
        await goToView(bot, chatId, session, 'AI_PROMPT');
    } else {
        await goToView(bot, chatId, session, 'TITLE');
    }
}

// Special skip for date step
export async function handleDateSkip(bot, chatId, userId) {
    const session = postSessions.get(userId);
    if (!session || session.step !== 'DATE') return false;

    session.data.end_at = session.data.default_date;
    await goToView(bot, chatId, session, 'CONTINUOUS');
    return true;
}

function buildConfirmText(data) {
    return t('admin.post_confirm', {
        full_text: buildAuctionText(data, false, false),
        min_bid: data.min_bid,
        step: data.step,
        end_at: formatInTimeZone(data.end_at, TZ, 'dd.MM.yyyy HH:mm'),
        continuous: data.is_continuous ? t('admin.continuous_yes', { min: data.continuous_minutes }) : t('admin.continuous_no'),
        contact: data.admin_contact,
        cur: getCurrency()
    });
}

/**
 * Advances the wizard to `view`, pushing it onto the session's view stack so
 * `post_back` knows where to return to.
 *
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} chatId - Chat to prompt in.
 * @param {Object} session - Posting session.
 * @param {string} view - Key of POST_VIEWS to render.
 */
async function goToView(bot, chatId, session, view) {
    session.views.push(view);
    await renderView(bot, chatId, session);
}

/**
 * Steps back to the previous view. Nothing happens on the first step, which has
 * no back button anyway.
 *
 * @returns {Promise<boolean>} Whether the wizard actually moved.
 */
async function goBack(bot, chatId, session) {
    if (session.views.length < 2) return false;
    session.views.pop();

    // Returning to the photo step starts the album over: appending to the old
    // list would keep the very photo the admin came back to replace.
    if (session.views[session.views.length - 1] === 'IMAGE') {
        delete session.data.photo_ids;
        delete session.data.photo_id;
        delete session.limit_alert_sent;
    }

    await renderView(bot, chatId, session);
    return true;
}

/**
 * Sends the prompt for the view currently on top of the stack and remembers its
 * message id, so the next transition can retire that keyboard.
 */
async function renderView(bot, chatId, session) {
    await clearActiveKeyboard(bot, chatId, session);

    const view = session.views[session.views.length - 1];
    const { text, kb, step = view } = POST_VIEWS[view](session);
    session.step = step;

    const sent = await bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: session.views.length > 1 ? withBackButton(kb, 'post_back') : kb
    });
    session.viewMsgId = sent.message_id;
}

/**
 * Strips the keyboard off the prompt the wizard is currently showing.
 *
 * Every step used to leave its buttons live, which was harmless while the
 * wizard only moved forward. With a back button they would let the admin answer
 * a step they have already left and desync the view stack, so the outgoing
 * prompt is retired on each transition.
 */
async function clearActiveKeyboard(bot, chatId, session) {
    const msgId = session.viewMsgId;
    if (!msgId) return;
    session.viewMsgId = null;
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: chatId,
        message_id: msgId
    }).catch(() => {});
}

function isAdmin(userId) {
    const admin = q.getAdmin.get(userId);
    return admin && admin.otp_code === null;
}
