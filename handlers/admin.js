import { q } from '../db.js';
import { makeKb, makeAdminActiveKb, makeAdminFinishedKb, makeAdminAuctionActionKb, makeAdminSettingsKb } from '../keyboards.js';
import { getAdminId, getChannelId, getAdminNickname, TZ } from "../env.js";
import { formatInTimeZone } from 'date-fns-tz';
import { scheduleClose, closeAuction } from '../scheduler.js';
import { getAuctionLink, escapeHtml } from '../utils.js';

const userSessions = new Map();

export function registerAdminHandlers(bot) {
    bot.command('admin', async (ctx) => {
        if (ctx.chat.type !== 'private') return;

        const admin = q.getAdmin.get(ctx.from.id);
        if (admin && admin.otp_code === null) {
            return ctx.reply('Ви вже є адміністратором. Використовуйте /admin_panel для керування.');
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

        q.upsertAdminOtp.run(ctx.from.id, ctx.from.username || null, otp, expiresAt);

        console.log(`[ADMIN OTP] User ${ctx.from.id} (${ctx.from.username}): ${otp}`);

        await ctx.reply('Введіть OTP код, щоб отримати права адміністратора.', {
            reply_markup: {
                inline_keyboard: [[{ text: '❌ Скасувати', callback_data: 'cancel_otp' }]]
            }
        });
    });

    bot.action('cancel_otp', async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (admin && admin.otp_code !== null) {
            // Clear OTP if not yet verified
            q.upsertAdminOtp.run(ctx.from.id, ctx.from.username || null, null, null);
        }
        await ctx.editMessageText('Введення OTP скасовано.').catch(() => {});
        await ctx.answerCbQuery('Скасовано');
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
                q.setSetting.run(settingKey, text);
                userSessions.delete(ctx.from.id);
                await ctx.reply(`Налаштування <b>${settingKey}</b> оновлено на: <code>${text}</code>`, { parse_mode: 'HTML' });
                await sendSettingsPanel(ctx, false);
            } catch (e) {
                console.error(`[ADMIN SETTINGS ERROR] ${e.message}`);
                await ctx.reply(`Помилка оновлення налаштування: ${e.message}`);
            }
            return;
        }

        // OTP handling
        if (/^\d{6}$/.test(text)) {
            const result = q.verifyOtp.run(ctx.from.id, text, new Date().toISOString());
            if (result.changes > 0) {
                await ctx.reply('Ви тепер адміністратор! Використовуйте /admin_panel для керування.');
                return;
            }
        }
        return next();
    });

    bot.command('admin_panel', async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) {
            return ctx.reply('У вас немає прав доступу до адмін-панелі. Використовуйте /admin для авторизації.');
        }

        await sendAdminPanel(ctx, false);
    });

    bot.action('adm_list', async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery('Недостатньо прав');

        userSessions.delete(ctx.from.id);
        await sendAdminPanel(ctx, true);
        await ctx.answerCbQuery();
    });

    bot.action('adm_settings', async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery('Недостатньо прав');

        await sendSettingsPanel(ctx, true);
        await ctx.answerCbQuery();
    });

    bot.action(/^set_conf:(.+)$/, async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery('Недостатньо прав');

        const key = ctx.match[1];
        userSessions.set(ctx.from.id, key);

        await ctx.reply(`Введіть нове значення для <b>${key}</b>:`, { 
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: '❌ Скасувати', callback_data: 'cancel_settings' }]]
            }
        });
        await ctx.answerCbQuery();
    });

    bot.action('cancel_settings', async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery('Недостатньо прав');

        userSessions.delete(ctx.from.id);
        await ctx.deleteMessage().catch(() => {});
        await sendSettingsPanel(ctx, false);
        await ctx.answerCbQuery('Скасовано');
    });

    bot.action('adm_finished', async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery('Недостатньо прав');

        const auctions = q.getRecentlyFinishedAuctions.all();

        if (auctions.length === 0) {
            await ctx.editMessageText('<b>Панель Адміністратора</b>\n\nНемає завершених аукціонів 💨', {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: '⬅️ Назад до адмін-панелі', callback_data: 'adm_list' }]]
                }
            });
            await ctx.answerCbQuery();
            return;
        }

        await ctx.editMessageText('<b>Панель Адміністратора</b>\n\nНещодавно завершені аукціони:', {
            parse_mode: 'HTML',
            reply_markup: makeAdminFinishedKb(auctions)
        });
        await ctx.answerCbQuery();
    });

    bot.action(/^adm_view:(.+):(.+)$/, async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery('Недостатньо прав');

        const chatId = Number(ctx.match[1]);
        const msgId = Number(ctx.match[2]);
        const a = q.getAuction.get(chatId, msgId);

        if (!a) return ctx.answerCbQuery('Аукціон не знайдено');

        const endDate = formatInTimeZone(new Date(a.end_at), TZ, 'dd.MM.yyyy HH:mm');
        const link = getAuctionLink(chatId, msgId);
        const leader = a.leader_id 
            ? `<a href="tg://user?id=${a.leader_id}">${escapeHtml(a.leader_name)}</a>` 
            : 'немає';

        const text = `<b>Панель Адміністратора</b>\n\n` +
            `📦 <a href="${link}"><b>${a.title}</b></a>\n\n` +
            `Поточна ціна: <b>${a.current_price} грн</b>\n` +
            `Лідер: ${leader}\n` +
            `Кінець: ${endDate}`;

        await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: makeAdminAuctionActionKb(chatId, msgId, a.status)
        });
        await ctx.answerCbQuery();
    });

    bot.action(/^adm_restart:(.+):(.+)$/, async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery('Недостатньо прав');

        const chatId = Number(ctx.match[1]);
        const msgId = Number(ctx.match[2]);
        const a = q.getAuction.get(chatId, msgId);

        if (!a) return ctx.answerCbQuery('Аукціон не знайдено');
        if (a.status !== 'finished') return ctx.answerCbQuery('Можна перезапускати лише завершені аукціони');

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
            return ctx.answerCbQuery('Помилка при створенні нового посту');
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

        await ctx.reply(`Аукціон "${a.title}" перезапущено у новому пості до ${formatInTimeZone(newEnd, TZ, 'dd.MM.yyyy HH:mm')}`);
        await ctx.answerCbQuery('Аукціон перезапущено');
        
        // Return to list
        await sendAdminPanel(ctx, true);
    });

    bot.action(/^adm_finish_now:(.+):(.+)$/, async (ctx) => {
        const admin = q.getAdmin.get(ctx.from.id);
        if (!admin || admin.otp_code !== null) return ctx.answerCbQuery('Недостатньо прав');

        const chatId = Number(ctx.match[1]);
        const msgId = Number(ctx.match[2]);
        const a = q.getAuction.get(chatId, msgId);

        if (!a) return ctx.answerCbQuery('Аукціон не знайдено');
        if (a.status !== 'active') return ctx.answerCbQuery('Можна завершити лише активні аукціони');

        await closeAuction(ctx, chatId, msgId);

        await ctx.answerCbQuery('Аукціон завершено');
        await ctx.reply(`Аукціон "${a.title}" завершено негайно.`);
        
        // Return to list
        await sendAdminPanel(ctx, true);
    });
}

async function sendAdminPanel(ctx, isEdit = false) {
    const active = q.getAllActiveAuctions.all();
    const finished = q.getRecentlyFinishedAuctions.all();

    let text = '<b>Панель Адміністратора</b>\n\n';
    let kb;

    if (active.length === 0 && finished.length === 0) {
        text += 'Аукціонів у базі даних поки що немає 📭';
        kb = { 
            inline_keyboard: [
                [{ text: '🔄 Оновити', callback_data: 'adm_list' }],
                [{ text: '⚙️ Налаштування', callback_data: 'adm_settings' }]
            ] 
        };
    } else if (active.length === 0) {
        text += 'Наразі немає активних аукціонів 💨\n\nВиберіть категорію:';
        kb = makeAdminActiveKb([]);
    } else {
        text += `<b>Активні аукціони (${active.length}):</b>`;
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

    const text = `<b>Панель Адміністратора — Налаштування</b>\n\n` +
        `📺 <b>Channel ID:</b> <code>${channelId}</code>\n` +
        `👤 <b>Admin ID:</b> <code>${adminId}</code>\n` +
        `🏷 <b>Admin Nickname:</b> <code>${adminNickname}</code>\n\n` +
        `<i>Натисніть на кнопку нижче, щоб змінити відповідне налаштування.</i>`;

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

export async function handleUndoMessage(ctx) {
    const post = ctx.channelPost;
    if (!post) return;

    // must be admin
    const currentAdminId = getAdminId();
    if (post.from?.id !== currentAdminId) return;

    // must be reply
    const replied = post.reply_to_message;
    if (!replied) return;

    const chatId = post.chat.id;
    const auctionMsgId = replied.message_id;

    // load auction
    const auction = q.getAuction.get(chatId, auctionMsgId);
    if (!auction) {
        try { await ctx.deleteMessage(post.message_id); } catch {}
        return;
    }

    if (auction.status !== 'active') {
        try { await ctx.deleteMessage(post.message_id); } catch {}
        return;
    }

    const lastBid = q.getLastBid.get(chatId, auctionMsgId);
    if (!lastBid) {
        try { await ctx.deleteMessage(post.message_id); } catch {}
        return;
    }

    q.deleteBidByRowId.run(lastBid.rid);

    const newLeader = q.getNewLeader.get(chatId, auctionMsgId);
    const bidsCount = q.countBids.get(chatId, auctionMsgId);
    const participantsCount = bidsCount?.cnt ?? 0;

    if (!newLeader) {
        q.resetAuctionNoBids.run(chatId, auctionMsgId);
        try {
            await ctx.telegram.editMessageReplyMarkup(
                chatId,
                auctionMsgId,
                undefined,
                makeKb(chatId, auctionMsgId, auction.min_bid, 0)
            );
        } catch (e) {}
        try { await ctx.deleteMessage(post.message_id); } catch {}
        await ctx.reply('⏪ Останню ставку скасовано. Активних ставок більше немає.', { reply_to_message_id: auctionMsgId });
        return;
    }

    const leaderName = newLeader.first_name
        ? newLeader.first_name + (newLeader.last_name ? ` ${newLeader.last_name}` : '')
        : (newLeader.username ? `@${newLeader.username}` : `ID ${newLeader.user_id}`);

    q.updateState.run(newLeader.amount, newLeader.user_id, leaderName, participantsCount, chatId, auctionMsgId);

    try {
        await ctx.telegram.editMessageReplyMarkup(
            chatId,
            auctionMsgId,
            undefined,
            makeKb(chatId, auctionMsgId, newLeader.amount, participantsCount)
        );
    } catch (e) {}

    try { await ctx.deleteMessage(post.message_id); } catch {}
    await ctx.reply(`⏪ Останню ставку скасовано.\nНовий лідер: ${leaderName}\nЦіна: ${newLeader.amount} грн`, { reply_to_message_id: auctionMsgId });
}