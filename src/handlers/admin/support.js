import { q } from '../../services/db.js';
import { t } from '../../services/i18n.js';
import { makeAdminSupportHistoryKb, makeAdminSupportViewKb } from '../../utils/keyboards.js';
import { safeEditMessage, escapeHtml } from '../../utils/utils.js';

export const adminSupportSessions = new Map();

/**
 * Registers admin support-related handlers.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 */
export function registerAdminSupportHandlers(bot) {
    bot.on('callback_query', async (query) => {
        const { data, message } = query;
        
        // Security check: only admins can use adm_support_* and support_reply:* callbacks
        if (data.startsWith('adm_support_') || data.startsWith('support_reply:') || data === 'admin_support_cancel') {
            const admin = q.getAdmin.get(query.from.id);
            if (!admin || admin.otp_code !== null) {
                return bot.answerCallbackQuery(query.id, { text: t('admin.no_permission'), show_alert: true });
            }
        }

        console.log(`[DEBUG] Admin callback: ${data} from ${query.from.id}`);

        if (data.startsWith('support_reply:')) {
            const supportId = parseInt(data.split(':')[1], 10);
            const supportMsg = q.getSupportMessage.get(supportId);

            if (!supportMsg) {
                return bot.answerCallbackQuery(query.id, { text: t('admin.not_found') || 'Not found', show_alert: true });
            }

            await bot.answerCallbackQuery(query.id).catch(() => {});
            
            adminSupportSessions.set(query.from.id, supportId);

            await bot.sendMessage(query.from.id, t('support.reply_prompt', { name: escapeHtml(String(supportMsg.user_name)), user_id: supportMsg.user_id }), {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: t('common.cancel'), callback_data: 'admin_support_cancel' }]]
                }
            });
            return;
        }

        if (data === 'admin_support_cancel') {
            adminSupportSessions.delete(query.from.id);
            await bot.answerCallbackQuery(query.id, { text: t('admin.cancelled') }).catch(() => {});
            await bot.deleteMessage(query.from.id, message.message_id).catch(() => {});
            return;
        }

        if (data === 'adm_support_history') {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            let messages;
            try {
                messages = q.getAllSupportMessages.all();
                console.log(`[DEBUG] Found ${messages?.length} messages for history`);
            } catch (err) {
                console.error(`[ERROR] Failed to fetch support messages:`, err);
                return bot.sendMessage(query.from.id, "Error fetching history from DB").catch(() => {});
            }
            
            const text = (!messages || messages.length === 0) ? t('support.empty') : t('support.history_title');
            const kb = makeAdminSupportHistoryKb(messages || []);
            
            try {
                console.log(`[DEBUG] Attempting to update support history. Previous msg isPhoto: ${!!message.photo}`);
                
                const replyMarkup = kb.reply_markup || kb;

                // Always delete and send new to ensure the keyboard is rendered correctly.
                // Telegram sometimes fails to render keyboards properly when editing messages,
                // especially if switching between media and text.
                await bot.deleteMessage(query.from.id, message.message_id).catch(() => {});
                
                const sentMsg = await bot.sendMessage(query.from.id, text, {
                    reply_markup: replyMarkup,
                    parse_mode: 'HTML'
                });
                console.log(`[DEBUG] History sent successfully. Msg ID: ${sentMsg.message_id}, Rows: ${replyMarkup.inline_keyboard.length}`);
            } catch (err) {
                console.error(`[ERROR] Failed to send history message:`, err);
                console.log(`[DEBUG] KB being sent:`, JSON.stringify(kb));
                // Fallback attempt
                await bot.sendMessage(query.from.id, text, {
                    reply_markup: kb.reply_markup || kb,
                    parse_mode: 'HTML'
                }).catch(e => console.error(`[ERROR] Double failure in support history:`, e));
            }
            return;
        }

        if (data.startsWith('adm_support_view:')) {
            const supportId = parseInt(data.split(':')[1], 10);
            const supportMsg = q.getSupportMessage.get(supportId);

            if (!supportMsg) {
                return bot.answerCallbackQuery(query.id, { text: t('admin.not_found') || 'Not found', show_alert: true });
            }

            await bot.answerCallbackQuery(query.id).catch(() => {});
            
            const date = new Date(supportMsg.created_at).toLocaleString('uk-UA');
            const text = t('support.message_view', {
                name: escapeHtml(String(supportMsg.user_name)),
                user_id: supportMsg.user_id,
                date: date,
                message: escapeHtml(String(supportMsg.message)),
                reply: supportMsg.admin_reply ? escapeHtml(String(supportMsg.admin_reply)) : t('support.no_reply')
            });

            const kb = makeAdminSupportViewKb(supportMsg);
            console.log(`[DEBUG] Support view KB for message ${supportId}:`, JSON.stringify(kb));
            await safeEditMessage(bot, query.from.id, message.message_id, text, {
                reply_markup: kb.reply_markup || kb,
                parse_mode: 'HTML'
            });
            return;
        }
    });
}

/**
 * Handles admin input when in support reply session.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {Object} msg - Message object.
 * @returns {Promise<boolean>} True if message was handled.
 */
export async function handleAdminSupportInput(bot, msg) {
    const adminId = msg.from.id;
    if (!adminSupportSessions.has(adminId)) return false;

    const supportId = adminSupportSessions.get(adminId);
    const text = msg.text?.trim();

    if (!text) return false;

    adminSupportSessions.delete(adminId);

    const supportMsg = q.getSupportMessage.get(supportId);
    if (!supportMsg) return false;

    // Update DB
    q.updateSupportReply.run(text, supportId);

    // Send reply to user
    const userText = t('support.admin_reply_header', {
        user_message: escapeHtml(String(supportMsg.message)),
        admin_message: escapeHtml(String(text))
    });

    try {
        await bot.sendMessage(supportMsg.user_id, userText, { parse_mode: 'HTML' });
        await bot.sendMessage(adminId, t('support.replied'), { parse_mode: 'HTML' });
    } catch (err) {
        console.error('Error sending support reply to user:', err.message);
        await bot.sendMessage(adminId, t('support.reply_error'), { parse_mode: 'HTML' });
    }

    return true;
}
