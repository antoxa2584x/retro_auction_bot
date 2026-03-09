import { q } from '../services/db.js';
import { makeKb, makeAdminActiveKb, makeAdminFinishedKb, makeAdminAuctionActionKb, makeAdminSettingsKb, makeAdminLangKb } from '../utils/keyboards.js';
import { getAdminId, getChannelId, getAdminNickname, TZ } from "../config/env.js";
import { formatInTimeZone } from 'date-fns-tz';
import { scheduleClose, closeAuction } from '../services/scheduler.js';
import { getAuctionLink, escapeHtml } from '../utils/utils.js';
import { t, setLocale, getLocale, setCurrency, getCurrency } from '../services/i18n.js';

const userSessions = new Map();

export function registerAdminHandlers(bot) {
    bot.command('admin', async (ctx) => {
        if (ctx.chat.type !== 'private') return;

        const admin = q.getAdmin.get(ctx.from.id);
        if (admin && admin.otp_code === null) {
            return ctx.reply(t('admin.already_admin'));
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

        q.upsertAdminOtp.run(ctx.from.id, ctx.from.username || null, otp, expiresAt);

        console.log(`[ADMIN OTP] User ${ctx.from.id} (${ctx.from.username}): ${otp}`);

        await ctx.reply(t('admin.enter_otp'), {
            reply_markup: {
                inline_keyboard: [[{ text: t('common.cancel'), callback_data: 'cancel_otp' }]]
            }
        });
    });

    bot.action('cancel_otp', async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (admin && admin.otp_code !== null) {
            // Clear OTP if not yet verified
            q.upsertAdminOtp.run(ctx.from.id, ctx.from.username || null, null, null);
        }
        await ctx.editMessageText(t('admin.otp_cancelled')).catch(() => {});
        await ctx.answerCbQuery(t('admin.cancelled'));
    });

    // Handle OTP code entry and settings input
    bot.on('text', async (ctx, next) => {
        if (ctx.chat.type !== 'private') return next();
        const text = ctx.message.text.trim();

        const admin = q.getAdmin.get(ctx.from.id);
        const isAdmin = admin && admin.otp_code === null;

        // Settings input handling
        if (isAdmin && userSessions.has(ctx.from.id)) {
            console.log(`[ADMIN SETTINGS] User ${ctx.from.id} updating ${userSessions.get(ctx.from.id)} to ${text}`);
            const settingKey = userSessions.get(ctx.from.id);
            try {
                if (settingKey === 'CURRENCY') {
                    setCurrency(text);
                }
                q.setSetting.run(settingKey, text);
                userSessions.delete(ctx.from.id);
                await ctx.reply(t('admin.setting_updated', { key: settingKey, value: text }), { parse_mode: 'HTML' });
                await sendSettingsPanel(ctx, false);
            } catch (e) {
                console.error(`[ADMIN SETTINGS ERROR] ${e.message}`);
                await ctx.reply(t('admin.setting_error', { error: e.message }));
            }
            return;
        }

        // OTP handling
        if (/^\d{6}$/.test(text)) {
            const result = q.verifyOtp.run(ctx.from.id, text, new Date().toISOString());
            if (result.changes > 0) {
                await ctx.reply(t('admin.become_admin'));
                return;
            }
        }
        return next();
    });

    bot.command('admin_panel', async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) {
            return ctx.reply(t('admin.no_permission'));
        }

        await sendAdminPanel(ctx, false);
    });

    bot.action('adm_list', async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        userSessions.delete(ctx.from.id);
        await sendAdminPanel(ctx, true);
        await ctx.answerCbQuery();
    });

    bot.action('adm_settings', async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        await sendSettingsPanel(ctx, true);
        await ctx.answerCbQuery();
    });

    bot.action('adm_lang', async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        const text = t('admin.panel_language') + '\n\n' +
            t('admin.current_language', { lang: getLocale() === 'uk' ? t('admin.lang_uk') : t('admin.lang_en') }) + '\n\n' +
            t('admin.choose_language');

        await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: makeAdminLangKb()
        });
        await ctx.answerCbQuery();
    });

    bot.action('adm_cur', async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        userSessions.set(ctx.from.id, 'CURRENCY');

        const currentCurrency = getCurrency();
        const text = t('admin.panel_currency') + '\n\n' +
            t('admin.current_currency', { cur: currentCurrency }) + '\n\n' +
            t('admin.enter_currency');

        await ctx.reply(text, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: t('common.cancel'), callback_data: 'cancel_settings' }]]
            }
        });
        await ctx.answerCbQuery();
    });

    bot.action(/^set_lang:(.+)$/, async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        const lang = ctx.match[1];
        setLocale(lang);
        q.setSetting.run('LOCALE', lang);

        await ctx.answerCbQuery(t('admin.language_changed'));
        await sendSettingsPanel(ctx, true);
    });

    bot.action(/^set_conf:(.+)$/, async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        const key = ctx.match[1];
        userSessions.set(ctx.from.id, key);

        await ctx.reply(t('admin.enter_new_value', { key }), { 
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: t('common.cancel'), callback_data: 'cancel_settings' }]]
            }
        });
        await ctx.answerCbQuery();
    });

    bot.action('cancel_settings', async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        userSessions.delete(ctx.from.id);
        await ctx.deleteMessage().catch(() => {});
        await sendSettingsPanel(ctx, false);
        await ctx.answerCbQuery(t('admin.cancelled'));
    });

    bot.action('adm_finished', async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

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
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

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
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        const chatId = Number(ctx.match[1]);
        const msgId = Number(ctx.match[2]);
        const a = q.getAuction.get(chatId, msgId);

        if (!a) return ctx.answerCbQuery(t('bid.not_found'));
        if (a.status !== 'finished') return ctx.answerCbQuery('Only finished auctions can be restarted');

        // New end date: current date + 4 days, same time of day as original
        const originalEnd = new Date(a.end_at);
        const newEnd = new Date();
        newEnd.setDate(newEnd.getDate() + 4);
        newEnd.setHours(originalEnd.getHours(), originalEnd.getMinutes(), originalEnd.getSeconds(), originalEnd.getMilliseconds());

        // Update the end date in the full_text
        const newEndStr = formatInTimeZone(newEnd, TZ, 'dd.MM');
        const newTimeStr = formatInTimeZone(newEnd, TZ, 'HH:mm');
        const reEnd = /Завершення\s+аукціону:\s*([0-3]?\d\.[01]?\d)\s*о\s*([0-2]?\d:[0-5]\d)/i;
        const updatedFullText = a.full_text.replace(reEnd, `Завершення аукціону: ${newEndStr} о ${newTimeStr}`);

        let newMsg;
        try {
            const kb = makeKb(chatId, 0, a.min_bid, 0); // Temporary msgId 0
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

        // Update keyboard with correct message_id
        try {
            const finalKb = makeKb(chatId, newMsg.message_id, a.min_bid, 0);
            await ctx.telegram.editMessageReplyMarkup(chatId, newMsg.message_id, undefined, finalKb);
        } catch (e) {
            console.error('Failed to update new post keyboard:', e.message);
        }

        // Insert new auction record
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

        // Reschedule close
        scheduleClose(ctx, chatId, newMsg.message_id, newEnd);

        await ctx.reply(t('admin.restart_success', { 
            title: a.title, 
            date: formatInTimeZone(newEnd, TZ, 'dd.MM.yyyy HH:mm') 
        }));
        await ctx.answerCbQuery(t('admin.finish_success'));
        
        // Return to list
        await sendAdminPanel(ctx, true);
    });

    bot.action(/^adm_finish_now:(.+):(.+)$/, async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        const chatId = Number(ctx.match[1]);
        const msgId = Number(ctx.match[2]);
        const a = q.getAuction.get(chatId, msgId);

        if (!a) return ctx.answerCbQuery(t('bid.not_found'));
        if (a.status !== 'active') return ctx.answerCbQuery('Only active auctions can be finished');

        await closeAuction(ctx, chatId, msgId);

        await ctx.answerCbQuery(t('admin.finish_success'));
        await ctx.reply(t('admin.finish_success', { title: a.title }));
        
        // Return to list
        await sendAdminPanel(ctx, true);
    });
}

async function sendAdminPanel(ctx, isEdit = false) {
    const active = q.getAllActiveAuctions.all();
    const finished = q.getRecentlyFinishedAuctions.all();

    let text = t('admin.panel_header') + '\n\n';
    let kb;

    if (active.length === 0 && finished.length === 0) {
        text += t('admin.no_auctions_in_db');
        kb = { 
            inline_keyboard: [
                [{ text: t('admin.kb.refresh'), callback_data: 'adm_list' }],
                [{ text: t('admin.kb.settings'), callback_data: 'adm_settings' }]
            ] 
        };
    } else if (active.length === 0) {
        text += t('admin.no_active_auctions') + ' 💨\n\n' + t('admin.choose_category');
        kb = makeAdminActiveKb([]);
    } else {
        text += t('admin.active_auctions_header') + ` (${active.length}):`;
        kb = makeAdminActiveKb(active);
    }

    if (isEdit) {
        try {
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb?.reply_markup || kb });
        } catch (e) {
            // fallback if edit fails (e.g. same text)
            if (!e.message.includes('message is not modified')) {
                await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb?.reply_markup || kb });
            }
        }
    } else {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb?.reply_markup || kb });
    }
}

async function sendSettingsPanel(ctx, isEdit = false) {
    const channelId = getChannelId() || 'Not set';
    const adminId = getAdminId() || 'Not set';
    const adminNickname = getAdminNickname();

    const text = t('admin.panel_settings') + '\n\n' +
        `📺 <b>Channel ID:</b> <code>${channelId}</code>\n` +
        `👤 <b>Admin ID:</b> <code>${adminId}</code>\n` +
        `🏷 <b>Admin Nickname:</b> <code>${adminNickname}</code>\n\n` +
        t('admin.click_below_to_change');

    const kb = makeAdminSettingsKb();

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
