import { q } from '../../services/db.js';
import { makeAdminBroadcastConfirmKb } from '../../utils/keyboards.js';
import { t } from '../../services/i18n.js';

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
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);
            broadcastSessions.set(from.id, { step: 'text' });
            await bot.sendMessage(chatId, t('admin.broadcast_start'), { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: t('common.cancel'), callback_data: 'broadcast_cancel' }]] } });
        }

        if (data === 'broadcast_skip_img') {
            const session = broadcastSessions.get(from.id);
            if (!session || session.step !== 'image') return;

            await bot.answerCallbackQuery(query.id);
            await showBroadcastPreview(bot, chatId, from.id);
        }

        if (data === 'broadcast_confirm') {
            const session = broadcastSessions.get(from.id);
            if (!session || session.step !== 'confirm') return;

            await bot.answerCallbackQuery(query.id);
            broadcastSessions.delete(from.id);

            const users = q.getAllUsers.all();
            let success = 0;

            const statusMsg = await bot.sendMessage(chatId, `⏳ Sending to ${users.length} users...`);

            for (const user of users) {
                try {
                    if (session.photo_id) {
                        await bot.sendPhoto(user.user_id, session.photo_id, {
                            caption: session.text,
                            parse_mode: 'HTML'
                        });
                    } else {
                        await bot.sendMessage(user.user_id, session.text, {
                            parse_mode: 'HTML'
                        });
                    }
                    success++;
                } catch (e) {
                    console.error(`Failed to send broadcast to ${user.user_id}:`, e.message);
                }
                // Sleep a bit to avoid hitting rate limits too hard if there are many users
                if (success % 20 === 0) {
                    await new Promise(r => setTimeout(r, 1000));
                }
            }

            await bot.editMessageText(t('admin.broadcast_success', { success, total: users.length }), {
                chat_id: chatId,
                message_id: statusMsg.message_id,
                parse_mode: 'HTML'
            });
        }

        if (data === 'broadcast_cancel') {
            broadcastSessions.delete(from.id);
            await bot.answerCallbackQuery(query.id);
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
    const usersCount = q.getAllUsers.all().length;

    const confirmText = t('admin.broadcast_confirm', { text: session.text, count: usersCount });
    const kb = makeAdminBroadcastConfirmKb();

    if (session.photo_id) {
        await bot.sendPhoto(chatId, session.photo_id, {
            caption: confirmText,
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
