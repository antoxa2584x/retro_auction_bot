import { q, placeBidTransaction } from '../../services/db.js';
import { makeKb, confirmBidKb, confirmManualBidKb, makeOutbidKb } from '../../utils/keyboards.js';
import { scheduleClose, closeAuction } from "../../services/scheduler.js";
import { logAuctionNotFound } from '../../services/diagnostics.js';
import { getAuctionLink, truncateCaption } from '../../utils/utils.js';
import { t, getCurrency } from '../../services/i18n.js';
import { formatInTimeZone } from 'date-fns-tz';
import { TZ } from '../../config/env.js';

/**
 * Registers handlers for the bidding process (confirmation and placement).
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 */
export function registerBidHandlers(bot) {
    bot.on('callback_query', async (query) => {
        const { data, message, from } = query;
        const chatId = message.chat.id;
        const messageId = message.message_id;

        if (data === 'cancelbid') {
            await bot.answerCallbackQuery(query.id, { text: t('bid.cancel_bid'), show_alert: true }).catch(() => {});
            return bot.deleteMessage(chatId, messageId).catch(() => {});
        }

        const manualMatch = data.match(/^manualbid:(.+)$/);
        if (manualMatch) {
            const params = manualMatch[1];
            const [targetChatIdStr, targetMsgIdStr] = params.split(':');
            const targetChatId = Number(targetChatIdStr);
            const targetMsgId = Number(targetMsgIdStr);

            try {
                await bot.answerCallbackQuery(query.id).catch(() => {});
            } catch (e) {
                console.error('Error answering manualbid callback:', e.message);
            }
            
            const prompt = await bot.sendMessage(chatId, t('bid.manual_prompt'), {
                reply_markup: { force_reply: true }
            });

            // Reply listeners are kept by the library forever unless removed —
            // consume it on first reply and clean up abandoned prompts after 10 min.
            let cleanupTimer;
            const replyListenerId = bot.onReplyToMessage(chatId, prompt.message_id, async (replyMsg) => {
                bot.removeReplyListener(replyListenerId);
                clearTimeout(cleanupTimer);
                // Reply may be a photo/sticker/etc. with no text — guard before .trim()
                if (!replyMsg.text) {
                    return bot.sendMessage(chatId, t('bid.error_invalid_amount')).catch(() => {});
                }
                const text = replyMsg.text.trim();
                const amountText = text.replace(/[^0-9]/g, '');
                const amount = Number(amountText);
                const cur = getCurrency();

                if (text.includes('.') || text.includes(',')) {
                    return bot.sendMessage(chatId, t('bid.error_invalid_amount'));
                }

                if (isNaN(amount) || amount <= 0 || amountText === '') {
                    return bot.sendMessage(chatId, t('bid.error_invalid_amount'));
                }

                if (amount > Number.MAX_SAFE_INTEGER) {
                    return bot.sendMessage(chatId, t('bid.error_too_high'));
                }

                const auction = q.getAuction.get(targetChatId, targetMsgId);
                if (!auction) {
                    logAuctionNotFound('manual_bid_amount', targetChatId, targetMsgId, { user_id: replyMsg.from.id });
                    return bot.sendMessage(chatId, t('bid.not_found'));
                }

                const minBid = auction.leader_id ? auction.current_price + auction.step : auction.current_price;
                if (amount < minBid) {
                    return bot.sendMessage(chatId, t('bid.error_low_amount', { min: minBid, cur }));
                }

                const messageText = t('bid.confirm_text', {
                    title: auction.full_text || auction.title,
                    price: amount
                });
                const replyMarkup = confirmManualBidKb(targetChatId, targetMsgId, amount);

                if (auction.photo_id) {
                    await bot.sendPhoto(chatId, auction.photo_id, {
                        caption: truncateCaption(messageText),
                        parse_mode: 'HTML',
                        reply_markup: replyMarkup
                    });
                } else {
                    await bot.sendMessage(chatId, messageText, {
                        parse_mode: 'HTML',
                        reply_markup: replyMarkup
                    });
                }
            });
            cleanupTimer = setTimeout(() => bot.removeReplyListener(replyListenerId), 10 * 60 * 1000);
            return;
        }

        const confMatch = data.match(/^confbid:(.+)$/);
        if (confMatch) {
            const params = confMatch[1];
            const [chatIdStr, msgIdStr, priceStr] = params.split(':');
            const target_chat_id = Number(chatIdStr);
            const target_message_id = Number(msgIdStr);
            const price = Number(priceStr);

            const user = from;
            const res = placeBidTransaction(target_chat_id, target_message_id, user, price);

            if (!res.success) {
                if (res.reason === 'not_found') {
                    logAuctionNotFound('bid_confirm', target_chat_id, target_message_id, { user_id: user.id, price });
                    await bot.answerCallbackQuery(query.id, { text: t('bid.not_found'), show_alert: true }).catch(() => {});
                    return bot.deleteMessage(chatId, messageId).catch(() => {});
                }

                if (res.reason === 'finished') {
                    await closeAuction(bot, target_chat_id, target_message_id);
                    await bot.answerCallbackQuery(query.id, { text: t('bid.finished'), show_alert: true }).catch(() => {});
                    await bot.deleteMessage(chatId, messageId).catch(() => {});
                    return;
                }

                if (res.reason === 'price_changed' || res.reason === 'bid_exists') {
                    const expectedPrice = res.expectedPrice;
                    const alertText = res.reason === 'bid_exists' 
                        ? t('bid.bid_exists_alert', { price, expectedPrice })
                        : t('bid.price_changed_alert', { expectedPrice });

                    await bot.answerCallbackQuery(query.id, { text: alertText, show_alert: true }).catch(() => {});
                    
                    const row = q.getAuction.get(target_chat_id, target_message_id);
                    if (!row) {
                        return bot.deleteMessage(chatId, messageId).catch(() => {});
                    }

                    const newText = t('bid.alert_with_details', {
                        alert: alertText,
                        title: row.full_text || row.title,
                        expectedPrice: expectedPrice
                    });
                    const newKb = confirmBidKb(target_chat_id, target_message_id, expectedPrice);

                    if (message.photo) {
                        await bot.editMessageCaption(newText, {
                            chat_id: chatId,
                            message_id: messageId,
                            parse_mode: 'HTML',
                            reply_markup: newKb
                        }).catch(() => {});
                    } else {
                        await bot.editMessageText(newText, {
                            chat_id: chatId,
                            message_id: messageId,
                            parse_mode: 'HTML',
                            reply_markup: newKb
                        }).catch(() => {});
                    }
                    return;
                }

                await bot.answerCallbackQuery(query.id, { text: t('common.error_try_again'), show_alert: true }).catch(() => {});
                return;
            }

            // Success
            // Reschedule the close job FIRST — before any Telegram API round-trips —
            // so the old job can't fire at the previous end time while we are still
            // updating messages (post would show the new time but close at the old one).
            if (res.timeExtended) {
                scheduleClose(bot, target_chat_id, target_message_id, new Date(res.newEndAt));
            }

            await bot.answerCallbackQuery(query.id, { text: t('bid.accepted_alert', { price }), show_alert: true }).catch(() => {});

            // Notify previous leader if outbid
            if (res.previousLeaderId && res.previousLeaderId !== user.id) {
                try {
                    const auctionLink = getAuctionLink(target_chat_id, target_message_id);
                    const outbidText = t('bid.outbid_notify', {
                        link: auctionLink,
                        title: res.auctionTitle,
                        price: price
                    });
                    const nextPrice = price + (res.auctionStep || 0);
                    const outbidKb = makeOutbidKb(target_chat_id, target_message_id, nextPrice);
                    await bot.sendMessage(res.previousLeaderId, outbidText, { 
                        parse_mode: 'HTML',
                        reply_markup: outbidKb
                    });
                } catch (err) {
                    console.error(`Failed to notify previous leader ${res.previousLeaderId}:`, err.message);
                }
            }

            const successText = t('bid.accepted_text', { price });
            if (message.photo) {
                await bot.editMessageCaption(successText, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML'
                });
            } else {
                await bot.editMessageText(successText, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML'
                });
            }

            const kb = makeKb(target_chat_id, target_message_id, price, res.participantsCount);
            // When the timer was extended we rewrite the whole post (text + markup)
            // below in a single edit — so skip the standalone keyboard edit here to
            // avoid a redundant second API round-trip on the same message.
            if (!res.timeExtended) {
                await bot.editMessageReplyMarkup(kb, {
                    chat_id: target_chat_id,
                    message_id: target_message_id
                }).catch(async (err) => {
                    if (err.message.includes('BUTTON_USER_PRIVACY_RESTRICTED')) {
                        // This can happen if makeKb is modified to include user links in buttons
                        console.error(`Privacy restriction when updating keyboard for ${target_chat_id}:${target_message_id}`);
                    } else if (!err.message.includes('message is not modified')) {
                        console.error(`Failed to update keyboard for auction ${target_chat_id}:${target_message_id}:`, err.message);
                    }
                });
            }

            if (res.timeExtended) {
                const auction = q.getAuction.get(target_chat_id, target_message_id);
                if (auction) {
                    const newEndDate = new Date(res.newEndAt);
                    const formattedDate = formatInTimeZone(newEndDate, TZ, 'dd.MM.yyyy HH:mm');
                    
                    // Update the channel post text with new end date
                    // We need to find the old date in the text and replace it.
                    // The text format is usually based on the template.
                    const endDateLabel = q.getSetting.get('AUCTION_END_DATE_TEXT')?.value || t('parse.defaults.end_date');
                    const oldText = auction.full_text;
                    
                    // Find the line starting with the end date label
                    const lines = oldText.split('\n');
                    const newLines = lines.map(line => {
                        if (line.includes(endDateLabel)) {
                            return `${endDateLabel}: <b>${formattedDate}</b>`;
                        }
                        return line;
                    });
                    const newText = newLines.join('\n');
                    
                    try {
                        if (auction.photo_id) {
                            await bot.editMessageCaption(truncateCaption(newText), {
                                chat_id: target_chat_id,
                                message_id: target_message_id,
                                parse_mode: 'HTML',
                                reply_markup: kb
                            });
                        } else {
                            await bot.editMessageText(newText, {
                                chat_id: target_chat_id,
                                message_id: target_message_id,
                                parse_mode: 'HTML',
                                reply_markup: kb
                            });
                        }
                        
                        // Save the updated text back to the DB so subsequent updates don't use the old text
                        q.updateAuctionFullText.run(newText, target_chat_id, target_message_id);

                    } catch (e) {
                        console.error('Error updating extended auction post:', e.message);
                    }
                }
            }
        }
    });
}
