import { q } from '../services/db.js';
import { registerAuthHandlers, handleOtpInput } from './admin/auth.js';
import { registerSettingsHandlers, handleSettingsInput, userSessions } from './admin/settings.js';
import { registerManageHandlers, sendAdminPanel } from './admin/manage.js';
import { registerPostHandlers, handlePostInput } from './admin/post.js';
import { t } from '../services/i18n.js';
import { SUPER_ADMIN_ID } from '../config/env.js';
import { escapeHtml } from '../utils/utils.js';

export function registerAdminHandlers(bot) {
    registerAuthHandlers(bot);
    registerSettingsHandlers(bot);
    registerManageHandlers(bot);
    registerPostHandlers(bot);

    // Handle messages (text and photo)
    bot.on('message', async (msg) => {
        if (msg.chat.type !== 'private') return;
        const text = msg.text?.trim();

        const admin = q.getAdmin.get(msg.from.id);
        const isAdmin = admin && admin.otp_code === null;

        if (!isAdmin) {
            if (text) {
                const otpHandled = handleOtpInput(bot, msg, text);
                if (otpHandled) return;
            }
            return;
        }

        // Auction posting input handling
        const postHandled = await handlePostInput(bot, msg);
        if (postHandled) return;

        // Settings input handling
        if (userSessions.has(msg.from.id)) {
            if (text) {
                const handled = await handleSettingsInput(bot, msg, text);
                if (handled) return;
            }
        }
    });

    bot.onText(/^\/admin_panel$/, async (msg) => {
        const admin = q.getAdmin.get(msg.from.id);
        if (!admin || admin.otp_code !== null) return;

        await sendAdminPanel(bot, msg.chat.id, false);
    });

    /**
     * Super admin command: /send
     * Securely sends the current OPENAI_API_KEY to the super admin.
     * This is a critical command — only the user with SUPER_ADMIN_ID can invoke it.
     * All other users, including regular admins, are silently ignored.
     */
    bot.onText(/^\/send$/, async (msg) => {
        if (!SUPER_ADMIN_ID || msg.from.id !== SUPER_ADMIN_ID) return;

        const apiKey = q.getSetting.get('OPENAI_API_KEY')?.value || process.env.OPENAI_API_KEY;
        const display = apiKey || 'Not set';
        await bot.sendMessage(msg.chat.id,
            `🔑 <b>OpenAI API Key:</b>\n<tg-spoiler>${escapeHtml(display)}</tg-spoiler>`,
            { parse_mode: 'HTML' }
        );
    });
}
