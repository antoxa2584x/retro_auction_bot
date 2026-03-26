import { q } from '../services/db.js';
import { registerAuthHandlers, handleOtpInput } from './admin/auth.js';
import { registerSettingsHandlers, handleSettingsInput, userSessions } from './admin/settings.js';
import { registerManageHandlers, sendAdminPanel } from './admin/manage.js';
import { registerPostHandlers, handlePostInput } from './admin/post.js';
import { registerBroadcastHandlers, handleBroadcastInput } from './admin/broadcast.js';
import { t } from '../services/i18n.js';

export function registerAdminHandlers(bot) {
    registerAuthHandlers(bot);
    registerSettingsHandlers(bot);
    registerManageHandlers(bot);
    registerPostHandlers(bot);
    registerBroadcastHandlers(bot);

    // Handle messages (text and photo)
    bot.on('message', async (msg) => {
        if (msg.chat.type !== 'private') return;
        if (msg.text?.startsWith('/')) return; // Let bot.onText handle commands

        console.log(`[Admin Handler] Received message from ${msg.from.id} (${msg.from.username}): ${msg.text || '[media]'}`);

        const text = msg.text?.trim();

        const admin = q.getAdmin.get(msg.from.id);
        const isAdmin = admin && admin.otp_code === null;

        if (!isAdmin) {
            console.log(`[Admin Handler] User ${msg.from.id} is NOT an authenticated admin`);
            if (text) {
                const otpHandled = handleOtpInput(bot, msg, text);
                if (otpHandled) {
                    console.log(`[Admin Handler] OTP input handled for ${msg.from.id}`);
                    return;
                }
            }
            return;
        }

        // Auction posting input handling
        const postHandled = await handlePostInput(bot, msg);
        if (postHandled) {
            return;
        }

        // Broadcast input handling
        const broadcastHandled = await handleBroadcastInput(bot, msg);
        if (broadcastHandled) {
            return;
        }

        // Settings input handling
        if (userSessions.has(msg.from.id)) {
            if (text) {
                const handled = await handleSettingsInput(bot, msg, text);
                if (handled) {
                    return;
                }
            }
        }
    });

    bot.onText(/^\/admin_panel$/, async (msg) => {
        const admin = q.getAdmin.get(msg.from.id);
        if (!admin || admin.otp_code !== null) {
            return bot.sendMessage(msg.chat.id, t('admin.no_permission'), { parse_mode: 'HTML' });
        }

        await sendAdminPanel(bot, msg.chat.id, false);
    });
}
