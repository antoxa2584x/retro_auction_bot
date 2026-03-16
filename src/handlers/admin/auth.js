import { q } from '../../services/db.js';
import { t } from '../../services/i18n.js';

/**
 * Registers handlers for admin authentication (OTP process).
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 */
export function registerAuthHandlers(bot) {
    bot.onText(/^\/admin$/, async (msg) => {
        if (msg.chat.type !== 'private') return;

        const admin = q.getAdmin.get(msg.from.id);
        if (!admin || admin.otp_code !== null) return;

        return bot.sendMessage(msg.chat.id, t('admin.already_admin'), { parse_mode: 'HTML' });
    });

    bot.on('callback_query', async (query) => {
        if (query.data === 'cancel_otp') {
            const admin = q.getAdmin.get(query.from.id);
            if (admin && admin.otp_code !== null) {
                // Remove pending admin record if not yet verified
                q.deleteAdmin.run(query.from.id);
            }
            await bot.editMessageText(t('admin.otp_cancelled'), {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id
            }).catch(() => {});
            return bot.answerCallbackQuery(query.id, { text: t('admin.cancelled'), show_alert: true });
        }
    });
}

/**
 * Handles OTP code input from the user in private messages.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {Object} msg - Telegram message object.
 * @param {string} text - Message text (expected OTP code).
 * @returns {boolean} True if the input was a valid OTP and was processed.
 */
export function handleOtpInput(bot, msg, text) {
    if (/^\d{6}$/.test(text)) {
        const result = q.verifyOtp.run(msg.from.id, text, new Date().toISOString());
        if (result.changes > 0) {
            bot.sendMessage(msg.chat.id, t('admin.become_admin'), { parse_mode: 'HTML' });
            return true;
        }
    }
    return false;
}
