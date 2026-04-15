import { q } from '../../services/db.js';
import { 
    makeAdminPostCancelKb, 
    makeAdminPostContinuousKb,
    makeUserPostStepKb,
    makeUserPostContinuousKb,
    makeUserPostConfirmKb
} from '../../utils/keyboards.js';
import { TZ } from "../../config/env.js";
import { formatInTimeZone } from 'date-fns-tz';
import { parse, addDays, set } from 'date-fns';
import { t } from '../../services/i18n.js';
import { buildAuctionText, getDefaultEndDate, sanitizeHtml } from '../../utils/utils.js';

/** @type {Map<number, {step: string, data: any}>} */
const userSessions = new Map();

export function registerUserPostHandlers(bot) {
    bot.on('callback_query', async (query) => {
        const { data, message, from } = query;
        const chatId = message.chat.id;
        const messageId = message.message_id;

        if (data === 'user_post') {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            
            const pendingCount = q.countPendingAuctionsByUser.get(from.id).count;
            if (pendingCount >= 3) {
                return bot.sendMessage(chatId, t('admin.user_post_too_many'), {
                    parse_mode: 'HTML'
                });
            }

            userSessions.set(from.id, { step: 'IMAGE', data: { user_id: from.id } });
            await bot.sendMessage(chatId, t('admin.post_step_img'), {
                parse_mode: 'HTML',
                reply_markup: makeAdminPostCancelKb(false, true)
            });
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
            } else if (session.step === 'DATE') {
                session.data.end_at = session.data.default_date;
                await goToContinuousStep(bot, chatId, session);
            }
        }

        if (data === 'user_post_cancel') {
            await bot.answerCallbackQuery(query.id).catch(() => {});
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
                await goToDateStep(bot, chatId, session);
            }
        }

        if (data === 'user_post_confirm') {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            const session = userSessions.get(from.id);
            if (!session || session.step !== 'CONFIRM') return;

            const { data: sessionData } = session;
            
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
            const admins = q.getAdmins.all();
            const notificationText = t('admin.kb.admin_new_pending')
                .replace('%user%', from.username ? `@${from.username}` : from.id)
                .replace('%title%', sessionData.title);

            for (const admin of admins) {
                try {
                    await bot.sendMessage(admin.user_id, notificationText, { parse_mode: 'HTML' });
                } catch (e) {
                    console.error(`Failed to notify admin ${admin.user_id}:`, e.message);
                }
            }

            userSessions.delete(from.id);
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
                        await bot.sendMessage(chatId, t('admin.post_photo_added', { count: session.data.photo_ids.length }), {
                            reply_markup: makeAdminPostCancelKb(false, true, true)
                        });
                        delete session.media_timer;
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
                const parsedDate = parse(text, 'dd.MM.yyyy HH:mm', new Date());
                if (!isNaN(parsedDate.getTime())) {
                    session.data.end_at = parsedDate;
                    await goToContinuousStep(bot, chatId, session);
                    return true;
                } else {
                    await bot.sendMessage(chatId, t('admin.invalid_date'), { parse_mode: 'HTML' });
                    return true;
                }
            }
            break;
    }
    return false;
}

async function goToDateStep(bot, chatId, session) {
    session.step = 'DATE';
    
    const defaultDate = getDefaultEndDate();
    session.data.default_date = defaultDate;

    const formattedDefault = formatInTimeZone(defaultDate, TZ, 'dd.MM.yyyy HH:mm');
    await bot.sendMessage(chatId, t('admin.post_step_end', { default: formattedDefault }), {
        parse_mode: 'HTML',
        reply_markup: makeAdminPostCancelKb(true, true)
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

    await bot.sendMessage(chatId, confirmText, {
        parse_mode: 'HTML',
        reply_markup: makeUserPostConfirmKb()
    });
}
