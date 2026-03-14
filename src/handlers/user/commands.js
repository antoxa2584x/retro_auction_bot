import { q } from '../../services/db.js';
import { getAuctionLink } from '../../utils/utils.js';
import { formatInTimeZone } from 'date-fns-tz';
import { TZ } from "../../config/env.js";
import { closeAuction } from "../../services/scheduler.js";
import { t } from '../../services/i18n.js';
import { confirmBidKb } from '../../utils/keyboards.js';

/**
 * Registers user commands (/start, /my, /won).
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 */
export function registerUserCommands(bot) {
    bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
        const payload = match[1];
        const chatId = msg.chat.id;

        if (payload && payload.startsWith('bid_')) {
            const parts = payload.split('_');
            if (parts.length === 3) {
                const targetChatId = -Math.abs(Number(parts[1]));
                const targetMessageId = Number(parts[2]);

                const row = q.getAuction.get(targetChatId, targetMessageId);
                if (!row) return bot.sendMessage(chatId, t('bid.not_found'), { parse_mode: 'HTML' });

                const now = new Date();
                const end = new Date(row.end_at);
                if (now >= end || row.status !== 'active') {
                    await closeAuction(bot, targetChatId, targetMessageId);
                    return bot.sendMessage(chatId, t('bid.finished'), { parse_mode: 'HTML' });
                }

                const newPrice = row.leader_id ? row.current_price + row.step : row.current_price;
                const messageText = t('bid.confirm_text', {
                    title: row.full_text || row.title,
                    price: newPrice
                });
                const replyMarkup = confirmBidKb(targetChatId, targetMessageId, newPrice);

                if (row.photo_id) {
                    await bot.sendPhoto(chatId, row.photo_id, {
                        caption: messageText,
                        parse_mode: 'HTML',
                        reply_markup: replyMarkup
                    });
                } else {
                    await bot.sendMessage(chatId, messageText, {
                        parse_mode: 'HTML',
                        reply_markup: replyMarkup
                    });
                }
            }
        } else {
            await bot.sendMessage(chatId, t('bid.welcome'), { parse_mode: 'HTML' });
        }
    });

    bot.onText(/^\/my$/, async (msg) => {
        const userId = msg.from.id;
        const chatId = msg.chat.id;
        const auctions = q.getParticipatingAuctions.all(userId);

        if (auctions.length === 0) {
            return bot.sendMessage(chatId, t('bid.no_my_active'), { parse_mode: 'HTML' });
        }

        await bot.sendMessage(chatId, t('bid.my_active_header'), { parse_mode: 'HTML' });

        for (const a of auctions) {
            const link = getAuctionLink(a.chat_id, a.message_id);
            const status = a.leader_id === userId ? t('bid.status_leading') : t('bid.status_outbid');
            const endDate = formatInTimeZone(new Date(a.end_at), TZ, 'dd.MM HH:mm');
            
            const caption = `🔹 <a href="${link}">${a.title}</a>\n` +
                          `Поточна ціна: <b>${a.current_price} грн</b>\n` +
                          `Завершення: <b>${endDate}</b>\n` +
                          `Статус: ${status}`;

            if (a.photo_id) {
                await bot.sendPhoto(chatId, a.photo_id, {
                    caption,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
            } else {
                await bot.sendMessage(chatId, caption, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                });
            }
        }
    });

    bot.onText(/^\/won$/, async (msg) => {
        const userId = msg.from.id;
        const chatId = msg.chat.id;
        const auctions = q.getWonAuctions.all(userId);

        if (auctions.length === 0) {
            return bot.sendMessage(chatId, t('bid.no_won'), { parse_mode: 'HTML' });
        }

        let text = t('bid.won_header');
        for (const a of auctions) {
            const link = getAuctionLink(a.chat_id, a.message_id);
            const endDate = formatInTimeZone(new Date(a.end_at), TZ, 'dd.MM HH:mm');
            text += t('bid.won_item', {
                link: link,
                title: a.title,
                price: a.current_price,
                date: endDate
            });
        }

        await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
    });
}
