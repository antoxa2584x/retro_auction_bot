import crypto from 'crypto';
import { q } from '../../services/db.js';
import { t } from '../../services/i18n.js';
import { escapeHtml } from '../../utils/utils.js';

// In-memory failed-verification counter (user_id -> count). Caps brute-force
// guessing of the 6-digit OTP within its 10-minute window. Reset on success,
// lockout, or process restart.
const otpAttempts = new Map();
const MAX_OTP_ATTEMPTS = 5;

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

        const otp = crypto.randomInt(100000, 1000000).toString();
        otpAttempts.delete(msg.from.id); // fresh code → reset any prior failed attempts
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

        q.upsertAdminOtp.run(
            msg.from.id, 
            msg.from.username || null, 
            msg.from.first_name || null, 
            msg.from.last_name || null, 
            otp, 
            expiresAt
        );
        q.incrementOtpRequestsCount.run(msg.from.id, today);

        console.log(`[ADMIN OTP] User ${msg.from.id} (${msg.from.username}): ${otp}`);

        await bot.sendMessage(msg.chat.id, t('admin.enter_otp'), {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: t('common.cancel'), callback_data: 'cancel_otp' }]]
            }
        });
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
            try {
                return bot.answerCallbackQuery(query.id, { text: t('admin.cancelled'), show_alert: true });
            } catch (e) {
                console.error('Error answering cancel_otp callback:', e.message);
                return;
            }
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
        const userId = msg.from.id;

        // Only entertain guesses when there is actually a pending OTP for this
        // user — avoids counting random 6-digit messages from non-admins.
        const pending = q.getAdmin.get(userId);
        if (!pending || pending.otp_code === null) return false;

        const result = q.verifyOtp.run(userId, text, new Date().toISOString());
        if (result.changes === 0) {
            // Wrong/expired code — throttle brute force.
            const attempts = (otpAttempts.get(userId) || 0) + 1;
            if (attempts >= MAX_OTP_ATTEMPTS) {
                otpAttempts.delete(userId);
                q.deleteAdmin.run(userId); // invalidate the pending OTP record
                bot.sendMessage(msg.chat.id, t('admin.otp_too_many_attempts'), { parse_mode: 'HTML' }).catch(() => {});
                return true;
            }
            otpAttempts.set(userId, attempts);
            return false;
        }

        otpAttempts.delete(userId);
        {
            // Notify other admins
            const otherAdmins = q.getAllAdmins.all();
            const newAdminName = msg.from.first_name ? (msg.from.last_name ? `${msg.from.first_name} ${msg.from.last_name}` : msg.from.first_name)
                : (msg.from.username ? `@${msg.from.username}` : `ID ${msg.from.id}`);

            for (const admin of otherAdmins) {
                if (admin.user_id !== msg.from.id) {
                    bot.sendMessage(admin.user_id, t('admin.new_admin_notify', {
                        user_id: msg.from.id,
                        name: escapeHtml(newAdminName),
                        added_by_id: msg.from.id,
                        added_by_name: escapeHtml(newAdminName)
                    }), { parse_mode: 'HTML' }).catch(() => {});
                }
            }

            bot.sendMessage(msg.chat.id, t('admin.become_admin'), { parse_mode: 'HTML' });
            return true;
        }
    }
    return false;
}
