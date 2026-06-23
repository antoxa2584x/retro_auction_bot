import { q } from '../../services/db.js';
import { 
    makeAdminPostCancelKb, 
    makeUserPostStepKb,
    makeUserPostContinuousKb,
    makeUserPostConfirmKb,
    makeUserRulesKb,
    makeUserPostDurationKb,
    makeUserPostTimeKb
} from '../../utils/keyboards.js';
import { TZ, getMaxUserAuctions, isUserPostEnabled } from "../../config/env.js";
import { formatInTimeZone } from 'date-fns-tz';
import { addDays, set } from 'date-fns';
import { t } from '../../services/i18n.js';
import { buildAuctionText, sanitizeHtml, truncateCaption, formatUserLinkById } from '../../utils/utils.js';

/** @type {Map<number, {step: string, data: any}>} */
const userSessions = new Map();

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

            userSessions.set(from.id, { step: 'IMAGE', data: { user_id: from.id } });
            await bot.sendMessage(chatId, t('admin.post_step_img'), {
                parse_mode: 'HTML',
                reply_markup: makeAdminPostCancelKb(false, true)
            });
        }

        if (data === 'user_rules_confirm') {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            userSessions.set(from.id, { step: 'IMAGE', data: { user_id: from.id } });
            await bot.sendMessage(chatId, t('admin.post_step_img'), {
                parse_mode: 'HTML',
                reply_markup: makeAdminPostCancelKb(false, true)
            });
        }

        if (data.startsWith('user_post_dur:')) {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            const session = userSessions.get(from.id);
            if (!session || session.step !== 'DURATION') return;

            session.data.duration_days = parseInt(data.split(':')[1]);
            await goToTimeStep(bot, chatId, session);
        }

        if (data.startsWith('user_post_time:')) {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            const session = userSessions.get(from.id);
            if (!session || session.step !== 'TIME') return;

            const hour = parseInt(data.split(':')[1]);
            const endAt = addDays(new Date(), session.data.duration_days);
            session.data.end_at = set(endAt, { hours: hour, minutes: 0, seconds: 0, milliseconds: 0 });
            
            await goToContinuousStep(bot, chatId, session);
        }

        if (data === 'user_post_skip' || data === 'user_post_continue') {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            const session = userSessions.get(from.id);
            if (!session) return;

            if (session.step === 'IMAGE') {
                if (session.data.photo_ids && session.data.photo_ids.length > 0) {
                    session.data.photo_id = session.data.photo_ids[0];
                }
                session.step = 'TITLE';
                await bot.sendMessage(chatId, t('admin.post_step_title'), {
                    parse_mode: 'HTML',
                    reply_markup: makeAdminPostCancelKb(false, true)
                });
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
            
            await goToConfirmStep(bot, chatId, session);
        }

        if (data.startsWith('user_post_step:')) {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            const session = userSessions.get(from.id);
            if (!session || session.step !== 'STEP') return;

            const val = data.split(':')[1];
            if (val === 'custom') {
                await bot.sendMessage(chatId, t('admin.post_step_step'), {
                    parse_mode: 'HTML',
                    reply_markup: makeAdminPostCancelKb(false, true)
                });
            } else {
                session.data.step = parseInt(val);
                await goToDurationStep(bot, chatId, session);
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
                        await bot.sendMessage(chatId, t('admin.post_photo_added', { count: session.data.photo_ids.length }), {
                            reply_markup: makeAdminPostCancelKb(false, true, true)
                        });
                    }, 500);
                } else {
                    await bot.sendMessage(chatId, t('admin.post_photo_added', { count: session.data.photo_ids.length }), {
                        reply_markup: makeAdminPostCancelKb(false, true, true)
                    });
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
                session.data.title = sanitizedText.split('\n')[0].substring(0, 50);
                session.step = 'MIN_BID';
                await bot.sendMessage(chatId, t('admin.post_step_min_bid'), {
                    parse_mode: 'HTML',
                    reply_markup: makeAdminPostCancelKb(false, true)
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
                    reply_markup: makeUserPostStepKb()
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
                await goToDurationStep(bot, chatId, session);
                return true;
            }
            break;
    }
    return false;
}

async function goToDurationStep(bot, chatId, session) {
    session.step = 'DURATION';
    await bot.sendMessage(chatId, t('admin.post_step_end'), {
        parse_mode: 'HTML',
        reply_markup: makeUserPostDurationKb()
    });
}

async function goToTimeStep(bot, chatId, session) {
    session.step = 'TIME';
    await bot.sendMessage(chatId, t('admin.post_step_time'), {
        parse_mode: 'HTML',
        reply_markup: makeUserPostTimeKb()
    });
}

async function goToContinuousStep(bot, chatId, session) {
    session.step = 'CONTINUOUS';
    const min = q.getSetting.get('CONTINUOUS_MINUTES')?.value || '5';
    await bot.sendMessage(chatId, t('admin.post_step_continuous', { min }), {
        parse_mode: 'HTML',
        reply_markup: makeUserPostContinuousKb(min)
    });
}

async function goToConfirmStep(bot, chatId, session) {
    session.step = 'CONFIRM';
    const { data } = session;
    
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

    await bot.sendMessage(chatId, truncateCaption(confirmText), {
        parse_mode: 'HTML',
        reply_markup: makeUserPostConfirmKb()
    });
}
