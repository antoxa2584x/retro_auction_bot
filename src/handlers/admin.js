import { q } from '../services/db.js';
import { registerAuthHandlers, handleOtpInput } from './admin/auth.js';
import { registerSettingsHandlers, handleSettingsInput, userSessions } from './admin/settings.js';
import { registerManageHandlers, sendAdminPanel } from './admin/manage.js';
import { registerPostHandlers, handlePostInput } from './admin/post.js';
import { t } from '../services/i18n.js';

export function registerAdminHandlers(bot) {
    registerAuthHandlers(bot);
    registerSettingsHandlers(bot);
    registerManageHandlers(bot);
    registerPostHandlers(bot);

    // Handle OTP code entry and settings input
    bot.on(['text', 'photo'], async (ctx, next) => {
        if (ctx.chat.type !== 'private') return next();
        const text = ctx.message?.text?.trim();

        const admin = q.getAdmin.get(ctx.from.id);
        const isAdmin = admin && admin.otp_code === null;

        if (!isAdmin) {
            if (text) {
                const otpHandled = handleOtpInput(ctx, text);
                if (otpHandled) return;
            }
            return next();
        }

        // Auction posting input handling
        const postHandled = await handlePostInput(ctx);
        if (postHandled) return;

        // Settings input handling
        if (userSessions.has(ctx.from.id)) {
            if (text) {
                const handled = await handleSettingsInput(ctx, text);
                if (handled) return;
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
}
