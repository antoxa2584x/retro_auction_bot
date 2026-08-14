import { q } from '../../services/db.js';
import { 
    makeAdminPostCancelKb, 
    makeUserPostStepKb,
    makeUserPostContinuousKb,
    makeUserPostConfirmKb,
    makeUserRulesKb,
    makeUserPostDurationKb,
    makeUserPostTimeKb,
    withBackButton
} from '../../utils/keyboards.js';
import { TZ, getMaxUserAuctions, isUserPostEnabled } from "../../config/env.js";
import { formatInTimeZone } from 'date-fns-tz';
import { addDays, set } from 'date-fns';
import { t } from '../../services/i18n.js';
import { buildAuctionText, sanitizeHtml, deriveTitle, truncateCaption, formatUserLinkById } from '../../utils/utils.js';

/** @type {Map<number, {step: string, data: any, views: string[], viewMsgId: ?number}>} */
const userSessions = new Map();

/**
 * Prompt and keyboard for every screen of the user posting wizard, keyed by
 * view name.
 *
 * A view is what the user sees; `session.step` is what handleUserPostInput
 * dispatches on. They match except for STEP, which has two screens — preset
 * buttons and a typed amount — so that "back" returns to the presets instead of
 * skipping the whole step.
 *
 * @type {Object<string, function(Object): {text: string, kb: Object, step?: string}>}
 */
const USER_POST_VIEWS = {
    IMAGE: () => ({
        text: t('admin.post_step_img'),
        kb: makeAdminPostCancelKb(false, true)
    }),
    TITLE: () => ({
        text: t('admin.post_step_title'),
        kb: makeAdminPostCancelKb(false, true)
    }),
    MIN_BID: () => ({
        text: t('admin.post_step_min_bid'),
        kb: makeAdminPostCancelKb(false, true)
    }),
    STEP: () => ({
        text: t('admin.post_step_step'),
        kb: makeUserPostStepKb()
    }),
    STEP_CUSTOM: () => ({
        step: 'STEP',
        text: t('admin.post_step_step'),
        kb: makeAdminPostCancelKb(false, true)
    }),
    DURATION: () => ({
        text: t('admin.post_step_end'),
        kb: makeUserPostDurationKb()
    }),
    TIME: () => ({
        text: t('admin.post_step_time'),
        kb: makeUserPostTimeKb()
    }),
    CONTINUOUS: () => {
        const min = q.getSetting.get('CONTINUOUS_MINUTES')?.value || '5';
        return {
            text: t('admin.post_step_continuous', { min }),
            kb: makeUserPostContinuousKb(min)
        };
    },
    CONFIRM: (session) => ({
        text: truncateCaption(buildConfirmText(session.data)),
        kb: makeUserPostConfirmKb()
    })
};

export function registerUserPostHandlers(bot) {
    bot.on('callback_query', async (query) => {
        const { data, message, from } = query;
        const chatId = message.chat.id;
        if (data === 'user_post') {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            
            if (!isUserPostEnabled()) {
                return bot.sendMessage(chatId, t('admin.user_post_disabled'), {
                    parse_mode: 'HTML'
                });
            }

            const pendingCount = q.countPendingAuctionsByUser.get(from.id).count;
            const activeCount = q.countActiveAuctionsByUser.get(from.id).count;
            const totalCount = pendingCount + activeCount;

            const maxAuctions = getMaxUserAuctions();
            if (totalCount >= maxAuctions) {
                return bot.sendMessage(chatId, t('admin.user_post_too_many', { count: maxAuctions }), {
                    parse_mode: 'HTML'
                });
            }

            const rulesLink = q.getSetting.get('RULES_LINK')?.value;
            if (rulesLink) {
                await bot.sendMessage(chatId, t('user.rules_title') + '\n\n' + t('user.rules_text'), {
                    parse_mode: 'HTML',
                    reply_markup: makeUserRulesKb(rulesLink)
                });
                return;
            }

            await startSession(bot, chatId, from.id);
        }

        if (data === 'user_rules_confirm') {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            await startSession(bot, chatId, from.id);
        }

        if (data === 'user_post_back') {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            const session = userSessions.get(from.id);
            if (!session) return;

            await goBack(bot, chatId, session);
        }

        if (data.startsWith('user_post_dur:')) {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            const session = userSessions.get(from.id);
            if (!session || session.step !== 'DURATION') return;

            session.data.duration_days = parseInt(data.split(':')[1]);
            await goToView(bot, chatId, session, 'TIME');
        }

        if (data.startsWith('user_post_time:')) {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            const session = userSessions.get(from.id);
            if (!session || session.step !== 'TIME') return;

            const hour = parseInt(data.split(':')[1]);
            const endAt = addDays(new Date(), session.data.duration_days);
            session.data.end_at = set(endAt, { hours: hour, minutes: 0, seconds: 0, milliseconds: 0 });

            await goToView(bot, chatId, session, 'CONTINUOUS');
        }

        if (data === 'user_post_skip' || data === 'user_post_continue') {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            const session = userSessions.get(from.id);
            if (!session) return;

            if (session.step === 'IMAGE') {
                if (session.data.photo_ids && session.data.photo_ids.length > 0) {
                    session.data.photo_id = session.data.photo_ids[0];
                }
                await goToView(bot, chatId, session, 'TITLE');
            }
        }

        if (data === 'user_post_cancel') {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            const cancelledSession = userSessions.get(from.id);
            if (cancelledSession?.media_timer) clearTimeout(cancelledSession.media_timer);
            userSessions.delete(from.id);
            await bot.sendMessage(chatId, t('admin.post_cancelled'), {
                parse_mode: 'HTML'
            });
        }

        if (data.startsWith('user_post_cont:')) {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            const session = userSessions.get(from.id);
            if (!session) return;

            session.data.is_continuous = parseInt(data.split(':')[1]);
            session.data.continuous_minutes = parseInt(q.getSetting.get('CONTINUOUS_MINUTES')?.value || '5');

            await goToView(bot, chatId, session, 'CONFIRM');
        }

        if (data.startsWith('user_post_step:')) {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            const session = userSessions.get(from.id);
            if (!session || session.step !== 'STEP') return;

            const val = data.split(':')[1];
            if (val === 'custom') {
                await goToView(bot, chatId, session, 'STEP_CUSTOM');
            } else {
                session.data.step = parseInt(val);
                await goToView(bot, chatId, session, 'DURATION');
            }
        }

        if (data === 'user_post_confirm') {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            const session = userSessions.get(from.id);
            if (!session || session.step !== 'CONFIRM') return;

            const { data: sessionData } = session;
            // Consume the session synchronously BEFORE the await chain below, so a
            // rapid double-tap can't insert a second pending auction / re-notify admins.
            userSessions.delete(from.id);

            q.insertPendingAuction.run({
                user_id: sessionData.user_id,
                title: sessionData.title,
                full_text: sessionData.full_text,
                photo_ids: sessionData.photo_ids ? sessionData.photo_ids.join(',') : null,
                min_bid: sessionData.min_bid,
                step: sessionData.step,
                end_at: sessionData.end_at.toISOString(),
                is_continuous: sessionData.is_continuous || 0,
                continuous_minutes: sessionData.continuous_minutes || 5
            });

            // Notify admins
            const admins = q.getAllAdmins.all();
            const userLink = formatUserLinkById(from.id);
            const notificationText = t('admin.kb.admin_new_pending')
                .replace('%user%', userLink)
                .replace('%title%', sessionData.title);

            await Promise.allSettled(admins.map(admin =>
                bot.sendMessage(admin.user_id, notificationText, { parse_mode: 'HTML' })
                    .catch(e => console.error(`Failed to notify admin ${admin.user_id}:`, e.message))
            ));

            await bot.sendMessage(chatId, t('admin.post_pending_success'), {
                parse_mode: 'HTML'
            });
        }
    });
}

export async function handleUserPostInput(bot, msg) {
    const session = userSessions.get(msg.from.id);
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
                        if (userSessions.get(msg.from.id) !== session) return;
                        await showPhotoReceivedOptions(bot, chatId, session);
                    }, 500);
                } else {
                    await showPhotoReceivedOptions(bot, chatId, session);
                }
                return true;
            }
            return false;

        case 'TITLE':
            if (text) {
                const sanitizedText = sanitizeHtml(text);
                if (sanitizedText.length > 500) {
                    await bot.sendMessage(chatId, t('admin.error_too_long', { length: sanitizedText.length }), { parse_mode: 'HTML' });
                    return true;
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
                await goToView(bot, chatId, session, 'DURATION');
                return true;
            }
            break;
    }
    return false;
}

/**
 * Confirms a received photo and offers to move on. Still the IMAGE step, so it
 * replaces that step's live keyboard rather than opening a new view.
 */
async function showPhotoReceivedOptions(bot, chatId, session) {
    await clearActiveKeyboard(bot, chatId, session);
    const sent = await bot.sendMessage(chatId, t('admin.post_photo_added', { count: session.data.photo_ids.length }), {
        reply_markup: makeAdminPostCancelKb(false, true, true)
    });
    session.viewMsgId = sent.message_id;
}

function buildConfirmText(data) {
    let confirmText = t('admin.user_post_confirm', {
        full_text: buildAuctionText(data, false, false),
        min_bid: data.min_bid,
        step: data.step,
        end_at: formatInTimeZone(data.end_at, TZ, 'dd.MM HH:mm'),
        continuous: data.is_continuous ? t('admin.kb.yes') : t('admin.kb.no'),
        cur: q.getSetting.get('CURRENCY')?.value || '₴'
    });

    const user = q.getUserFromAnywhere.get(data.user_id, data.user_id, data.user_id, data.user_id);
    if (user && !user.username) {
        confirmText += `\n\n${t('admin.privacy_warning')}`;
    }

    return confirmText;
}

/**
 * Starts a fresh posting session on the first step.
 *
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} chatId - Chat to prompt in.
 * @param {number} userId - Owner of the session.
 */
async function startSession(bot, chatId, userId) {
    const session = { step: 'IMAGE', data: { user_id: userId }, views: [], viewMsgId: null };
    userSessions.set(userId, session);
    await goToView(bot, chatId, session, 'IMAGE');
}

/**
 * Advances the wizard to `view`, pushing it onto the session's view stack so
 * `user_post_back` knows where to return to.
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
    // list would keep the very photo the user came back to replace.
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
    const { text, kb, step = view } = USER_POST_VIEWS[view](session);
    session.step = step;

    const sent = await bot.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: session.views.length > 1 ? withBackButton(kb, 'user_post_back') : kb
    });
    session.viewMsgId = sent.message_id;
}

/**
 * Strips the keyboard off the prompt the wizard is currently showing, so a step
 * the user has already left can't be answered again and desync the view stack.
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
