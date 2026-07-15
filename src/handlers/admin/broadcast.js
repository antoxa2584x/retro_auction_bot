import { q } from '../../services/db.js';
import { makeAdminBroadcastConfirmKb } from '../../utils/keyboards.js';
import { t } from '../../services/i18n.js';
import { truncateCaption } from '../../utils/utils.js';

export const broadcastSessions = new Map();

/**
 * Registers handlers for broadcast messages.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 */
export function registerBroadcastHandlers(bot) {
    bot.on('callback_query', async (query) => {
        const { data, message, from } = query;
        const chatId = message.chat.id;

        if (data === 'adm_broadcast') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});
            broadcastSessions.set(from.id, { step: 'text' });
            await bot.sendMessage(chatId, t('admin.broadcast_start'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: t('common.cancel'), callback_data: 'broadcast_cancel' }]] } });
        }

        if (data === 'broadcast_skip_img') {
            const session = broadcastSessions.get(from.id);
            if (!session || session.step !== 'image') return;

            try {
                await bot.answerCallbackQuery(query.id).catch(() => {});
            } catch (e) {
                console.error('Error answering broadcast_skip_img callback:', e.message);
            }
            await showBroadcastPreview(bot, chatId, from.id);
        }

        if (data === 'broadcast_confirm') {
            const session = broadcastSessions.get(from.id);
            if (!session || session.step !== 'confirm') return;

            try {
                await bot.answerCallbackQuery(query.id).catch(() => {});
            } catch (e) {
                console.error('Error answering broadcast_confirm callback:', e.message);
            }
            broadcastSessions.delete(from.id);

            const users = q.getAllUsers.all();
            let success = 0;

            const statusMsg = await bot.sendMessage(chatId, t('admin.broadcast_sending', { count: users.length }), { parse_mode: 'HTML' }).catch(() => null);

            const sendOne = async (userId) => {
                if (session.photo_id) {
                    await bot.sendPhoto(userId, session.photo_id, {
                        caption: truncateCaption(session.text),
                        parse_mode: 'HTML'
                    });
                } else {
                    await bot.sendMessage(userId, session.text, { parse_mode: 'HTML' });
                }
            };

            // Send in bounded-concurrency chunks to stay under Telegram's ~30 msg/s
            // global limit. On a 429 we honour retry_after and retry the user once;
            // 403 (user blocked the bot) is logged and skipped, not retried.
            const CHUNK = 25;
            for (let i = 0; i < users.length; i += CHUNK) {
                const slice = users.slice(i, i + CHUNK);
                const results = await Promise.allSettled(slice.map(u => sendOne(u.user_id)));

                let maxRetryAfter = 0;
                for (let j = 0; j < results.length; j++) {
                    if (results[j].status === 'fulfilled') { success++; continue; }
                    const err = results[j].reason;
                    const code = err?.response?.statusCode;
                    if (code === 429) {
                        maxRetryAfter = Math.max(maxRetryAfter, err?.response?.body?.parameters?.retry_after || 1);
                    } else {
                        // 403 = blocked by user, or any other terminal error
                        console.error(`Failed to send broadcast to ${slice[j].user_id}:`, err?.message);
                    }
                }

                if (maxRetryAfter > 0) {
                    // Hit the rate limit — back off, then retry just the throttled users.
                    await new Promise(r => setTimeout(r, (maxRetryAfter + 1) * 1000));
                    const retryResults = await Promise.allSettled(
                        results
                            .map((res, idx) => ({ res, idx }))
                            .filter(({ res }) => res.status === 'rejected' && res.reason?.response?.statusCode === 429)
                            .map(({ idx }) => sendOne(slice[idx].user_id))
                    );
                    for (const r of retryResults) {
                        if (r.status === 'fulfilled') success++;
                        else console.error('Broadcast retry failed:', r.reason?.message);
                    }
                }

                if (i + CHUNK < users.length) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }

            if (statusMsg) {
                await bot.editMessageText(t('admin.broadcast_success', { success, total: users.length }), {
                    chat_id: chatId,
                    message_id: statusMsg.message_id,
                    parse_mode: 'HTML'
                }).catch(() => {});
            }
        }

        if (data === 'broadcast_cancel') {
            broadcastSessions.delete(from.id);
            try {
                await bot.answerCallbackQuery(query.id).catch(() => {});
            } catch (e) {
                console.error('Error answering broadcast_cancel callback:', e.message);
            }
            await bot.sendMessage(chatId, t('admin.broadcast_cancelled'));
        }
    });
}

/**
 * Handles message input for broadcast creation.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {Object} msg - Telegram message object.
 * @returns {Promise<boolean>} True if message was handled as broadcast input.
 */
export async function handleBroadcastInput(bot, msg) {
    const userId = msg.from.id;
    const session = broadcastSessions.get(userId);

    if (!session) return false;

    if (session.step === 'text') {
        if (!msg.text) return false;
        session.text = msg.text;
        session.step = 'image';
        await bot.sendMessage(msg.chat.id, t('admin.broadcast_step_img'), {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: t('admin.kb.skip'), callback_data: 'broadcast_skip_img' }]]
            }
        });
        return true;
    }

    if (session.step === 'image') {
        if (msg.photo) {
            session.photo_id = msg.photo[msg.photo.length - 1].file_id;
            await showBroadcastPreview(bot, msg.chat.id, userId);
            return true;
        }
    }

    return false;
}

async function showBroadcastPreview(bot, chatId, userId) {
    const session = broadcastSessions.get(userId);
    session.step = 'confirm';
    const usersCount = q.countUsers.get().cnt;

    const confirmText = t('admin.broadcast_confirm', { text: session.text, count: usersCount });
    const kb = makeAdminBroadcastConfirmKb();

    if (session.photo_id) {
        await bot.sendPhoto(chatId, session.photo_id, {
            caption: truncateCaption(confirmText),
            parse_mode: 'HTML',
            reply_markup: kb
        });
    } else {
        await bot.sendMessage(chatId, confirmText, {
            parse_mode: 'HTML',
            reply_markup: kb
        });
    }
}

function isAdmin(userId) {
    const admin = q.getAdmin.get(userId);
    return admin && admin.otp_code === null;
}
