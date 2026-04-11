import { q } from '../../services/db.js';
import { t } from '../../services/i18n.js';
import { scheduleOneCustomNotification } from '../../services/scheduler.js';

/**
 * Registers callback handlers for the Notify feature.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 */
export function registerNotificationHandlers(bot) {
    bot.on('callback_query', async (query) => {
        const { data, message, from } = query;
        if (!data) return;

        const chatId = message.chat.id;
        const messageId = message.message_id;

        if (data === 'cancel_notify') {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            return bot.deleteMessage(chatId, messageId).catch(() => {});
        }

        const setMatch = data.match(/^set_notify:(.+)$/);
        if (setMatch) {
            const [targetChatId, targetMessageId, hours] = setMatch[1].split(':').map(Number);
            
            const auction = q.getAuction.get(targetChatId, targetMessageId);
            if (!auction || auction.status !== 'active') {
                await bot.answerCallbackQuery(query.id, { text: t('bid.finished'), show_alert: true }).catch(() => {});
                return bot.deleteMessage(chatId, messageId).catch(() => {});
            }

            const now = new Date();
            const end = new Date(auction.end_at);
            const diffMs = end - now;
            const diffHours = diffMs / (1000 * 60 * 60);

            if (hours > diffHours || hours > 12 || hours < 1) {
                return bot.answerCallbackQuery(query.id, { 
                    text: t('admin.notify_error_time'), 
                    show_alert: true 
                }).catch(() => {});
            }

            q.setNotification.run(targetChatId, targetMessageId, from.id, hours);
            scheduleOneCustomNotification(bot, targetChatId, targetMessageId, from.id, hours, end);
            
            await bot.answerCallbackQuery(query.id, { 
                text: t('admin.notify_set_success', { hours }), 
                show_alert: true 
            }).catch(() => {});
            return bot.deleteMessage(chatId, messageId).catch(() => {});
        }

        const remMatch = data.match(/^rem_notify:(.+)$/);
        if (remMatch) {
            const [targetChatId, targetMessageId] = remMatch[1].split(':').map(Number);
            
            q.deleteNotification.run(targetChatId, targetMessageId, from.id);
            
            await bot.answerCallbackQuery(query.id, { 
                text: t('admin.notify_removed'), 
                show_alert: true 
            }).catch(() => {});
            return bot.deleteMessage(chatId, messageId).catch(() => {});
        }
    });
}
