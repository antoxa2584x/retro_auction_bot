import { q } from '../../services/db.js';
import { makeKb, makeAdminActiveKb, makeAdminFinishedKb, makeAdminAuctionActionKb, makeAdminPanelKb } from '../../utils/keyboards.js';
import { TZ } from "../../config/env.js";
import { formatInTimeZone } from 'date-fns-tz';
import { scheduleClose, closeAuction } from '../../services/scheduler.js';
import { getAuctionLink } from '../../utils/utils.js';
import { t } from '../../services/i18n.js';

/**
 * Registers handlers for managing auctions in the admin panel.
 * 
 * @param {import('telegraf').Telegraf} bot - Telegraf bot instance.
 */
export function registerManageHandlers(bot) {
    bot.action('adm_list', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));
        await sendAdminPanel(ctx, true);
        await ctx.answerCbQuery();
    });

    bot.action('adm_active', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        const auctions = q.getAllActiveAuctions.all();

        if (auctions.length === 0) {
            await ctx.editMessageText(t('admin.panel_header') + '\n\n' + t('admin.no_active_auctions'), {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: t('admin.kb.back_to_panel'), callback_data: 'adm_list' }]]
                }
            });
            await ctx.answerCbQuery();
            return;
        }

        await ctx.editMessageText(t('admin.panel_header') + '\n\n' + t('admin.active_auctions_header'), {
            parse_mode: 'HTML',
            reply_markup: makeAdminActiveKb(auctions)
        });
        await ctx.answerCbQuery();
    });

    bot.action('adm_finished', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        const auctions = q.getRecentlyFinishedAuctions.all();

        if (auctions.length === 0) {
            await ctx.editMessageText(t('admin.panel_header') + '\n\n' + t('admin.no_finished_auctions'), {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: t('admin.kb.back_to_panel'), callback_data: 'adm_list' }]]
                }
            });
            await ctx.answerCbQuery();
            return;
        }

        await ctx.editMessageText(t('admin.panel_header') + '\n\n' + t('admin.finished_auctions_header'), {
            parse_mode: 'HTML',
            reply_markup: makeAdminFinishedKb(auctions)
        });
        await ctx.answerCbQuery();
    });

    bot.action(/^adm_view:(.+):(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        const chatId = Number(ctx.match[1]);
        const msgId = Number(ctx.match[2]);
        const a = q.getAuction.get(chatId, msgId);

        if (!a) return ctx.answerCbQuery(t('bid.not_found'));

        const endDate = formatInTimeZone(new Date(a.end_at), TZ, 'dd.MM.yyyy HH:mm');
        const link = getAuctionLink(chatId, msgId);
        
        const statusText = a.status === 'active' ? t('admin.status_active') : t('admin.status_finished');
        
        const winner = a.leader_id 
            ? `<a href="tg://user?id=${a.leader_id}">${a.leader_name || a.leader_id}</a>`
            : t('bid.no_bids');

        const text = t('admin.panel_header') + '\n\n' +
            t('admin.auction_details', {
                title: a.title,
                chat_id: chatId,
                message_id: msgId,
                price: a.current_price,
                status: statusText,
                end_at: endDate,
                winner: winner,
                link: link
            });

        await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: makeAdminAuctionActionKb(chatId, msgId, a.status)
        });
        await ctx.answerCbQuery();
    });

    bot.action(/^adm_restart:(.+):(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        const chatId = Number(ctx.match[1]);
        const msgId = Number(ctx.match[2]);
        const a = q.getAuction.get(chatId, msgId);

        if (!a) return ctx.answerCbQuery(t('bid.not_found'));
        if (a.status !== 'finished') return ctx.answerCbQuery('Only finished auctions can be restarted');

        const originalEnd = new Date(a.end_at);
        const newEnd = new Date();
        newEnd.setDate(newEnd.getDate() + 4);
        newEnd.setHours(originalEnd.getHours(), originalEnd.getMinutes(), originalEnd.getSeconds(), originalEnd.getMilliseconds());

        const newEndStr = formatInTimeZone(newEnd, TZ, 'dd.MM');
        const newTimeStr = formatInTimeZone(newEnd, TZ, 'HH:mm');
        const reEnd = /Завершення\s+аукціону:\s*([0-3]?\d\.[01]?\d)\s*о\s*([0-2]?\d:[0-5]\d)/i;
        const updatedFullText = a.full_text.replace(reEnd, `Завершення аукціону: ${newEndStr} о ${newTimeStr}`);

        let newMsg;
        try {
            const kb = makeKb(chatId, 0, a.min_bid, 0);
            if (a.photo_id) {
                newMsg = await ctx.telegram.sendPhoto(chatId, a.photo_id, {
                    caption: updatedFullText,
                    parse_mode: 'HTML',
                    reply_markup: kb
                });
            } else {
                newMsg = await ctx.telegram.sendMessage(chatId, updatedFullText, {
                    parse_mode: 'HTML',
                    reply_markup: kb
                });
            }
        } catch (e) {
            console.error('Failed to create new post for restart:', e.message);
            return ctx.answerCbQuery(t('common.error_try_again'));
        }

        try {
            const finalKb = makeKb(chatId, newMsg.message_id, a.min_bid, 0);
            await ctx.telegram.editMessageReplyMarkup(chatId, newMsg.message_id, undefined, finalKb);
        } catch (e) {
            console.error('Failed to update new post keyboard:', e.message);
        }

        q.insertAuction.run({
            chat_id: chatId,
            message_id: newMsg.message_id,
            title: a.title,
            full_text: updatedFullText,
            photo_id: a.photo_id,
            min_bid: a.min_bid,
            step: a.step,
            current_price: a.min_bid,
            end_at: newEnd.toISOString()
        });

        scheduleClose(ctx, chatId, newMsg.message_id, newEnd);

        await ctx.reply(t('admin.restart_success', { 
            title: a.title, 
            date: formatInTimeZone(newEnd, TZ, 'dd.MM.yyyy HH:mm') 
        }));
        await ctx.answerCbQuery(t('admin.finish_success'));
        await sendAdminPanel(ctx, true);
    });

    bot.action(/^adm_finish_now:(.+):(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        const chatId = Number(ctx.match[1]);
        const msgId = Number(ctx.match[2]);
        const a = q.getAuction.get(chatId, msgId);

        if (!a) return ctx.answerCbQuery(t('bid.not_found'));
        if (a.status !== 'active') return ctx.answerCbQuery('Only active auctions can be finished');

        await closeAuction(ctx, chatId, msgId);

        await ctx.answerCbQuery(t('admin.finish_success'));
        await ctx.reply(t('admin.finish_success', { title: a.title }));
        await sendAdminPanel(ctx, true);
    });
}

/**
 * Sends or updates the main admin panel message.
 * 
 * @param {import('telegraf').Context} ctx - Telegram context.
 * @param {boolean} isEdit - Whether to edit the existing message instead of sending a new one.
 */
export async function sendAdminPanel(ctx, isEdit = false) {
    const active = q.getAllActiveAuctions.all();
    const finished = q.getRecentlyFinishedAuctions.all();

    let text = t('admin.panel_header') + '\n\n';
    let kb = makeAdminPanelKb();

    if (active.length === 0 && finished.length === 0) {
        text += t('admin.no_auctions_in_db');
    } else {
        text += t('admin.choose_category');
    }

    if (isEdit) {
        try {
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
        } catch (e) {
            if (!e.message.includes('message is not modified')) {
                await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
            }
        }
    } else {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
}

function isAdmin(ctx) {
    const admin = q.getAdmin.get(ctx.from.id);
    return admin && admin.otp_code === null;
}
