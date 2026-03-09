import { q } from '../../services/db.js';
import { makeAdminPostStepKb, makeAdminPostCancelKb, makeAdminPostConfirmKb } from '../../utils/keyboards.js';
import { TZ, getChannelId } from "../../config/env.js";
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
 * @param {import('telegraf').Telegraf} bot - Telegraf bot instance.
 */
export function registerPostHandlers(bot) {
    bot.action('adm_post', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));
        
        postSessions.set(ctx.from.id, { step: 'IMAGE', data: {} });
        await ctx.editMessageText(t('admin.post_step_img'), {
            parse_mode: 'HTML',
            reply_markup: makeAdminPostCancelKb(true)
        });
        await ctx.answerCbQuery();
    });

    bot.action('post_skip', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));
        const session = postSessions.get(ctx.from.id);
        if (!session) return ctx.answerCbQuery();

        if (session.step === 'IMAGE') {
            session.step = 'TITLE';
            await ctx.editMessageText(t('admin.post_step_title'), {
                parse_mode: 'HTML',
                reply_markup: makeAdminPostCancelKb()
            });
        } else if (session.step === 'DATE') {
            session.data.end_at = session.data.default_date;
            await goToConfirmStep(ctx, session);
        }
        await ctx.answerCbQuery();
    });

    bot.action('post_cancel', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));
        postSessions.delete(ctx.from.id);
        await ctx.editMessageText(t('admin.post_cancelled'), { parse_mode: 'HTML' });
        await sendAdminPanel(ctx, false);
        await ctx.answerCbQuery();
    });

    bot.action(/^post_step:(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));
        const session = postSessions.get(ctx.from.id);
        if (!session || session.step !== 'STEP') return ctx.answerCbQuery();

        const val = ctx.match[1];
        if (val === 'custom') {
            await ctx.reply(t('admin.post_step_step'), {
                parse_mode: 'HTML',
                reply_markup: makeAdminPostCancelKb()
            });
        } else {
            session.data.step = parseInt(val);
            await goToDateStep(ctx, session);
        }
        await ctx.answerCbQuery();
    });

    bot.action('post_confirm', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));
        const session = postSessions.get(ctx.from.id);
        if (!session || session.step !== 'CONFIRM') return ctx.answerCbQuery();

        const { data } = session;
        const channelId = getChannelId();
        
        if (!channelId) {
            return ctx.reply("Channel ID is not set in settings!").catch(() => {});
        }

        try {
            const cur = getCurrency();
            const header = q.getSetting.get('AUCTION_HEADER')?.value || t('parse.defaults.header');
            const minBidText = q.getSetting.get('AUCTION_MIN_BID_TEXT')?.value || t('parse.defaults.min_bid');
            const bidStepText = q.getSetting.get('AUCTION_BID_STEP_TEXT')?.value || t('parse.defaults.bid_step');
            const endDateText = q.getSetting.get('AUCTION_END_DATE_TEXT')?.value || t('parse.defaults.end_date');
            const footer = q.getSetting.get('AUCTION_FOOTER')?.value || t('parse.defaults.footer');

            const formattedEnd = formatInTimeZone(data.end_at, TZ, 'dd.MM о HH:mm');

            const auctionPost = `${header}\n\n${data.full_text}\n\n` +
                `${minBidText}: <b>${data.min_bid} ${cur}</b>\n` +
                `${bidStepText}: <b>${data.step} ${cur}</b>\n` +
                `${endDateText}: <b>${formattedEnd}</b>\n\n` +
                `${footer}`;

            const kb = makeKb(channelId, 0, data.min_bid, 0);
            let sentMsg;
            if (data.photo_id) {
                sentMsg = await ctx.telegram.sendPhoto(channelId, data.photo_id, {
                    caption: auctionPost,
                    parse_mode: 'HTML',
                    reply_markup: kb
                });
            } else {
                sentMsg = await ctx.telegram.sendMessage(channelId, auctionPost, {
                    parse_mode: 'HTML',
                    reply_markup: kb
                });
            }

            // Update keyboard with actual message_id
            const finalKb = makeKb(channelId, sentMsg.message_id, data.min_bid, 0);
            await ctx.telegram.editMessageReplyMarkup(channelId, sentMsg.message_id, undefined, finalKb);

            q.insertAuction.run({
                chat_id: channelId,
                message_id: sentMsg.message_id,
                title: data.title,
                full_text: auctionPost,
                photo_id: data.photo_id || null,
                min_bid: data.min_bid,
                step: data.step,
                current_price: data.min_bid,
                end_at: data.end_at.toISOString()
            });

            scheduleClose(ctx, channelId, sentMsg.message_id, data.end_at);

            postSessions.delete(ctx.from.id);
            await ctx.editMessageText(t('admin.post_success'), { parse_mode: 'HTML' });
            await sendAdminPanel(ctx, false);
        } catch (e) {
            console.error('Failed to post auction:', e);
            await ctx.reply(t('common.error_try_again') + ': ' + e.message);
        }
        await ctx.answerCbQuery();
    });
}

/**
 * Handles message input for the auction posting wizard.
 * 
 * @param {import('telegraf').Context} ctx - Telegram context.
 * @returns {Promise<boolean>} True if the message was handled.
 */
export async function handlePostInput(ctx) {
    const session = postSessions.get(ctx.from.id);
    if (!session) return false;

    const text = ctx.message?.text;
    const photo = ctx.message?.photo;

    switch (session.step) {
        case 'IMAGE':
            if (photo) {
                session.data.photo_id = photo[photo.length - 1].file_id;
                session.step = 'TITLE';
                await ctx.reply(t('admin.post_step_title'), {
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
                await ctx.reply(t('admin.post_step_min_bid'), {
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
                    await ctx.reply(t('admin.invalid_number'));
                    return true;
                }
                session.data.min_bid = val;
                session.step = 'STEP';
                await ctx.reply(t('admin.post_step_step'), {
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
                    await ctx.reply(t('admin.invalid_number'));
                    return true;
                }
                session.data.step = val;
                await goToDateStep(ctx, session);
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
                    await ctx.reply(t('admin.invalid_date'));
                    return true;
                }
                session.data.end_at = date;
                await goToConfirmStep(ctx, session);
                return true;
            }
            break;
    }

    return false;
}

async function goToDateStep(ctx, session) {
    session.step = 'DATE';
    const defDays = parseInt(q.getSetting.get('DEFAULT_END_DAYS')?.value || '5');
    const defTime = q.getSetting.get('DEFAULT_END_TIME')?.value || '21:00';
    
    // Calculate default date
    let defDate = addDays(new Date(), defDays);
    const [hours, minutes] = defTime.split(':').map(Number);
    defDate = set(defDate, { hours, minutes, seconds: 0, milliseconds: 0 });
    
    session.data.default_date = defDate;
    const formattedDef = formatInTimeZone(defDate, TZ, 'dd.MM.yyyy HH:mm');

    await ctx.reply(t('admin.post_step_end', { default: formattedDef }), {
        parse_mode: 'HTML',
        reply_markup: makeAdminPostCancelKb(true) // Reuse skip for default
    });
}

// Special skip for date step
export async function handleDateSkip(ctx) {
    const session = postSessions.get(ctx.from.id);
    if (!session || session.step !== 'DATE') return false;
    
    session.data.end_at = session.data.default_date;
    await goToConfirmStep(ctx, session);
    return true;
}

async function goToConfirmStep(ctx, session) {
    session.step = 'CONFIRM';
    const { data } = session;
    const text = t('admin.post_confirm', {
        full_text: data.full_text,
        min_bid: data.min_bid,
        step: data.step,
        end_at: formatInTimeZone(data.end_at, TZ, 'dd.MM.yyyy HH:mm'),
        cur: getCurrency()
    });

    await ctx.reply(text, {
        parse_mode: 'HTML',
        reply_markup: makeAdminPostConfirmKb()
    });
}

function isAdmin(ctx) {
    const admin = q.getAdmin.get(ctx.from.id);
    return admin && admin.otp_code === null;
}
