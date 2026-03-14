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
        if (admin && admin.otp_code === null) {
            return bot.sendMessage(msg.chat.id, t('admin.already_admin'), { parse_mode: 'HTML' });
        }

        const today = new Date().toISOString().split('T')[0];
        const requestCount = q.getOtpRequestsCount.get(msg.from.id, today)?.count || 0;

        if (requestCount >= 5) {
            return bot.sendMessage(msg.chat.id, t('admin.feature_unavailable'), { parse_mode: 'HTML' });
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

        q.upsertAdminOtp.run(msg.from.id, msg.from.username || null, otp, expiresAt);
        q.incrementOtpRequestsCount.run(msg.from.id, today);

        console.log(`[ADMIN OTP] User ${msg.from.id} (${msg.from.username}): ${otp}`);

        await bot.sendMessage(msg.chat.id, t('admin.enter_otp'), {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: t('common.cancel'), callback_data: 'cancel_otp', style: 'danger' }]]
            }
        });
    });

    bot.on('callback_query', async (query) => {
        if (query.data === 'cancel_otp') {
            const admin = q.getAdmin.get(query.from.id);
            if (admin && admin.otp_code !== null) {
                // Clear OTP if not yet verified
                q.upsertAdminOtp.run(query.from.id, query.from.username || null, null, null);
            }
            await bot.editMessageText(t('admin.otp_cancelled'), {
                chat_id: query.message.chat.id,
                message_id: query.message.message_id
            }).catch(() => {});
            await bot.answerCallbackQuery(query.id, { text: t('admin.cancelled'), show_alert: true });
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
