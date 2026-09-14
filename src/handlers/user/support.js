import { q } from '../../services/db.js';
import { t } from '../../services/i18n.js';
import { escapeHtml, sendMessageWithPhotos } from '../../utils/utils.js';

const supportSessions = new Map();

/** Telegram caps a media group at 10 items, and the first photo carries the text. */
const MAX_SUPPORT_PHOTOS = 10;

/** How long to wait for the remaining photos of an album before submitting. */
const ALBUM_DEBOUNCE_MS = 800;

/**
 * Registers support-related handlers.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 */
export function registerSupportHandlers(bot) {
    bot.on('callback_query', async (query) => {
        if (query.data === 'support_contact') {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            
            const chatId = query.message.chat.id;
            supportSessions.set(chatId, { photo_ids: [], text: '' });
            
            await bot.sendMessage(chatId, t('support.welcome'), {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: t('common.cancel'), callback_data: 'support_cancel' }]]
                }
            });
        }

        if (query.data === 'support_cancel') {
            const chatId = query.message.chat.id;
            const session = supportSessions.get(chatId);
            if (session) {
                // Drop a pending album timer too, or it would submit the photos
                // collected so far after the user cancelled.
                if (session.timer) clearTimeout(session.timer);
                supportSessions.delete(chatId);
                await bot.answerCallbackQuery(query.id, { text: t('admin.cancelled') }).catch(() => {});
                await bot.deleteMessage(chatId, query.message.message_id).catch(() => {});
            }
        }
    });
}

/**
 * Files the collected ticket and notifies the admins. Deleting the session is
 * what claims the submission, so a late album timer and a follow-up message
 * can't file the same ticket twice.
 *
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} chatId - User's chat.
 * @param {Object} from - Telegram user who opened the ticket.
 * @param {Object} session - Collected session state.
 */
async function submitSupport(bot, chatId, from, session) {
    if (session.timer) {
        clearTimeout(session.timer);
        session.timer = null;
    }
    if (supportSessions.get(chatId) !== session) return;
    supportSessions.delete(chatId);

    const userId = from.id;
    const userName = from.first_name + (from.last_name ? ' ' + from.last_name : '');
    const text = session.text || '';
    const photoIds = session.photo_ids;

    const res = q.insertSupportMessage.run(
        userId,
        userName,
        text,
        photoIds.length ? photoIds.join(',') : null
    );
    const messageId = res.lastInsertRowid;

    await bot.sendMessage(chatId, t('support.sent'), { parse_mode: 'HTML' });

    // Notify admins. Both the name and the message are user-controlled and go
    // out with parse_mode HTML, so they have to be escaped — an unescaped '<'
    // makes Telegram reject the whole notification.
    const admins = q.getAllAdmins.all();
    const adminText = t('support.new_message', {
        name: escapeHtml(userName),
        user_id: userId,
        message: text ? escapeHtml(text) : t('support.photo_only')
    });

    const adminKb = {
        inline_keyboard: [[{
            text: t('admin.kb.reply'),
            callback_data: `support_reply:${messageId}`
        }]]
    };

    for (const admin of admins) {
        await sendMessageWithPhotos(bot, admin.user_id, adminText, photoIds, {
            reply_markup: adminKb
        }).catch(e => console.error(`Failed to notify admin ${admin.user_id} about support ${messageId}:`, e.message));
    }
}

/**
 * Handles user input when in support session. Accepts plain text, a photo with
 * a caption, or an album of photos.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {Object} msg - Message object.
 * @returns {Promise<boolean>} True if message was handled.
 */
export async function handleSupportInput(bot, msg) {
    const chatId = msg.chat.id;
    const session = supportSessions.get(chatId);
    if (!session) return false;

    const photo = msg.photo;
    const text = (msg.caption ?? msg.text ?? '').trim();

    // Nothing usable (a sticker, a voice note): leave the session open so the
    // user can still send the actual message.
    if (!photo && !text) return false;

    if (!photo) {
        session.text = text;
        await submitSupport(bot, chatId, msg.from, session);
        return true;
    }

    if (session.photo_ids.length >= MAX_SUPPORT_PHOTOS) {
        // One warning per album, not one per photo over the limit.
        if (!session.limit_alert_sent) {
            session.limit_alert_sent = true;
            await bot.sendMessage(chatId, t('support.too_many_photos', { max: MAX_SUPPORT_PHOTOS }), {
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
    // Wait for the rest so they all land on one ticket instead of filing one
    // ticket per photo.
    if (msg.media_group_id) {
        if (session.timer) clearTimeout(session.timer);
        session.timer = setTimeout(() => {
            submitSupport(bot, chatId, msg.from, session)
                .catch(e => console.error('Failed to submit support album:', e.message));
        }, ALBUM_DEBOUNCE_MS);
        return true;
    }

    await submitSupport(bot, chatId, msg.from, session);
    return true;
}
