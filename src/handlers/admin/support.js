import { q } from '../../services/db.js';
import { t } from '../../services/i18n.js';
import { makeAdminSupportHistoryKb, makeAdminSupportViewKb, SUPPORT_HISTORY_PAGE_SIZE } from '../../utils/keyboards.js';
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

            // Don't open a reply session if another admin already answered it.
            if (supportMsg.status !== 'open') {
                await bot.answerCallbackQuery(query.id, { text: t('support.already_answered'), show_alert: true }).catch(() => {});
                await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                    chat_id: query.from.id,
                    message_id: message.message_id
                }).catch(() => {});
                return;
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

        // Bare 'adm_support_history' is the entry point from the admin panel;
        // the ':<page>' form comes from the pager and the detail view's back button.
        if (data === 'adm_support_history' || data.startsWith('adm_support_history:')) {
            await bot.answerCallbackQuery(query.id).catch(() => {});

            let page = Math.max(0, parseInt(data.split(':')[1], 10) || 0);
            let messages;
            let totalCount;
            try {
                totalCount = q.countSupportMessages.get().count;
                // A page can fall off the end if messages were removed since the
                // keyboard was drawn — clamp instead of showing an empty list.
                const lastPage = Math.max(0, Math.ceil(totalCount / SUPPORT_HISTORY_PAGE_SIZE) - 1);
                if (page > lastPage) page = lastPage;

                messages = q.getSupportMessagesPaginated.all(SUPPORT_HISTORY_PAGE_SIZE, page * SUPPORT_HISTORY_PAGE_SIZE);
                console.log(`[DEBUG] Found ${messages?.length} messages for history page ${page} of ${totalCount} total`);
            } catch (err) {
                console.error(`[ERROR] Failed to fetch support messages:`, err);
                return bot.sendMessage(query.from.id, "Error fetching history from DB").catch(() => {});
            }
            
            const text = (!messages || messages.length === 0) ? t('support.empty') : t('support.history_title');
            const kb = makeAdminSupportHistoryKb(messages || [], page, totalCount);
            
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
            const [, idParam, pageParam] = data.split(':');
            const supportId = parseInt(idParam, 10);
            const page = Math.max(0, parseInt(pageParam, 10) || 0);
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

            const kb = makeAdminSupportViewKb(supportMsg, page);
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

    // Atomically close the message. If another admin already replied while this
    // one was typing, `changes` is 0 and we don't send a duplicate reply.
    const updated = q.updateSupportReply.run(text, supportId);
    if (updated.changes === 0) {
        await bot.sendMessage(adminId, t('support.already_answered'), { parse_mode: 'HTML' }).catch(() => {});
        return true;
    }

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
