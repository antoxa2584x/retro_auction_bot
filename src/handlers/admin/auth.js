import { q } from '../../services/db.js';
import { t } from '../../services/i18n.js';

/**
 * Registers handlers for admin authentication (OTP process).
 * 
 * @param {import('telegraf').Telegraf} bot - Telegraf bot instance.
 */
export function registerAuthHandlers(bot) {
    bot.command('admin', async (ctx) => {
        if (ctx.chat.type !== 'private') return;

        const admin = q.getAdmin.get(ctx.from.id);
        if (admin && admin.otp_code === null) {
            return ctx.reply(t('admin.already_admin'));
        }

        const today = new Date().toISOString().split('T')[0];
        const requestCount = q.getOtpRequestsCount.get(ctx.from.id, today)?.count || 0;

        if (requestCount >= 5) {
            return ctx.reply(t('admin.feature_unavailable'));
        }

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString(); // 10 minutes

        q.upsertAdminOtp.run(ctx.from.id, ctx.from.username || null, otp, expiresAt);
        q.incrementOtpRequestsCount.run(ctx.from.id, today);

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
}

/**
 * Handles OTP code input from the user in private messages.
 * 
 * @param {import('telegraf').Context} ctx - Telegram context.
 * @param {string} text - Message text (expected OTP code).
 * @returns {boolean} True if the input was a valid OTP and was processed.
 */
export function handleOtpInput(ctx, text) {
    if (/^\d{6}$/.test(text)) {
        const result = q.verifyOtp.run(ctx.from.id, text, new Date().toISOString());
        if (result.changes > 0) {
            ctx.reply(t('admin.become_admin'));
            return true;
        }
    }
    return false;
}
