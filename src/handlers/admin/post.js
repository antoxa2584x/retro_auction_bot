import { q } from '../../services/db.js';
import { makeAdminPostStepKb, makeAdminPostCancelKb, makeAdminPostConfirmKb, makeAdminPostContactKb } from '../../utils/keyboards.js';
import { TZ, getChannelId, getAdminNickname } from "../../config/env.js";
import { formatInTimeZone, toDate } from 'date-fns-tz';
import { parse, addDays, set } from 'date-fns';
import { scheduleClose } from '../../services/scheduler.js';
import { makeKb } from '../../utils/keyboards.js';
import { t, getCurrency } from '../../services/i18n.js';
import { sendAdminPanel } from './manage.js';

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
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);
            
            postSessions.set(from.id, { step: 'IMAGE', data: {} });
            await bot.editMessageText(t('admin.post_step_img'), {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                reply_markup: makeAdminPostCancelKb(true)
            });
        }

        if (data === 'post_skip') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);
            const session = postSessions.get(from.id);
            if (!session) return;

            if (session.step === 'IMAGE') {
                session.step = 'TITLE';
                await bot.editMessageText(t('admin.post_step_title'), {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML',
                    reply_markup: makeAdminPostCancelKb()
                });
            } else if (session.step === 'DATE') {
                session.data.end_at = session.data.default_date;
                await goToContactStep(bot, chatId, session);
            }
        }

        if (data === 'post_cancel') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);
            postSessions.delete(from.id);
            await bot.editMessageText(t('admin.post_cancelled'), {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML'
            });
            await sendAdminPanel(bot, chatId, false);
        }

        const stepMatch = data.match(/^post_step:(.+)$/);
        if (stepMatch) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);
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
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);
            const session = postSessions.get(from.id);
            if (!session || session.step !== 'CONTACT') return;

            const val = contactMatch[1];
            if (val === 'default') {
                session.data.admin_contact = getAdminNickname();
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

        if (data === 'post_confirm') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);
            const session = postSessions.get(from.id);
            if (!session || session.step !== 'CONFIRM') return;

            const { data: sessionData } = session;
            const channelId = getChannelId();
            
            if (!channelId) {
                return bot.sendMessage(chatId, "Channel ID is not set in settings!").catch(() => {});
            }

            try {
                const cur = getCurrency();
                const header = q.getSetting.get('AUCTION_HEADER')?.value || t('parse.defaults.header');
                const minBidText = q.getSetting.get('AUCTION_MIN_BID_TEXT')?.value || t('parse.defaults.min_bid');
                const bidStepText = q.getSetting.get('AUCTION_BID_STEP_TEXT')?.value || t('parse.defaults.bid_step');
                const endDateText = q.getSetting.get('AUCTION_END_DATE_TEXT')?.value || t('parse.defaults.end_date');
                const footer = q.getSetting.get('AUCTION_FOOTER')?.value || t('parse.defaults.footer');

                const formattedEnd = formatInTimeZone(sessionData.end_at, TZ, 'dd.MM о HH:mm');

                const auctionPost = `${header}\n\n${sessionData.full_text}\n\n` +
                    `${minBidText}: <b>${sessionData.min_bid} ${cur}</b>\n` +
                    `${bidStepText}: <b>${sessionData.step} ${cur}</b>\n` +
                    `${endDateText}: <b>${formattedEnd}</b>\n\n` +
                    `${footer}`;

                const kb = makeKb(channelId, 0, sessionData.min_bid, 0);
                let sentMsg;
                if (sessionData.photo_id) {
                    sentMsg = await bot.sendPhoto(channelId, sessionData.photo_id, {
                        caption: auctionPost,
                        parse_mode: 'HTML',
                        reply_markup: kb
                    });
                } else {
                    sentMsg = await bot.sendMessage(channelId, auctionPost, {
                        parse_mode: 'HTML',
                        reply_markup: kb
                    });
                }

                // Update keyboard with actual message_id
                const finalKb = makeKb(channelId, sentMsg.message_id, sessionData.min_bid, 0);
                await bot.editMessageReplyMarkup(finalKb, {
                    chat_id: channelId,
                    message_id: sentMsg.message_id
                });

                q.insertAuction.run({
                    chat_id: channelId,
                    message_id: sentMsg.message_id,
                    title: sessionData.title,
                    full_text: auctionPost,
                    photo_id: sessionData.photo_id || null,
                    min_bid: sessionData.min_bid,
                    step: sessionData.step,
                    current_price: sessionData.min_bid,
                    admin_contact: sessionData.admin_contact,
                    end_at: sessionData.end_at.toISOString()
                });

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
                await bot.sendMessage(chatId, t('common.error_try_again') + ': ' + e.message, { parse_mode: 'HTML' });
            }
            await bot.answerCallbackQuery(query.id);
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
                session.data.photo_id = photo[photo.length - 1].file_id;
                session.step = 'TITLE';
                await bot.sendMessage(chatId, t('admin.post_step_title'), {
                    parse_mode: 'HTML',
                    reply_markup: makeAdminPostCancelKb()
                });
                return true;
            }
            return false;

        case 'TITLE':
            if (text) {
                session.data.full_text = text;
                session.data.title = text.split('\n')[0].substring(0, 50);
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
                const val = parseInt(text);
                if (isNaN(val)) {
                    await bot.sendMessage(chatId, t('admin.invalid_number'), { parse_mode: 'HTML' });
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
                const val = parseInt(text);
                if (isNaN(val)) {
                    await bot.sendMessage(chatId, t('admin.invalid_number'), { parse_mode: 'HTML' });
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
                try {
                    date = parse(text, 'dd.MM.yyyy HH:mm', new Date());
                    if (isNaN(date.getTime())) throw new Error();
                } catch (e) {
                    await bot.sendMessage(chatId, t('admin.invalid_date'), { parse_mode: 'HTML' });
                    return true;
                }
                session.data.end_at = date;
                await goToContactStep(bot, chatId, session);
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

async function goToDateStep(bot, chatId, session) {
    session.step = 'DATE';
    const defDays = parseInt(q.getSetting.get('DEFAULT_END_DAYS')?.value || '5');
    const defTime = q.getSetting.get('DEFAULT_END_TIME')?.value || '21:00';
    
    // Calculate default date
    let defDate = addDays(new Date(), defDays);
    const [hours, minutes] = defTime.split(':').map(Number);
    defDate = set(defDate, { hours, minutes, seconds: 0, milliseconds: 0 });
    
    session.data.default_date = defDate;
    const formattedDef = formatInTimeZone(defDate, TZ, 'dd.MM.yyyy HH:mm');

    await bot.sendMessage(chatId, t('admin.post_step_end', { default: formattedDef }), {
        parse_mode: 'HTML',
        reply_markup: makeAdminPostCancelKb(true) // Reuse skip for default
    });
}

async function goToContactStep(bot, chatId, session) {
    session.step = 'CONTACT';
    const defaultContact = getAdminNickname();
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
    await goToContactStep(bot, chatId, session);
    return true;
}

async function goToConfirmStep(bot, chatId, session) {
    session.step = 'CONFIRM';
    const { data } = session;
    const text = t('admin.post_confirm', {
        full_text: data.full_text,
        min_bid: data.min_bid,
        step: data.step,
        end_at: formatInTimeZone(data.end_at, TZ, 'dd.MM.yyyy HH:mm'),
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
