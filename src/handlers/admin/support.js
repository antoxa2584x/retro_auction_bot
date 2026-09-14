import { q } from '../../services/db.js';
import { t } from '../../services/i18n.js';
import { makeAdminSupportHistoryKb, makeAdminSupportViewKb, SUPPORT_HISTORY_PAGE_SIZE } from '../../utils/keyboards.js';
import { safeEditMessage, escapeHtml, parsePhotoIds, sendMessageWithPhotos } from '../../utils/utils.js';

export const adminSupportSessions = new Map();

/** Telegram caps a media group at 10 items, and the first photo carries the text. */
const MAX_REPLY_PHOTOS = 10;

/** How long to wait for the remaining photos of an album before sending. */
const ALBUM_DEBOUNCE_MS = 800;

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

            adminSupportSessions.set(query.from.id, { supportId, photo_ids: [], text: '' });

            await bot.sendMessage(query.from.id, t('support.reply_prompt', { name: escapeHtml(String(supportMsg.user_name)), user_id: supportMsg.user_id }), {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: t('common.cancel'), callback_data: 'admin_support_cancel' }]]
                }
            });
            return;
        }

        if (data === 'admin_support_cancel') {
            // Drop a pending album timer too, or it would deliver the photos
            // collected so far after the admin cancelled.
            const cancelled = adminSupportSessions.get(query.from.id);
            if (cancelled?.timer) clearTimeout(cancelled.timer);
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

        // The detail view is an edited text message, so the stored photos are
        // sent as fresh messages on demand instead of living inside it.
        if (data.startsWith('adm_support_photos:')) {
            const supportId = parseInt(data.split(':')[1], 10);
            const supportMsg = q.getSupportMessage.get(supportId);

            if (!supportMsg) {
                return bot.answerCallbackQuery(query.id, { text: t('admin.not_found') || 'Not found', show_alert: true });
            }

            const userPhotos = parsePhotoIds(supportMsg.photo_ids);
            const replyPhotos = parsePhotoIds(supportMsg.reply_photo_ids);
            if (userPhotos.length === 0 && replyPhotos.length === 0) {
                return bot.answerCallbackQuery(query.id, { text: t('support.no_attachments'), show_alert: true });
            }

            await bot.answerCallbackQuery(query.id).catch(() => {});

            try {
                if (userPhotos.length) {
                    await sendMessageWithPhotos(
                        bot,
                        query.from.id,
                        t('support.attachments_from_user', { name: escapeHtml(String(supportMsg.user_name)) }),
                        userPhotos
                    );
                }
                if (replyPhotos.length) {
                    await sendMessageWithPhotos(
                        bot,
                        query.from.id,
                        t('support.attachments_from_admin'),
                        replyPhotos
                    );
                }
            } catch (err) {
                console.error(`Failed to send support attachments for ${supportId}:`, err.message);
                await bot.sendMessage(query.from.id, t('support.attachments_error'), { parse_mode: 'HTML' }).catch(() => {});
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
            const userPhotos = parsePhotoIds(supportMsg.photo_ids);
            const replyPhotos = parsePhotoIds(supportMsg.reply_photo_ids);
            const messageBody = supportMsg.message && String(supportMsg.message).trim()
                ? escapeHtml(String(supportMsg.message))
                : t('support.photo_only');
            const replyBody = supportMsg.admin_reply && String(supportMsg.admin_reply).trim()
                ? escapeHtml(String(supportMsg.admin_reply))
                : (replyPhotos.length ? t('support.photo_only') : t('support.no_reply'));

            let text = t('support.message_view', {
                name: escapeHtml(String(supportMsg.user_name)),
                user_id: supportMsg.user_id,
                date: date,
                message: messageBody,
                reply: replyBody
            });
            // The photos themselves can't live in an edited text message — the
            // count tells the admin they exist, the button below sends them.
            const totalPhotos = userPhotos.length + replyPhotos.length;
            if (totalPhotos > 0) {
                text += '\n\n' + t('support.attachments', { count: totalPhotos });
            }

            const kb = makeAdminSupportViewKb(supportMsg, page, totalPhotos);
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
 * Delivers the collected reply to the user. Deleting the session is what claims
 * the delivery, so a late album timer and a follow-up message can't send the
 * same reply twice.
 *
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} adminId - Replying admin.
 * @param {Object} session - Collected session state.
 */
async function deliverAdminReply(bot, adminId, session) {
    if (session.timer) {
        clearTimeout(session.timer);
        session.timer = null;
    }
    if (adminSupportSessions.get(adminId) !== session) return;
    adminSupportSessions.delete(adminId);

    const supportMsg = q.getSupportMessage.get(session.supportId);
    if (!supportMsg) return;

    const text = session.text || '';
    const photoIds = session.photo_ids;

    // Atomically close the message. If another admin already replied while this
    // one was typing, `changes` is 0 and we don't send a duplicate reply.
    const updated = q.updateSupportReply.run(
        text,
        photoIds.length ? photoIds.join(',') : null,
        session.supportId
    );
    if (updated.changes === 0) {
        await bot.sendMessage(adminId, t('support.already_answered'), { parse_mode: 'HTML' }).catch(() => {});
        return;
    }

    // Send reply to user
    const userText = t('support.admin_reply_header', {
        user_message: supportMsg.message && String(supportMsg.message).trim()
            ? escapeHtml(String(supportMsg.message))
            : t('support.photo_only'),
        admin_message: text ? escapeHtml(text) : t('support.photo_only')
    });

    try {
        await sendMessageWithPhotos(bot, supportMsg.user_id, userText, photoIds);
        await bot.sendMessage(adminId, t('support.replied'), { parse_mode: 'HTML' });
    } catch (err) {
        console.error('Error sending support reply to user:', err.message);
        await bot.sendMessage(adminId, t('support.reply_error'), { parse_mode: 'HTML' });
    }
}

/**
 * Handles admin input when in support reply session. Accepts plain text, a
 * photo with a caption, or an album of photos.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {Object} msg - Message object.
 * @returns {Promise<boolean>} True if message was handled.
 */
export async function handleAdminSupportInput(bot, msg) {
    const adminId = msg.from.id;
    const session = adminSupportSessions.get(adminId);
    if (!session) return false;

    const photo = msg.photo;
    const text = (msg.caption ?? msg.text ?? '').trim();

    // Nothing usable (a sticker, a voice note): leave the session open so the
    // admin can still send the actual reply.
    if (!photo && !text) return false;

    if (!photo) {
        session.text = text;
        await deliverAdminReply(bot, adminId, session);
        return true;
    }

    if (session.photo_ids.length >= MAX_REPLY_PHOTOS) {
        // One warning per album, not one per photo over the limit.
        if (!session.limit_alert_sent) {
            session.limit_alert_sent = true;
            await bot.sendMessage(adminId, t('support.too_many_photos', { max: MAX_REPLY_PHOTOS }), {
                parse_mode: 'HTML'
            });
        }
        return true;
    }

    session.photo_ids.push(photo[photo.length - 1].file_id);
    // Only one photo of an album carries the caption, and it isn't always the
    // first to arrive — keep the first non-empty one we see.
    if (text && !session.text) session.text = text;

    // An album reaches the bot as separate messages sharing a media_group_id.
    // Wait for the rest so they go out as one reply instead of one per photo.
    if (msg.media_group_id) {
        if (session.timer) clearTimeout(session.timer);
        session.timer = setTimeout(() => {
            deliverAdminReply(bot, adminId, session)
                .catch(e => console.error('Failed to deliver support reply album:', e.message));
        }, ALBUM_DEBOUNCE_MS);
        return true;
    }

    await deliverAdminReply(bot, adminId, session);
    return true;
}
