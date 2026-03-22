import { q } from '../../services/db.js';
import { getAuctionLink } from '../../utils/utils.js';
import { formatInTimeZone } from 'date-fns-tz';
import { TZ } from "../../config/env.js";
import { closeAuction } from "../../services/scheduler.js";
import { t } from '../../services/i18n.js';
import { confirmBidKb, makeMyCarouselKb } from '../../utils/keyboards.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));
const BOT_VERSION = packageJson.version;

/**
 * Formats a single auction for the /my carousel.
 * 
 * @param {Object} a - Auction object.
 * @param {number} userId - User ID.
 * @returns {string} Formatted caption.
 */
function formatMyAuctionCaption(a, userId) {
    const link = getAuctionLink(a.chat_id, a.message_id);
    const status = a.leader_id === userId ? t('bid.status_leading') : t('bid.status_outbid');
    const endDate = formatInTimeZone(new Date(a.end_at), TZ, 'dd.MM HH:mm');

    return `🔹 <a href="${link}">${a.title}</a>\n` +
           `${t('admin.auction_min_bid_text').replace(/^(🔸|💰)\s*/, '')}: <b>${a.current_price} грн</b>\n` +
           `${t('admin.auction_end_date_text').replace(/^(🕘|📅)\s*/, '')}: <b>${endDate}</b>\n` +
           `Статус: ${status}`;
}

/**
 * Formats a single auction for the /won carousel.
 * 
 * @param {Object} a - Auction object.
 * @returns {string} Formatted caption.
 */
function formatWonAuctionCaption(a) {
    const link = getAuctionLink(a.chat_id, a.message_id);
    const endDate = formatInTimeZone(new Date(a.end_at), TZ, 'dd.MM HH:mm');

    return t('bid.won_item', {
        link: link,
        title: a.title,
        price: a.current_price,
        date: endDate
    });
}

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

    bot.onText(/^\/about$/, async (msg) => {
        await bot.sendMessage(msg.chat.id, t('bid.about_text', { version: BOT_VERSION }), { parse_mode: 'HTML' });
    });

    bot.onText(/^\/my$/, async (msg) => {
        const userId = msg.from.id;
        const chatId = msg.chat.id;
        const auctions = q.getParticipatingAuctions.all(userId);

        if (auctions.length === 0) {
            return bot.sendMessage(chatId, t('bid.no_my_active'), { parse_mode: 'HTML' });
        }

        const a = auctions[0];
        const caption = formatMyAuctionCaption(a, userId);
        const replyMarkup = makeMyCarouselKb(0, auctions.length);

        if (a.photo_id) {
            await bot.sendPhoto(chatId, a.photo_id, {
                caption,
                parse_mode: 'HTML',
                reply_markup: replyMarkup
            });
        } else {
            await bot.sendMessage(chatId, caption, {
                parse_mode: 'HTML',
                reply_markup: replyMarkup,
                disable_web_page_preview: true
            });
        }
    });

    bot.on('callback_query', async (query) => {
        const { data, message, from } = query;
        const chatId = message.chat.id;
        const messageId = message.message_id;
        const userId = from.id;

        const myCarouselMatch = data.match(/^my_(prev|next):(\d+)$/);
        const wonCarouselMatch = data.match(/^won_(prev|next):(\d+)$/);

        if (myCarouselMatch || wonCarouselMatch) {
            const isWon = !!wonCarouselMatch;
            const match = isWon ? wonCarouselMatch : myCarouselMatch;
            const action = match[1];
            const currentIndex = parseInt(match[2], 10);
            
            const auctions = isWon ? q.getWonAuctions.all(userId) : q.getParticipatingAuctions.all(userId);
            const noItemsKey = isWon ? 'bid.no_won' : 'bid.no_my_active';

            if (auctions.length === 0) {
                try {
                    await bot.answerCallbackQuery(query.id, { text: t(noItemsKey), show_alert: true });
                } catch (e) {
                    console.error('Error answering carousel empty callback:', e.message);
                }
                return bot.deleteMessage(chatId, messageId).catch(() => {});
            }

            let nextIndex;
            if (action === 'prev') {
                nextIndex = (currentIndex - 1 + auctions.length) % auctions.length;
            } else {
                nextIndex = (currentIndex + 1) % auctions.length;
            }

            if (nextIndex === currentIndex && auctions.length > 1) {
                try {
                    return bot.answerCallbackQuery(query.id);
                } catch (e) {
                    console.error('Error answering carousel same index callback:', e.message);
                    return;
                }
            }

            const a = auctions[nextIndex];
            const caption = isWon ? formatWonAuctionCaption(a) : formatMyAuctionCaption(a, userId);
            const prefix = isWon ? 'won' : 'my';
            const replyMarkup = makeMyCarouselKb(nextIndex, auctions.length, prefix);

            try {
                await bot.answerCallbackQuery(query.id);
            } catch (e) {
                console.error('Error answering carousel update callback:', e.message);
            }

            try {
                if (a.photo_id) {
                    // If the current message has a photo, we can try to edit it
                    if (message.photo) {
                        await bot.editMessageMedia({
                            type: 'photo',
                            media: a.photo_id,
                            caption: caption,
                            parse_mode: 'HTML'
                        }, {
                            chat_id: chatId,
                            message_id: messageId,
                            reply_markup: replyMarkup
                        });
                    } else {
                        // If it was a text message, we must delete and send a new one with photo
                        await bot.deleteMessage(chatId, messageId).catch(() => {});
                        await bot.sendPhoto(chatId, a.photo_id, {
                            caption,
                            parse_mode: 'HTML',
                            reply_markup: replyMarkup
                        });
                    }
                } else {
                    // No photo for the next auction
                    if (message.photo) {
                        // Current has photo, next doesn't - must delete and send text
                        await bot.deleteMessage(chatId, messageId).catch(() => {});
                        await bot.sendMessage(chatId, caption, {
                            parse_mode: 'HTML',
                            reply_markup: replyMarkup,
                            disable_web_page_preview: true
                        });
                    } else {
                        // Both are text
                        await bot.editMessageText(caption, {
                            chat_id: chatId,
                            message_id: messageId,
                            parse_mode: 'HTML',
                            reply_markup: replyMarkup,
                            disable_web_page_preview: true
                        });
                    }
                }
            } catch (err) {
                console.error('Error updating carousel:', err.message);
                // Fallback: if editing fails (e.g. content is the same), just answer callback
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

        const a = auctions[0];
        const caption = formatWonAuctionCaption(a);
        const replyMarkup = makeMyCarouselKb(0, auctions.length, 'won');

        if (a.photo_id) {
            await bot.sendPhoto(chatId, a.photo_id, {
                caption,
                parse_mode: 'HTML',
                reply_markup: replyMarkup
            });
        } else {
            await bot.sendMessage(chatId, caption, {
                parse_mode: 'HTML',
                reply_markup: replyMarkup,
                disable_web_page_preview: true
            });
        }
    });
}
