import { q } from '../../services/db.js';
import { t } from '../../services/i18n.js';

const supportSessions = new Map();

/**
 * Registers support-related handlers.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 */
export function registerSupportHandlers(bot) {
    bot.on('callback_query', async (query) => {
        if (query.data === 'support_contact') {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            
            const chatId = query.message.chat.id;
            supportSessions.set(chatId, true);
            
            await bot.sendMessage(chatId, t('support.welcome'), {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: t('common.cancel'), callback_data: 'support_cancel' }]]
                }
            });
        }

        if (query.data === 'support_cancel') {
            const chatId = query.message.chat.id;
            if (supportSessions.has(chatId)) {
                supportSessions.delete(chatId);
                await bot.answerCallbackQuery(query.id, { text: t('admin.cancelled') }).catch(() => {});
                await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
            }
        }
    });
}

/**
 * Handles user input when in support session.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {Object} msg - Message object.
 * @returns {Promise<boolean>} True if message was handled.
 */
export async function handleSupportInput(bot, msg) {
    const chatId = msg.chat.id;
    if (!supportSessions.has(chatId)) return false;

    const text = msg.text?.trim();
    if (!text) return false;

    supportSessions.delete(chatId);

    const userId = msg.from.id;
    const userName = msg.from.first_name + (msg.from.last_name ? ' ' + msg.from.last_name : '');
    
    // Save to DB
    const res = q.insertSupportMessage.run(userId, userName, text);
    const messageId = res.lastInsertRowid;

    await bot.sendMessage(chatId, t('support.sent'), { parse_mode: 'HTML' });

    // Notify admins
    const admins = q.getAllAdmins.all();
    const adminText = t('support.new_message', {
        name: userName,
        user_id: userId,
        message: text
    });

    const adminKb = {
        inline_keyboard: [[{
            text: t('admin.kb.reply'),
            callback_data: `support_reply:${messageId}`
        }]]
    };

    for (const admin of admins) {
        await bot.sendMessage(admin.user_id, adminText, {
            parse_mode: 'HTML',
            reply_markup: adminKb
        }).catch(() => {});
    }

    return true;
}
