import { q } from '../../services/db.js';
import { getAuctionLink, truncateCaption, formatUserLinkById } from '../../utils/utils.js';
import { formatInTimeZone } from 'date-fns-tz';
import { TZ } from "../../config/env.js";
import { closeAuction } from "../../services/scheduler.js";
import { t, getCurrency } from '../../services/i18n.js';
import { 
    confirmBidKb, 
    makeMyCarouselKb, 
    makeNotifyKb, 
    makeUserMenuKb, 
    makeAdminRestartRequestKb,
    makeUserRestartCancelKb,
    makeUserRestartDurationKb,
    makeUserRestartTimeKb
} from '../../utils/keyboards.js';
import { registerUserPostHandlers, handleUserPostInput } from './post.js';
import { registerSupportHandlers, handleSupportInput } from './support.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'));
const BOT_VERSION = packageJson.version;

/** @type {Map<number, {step: string, data: any}>} */
const restartSessions = new Map();

function formatMyAuctionCaption(a, userId) {
    const link = getAuctionLink(a.chat_id, a.message_id);
    const status = a.leader_id === userId ? t('bid.status_leading') : t('bid.status_outbid');
    const endDate = formatInTimeZone(new Date(a.end_at), TZ, 'dd.MM HH:mm');
    
    const isFinished = a.status === 'finished';
    const cur = getCurrency();
    let priceText;
    
    if (isFinished) {
        if (a.leader_id) {
            priceText = `${t('bid.winner_bid_label')}: <b>${a.current_price} ${cur}</b>`;
        } else {
            priceText = `${t('bid.no_bids')}`;
        }
    } else {
        const currentBidText = q.getSetting.get('AUCTION_CURRENT_BID_TEXT')?.value || t('bid.current_bid_label');
        if (a.leader_id) {
            priceText = `${currentBidText}: <b>${a.current_price} ${cur}</b>`;
        } else {
            priceText = `${t('bid.no_bids')}`;
        }
    }

    let caption = `🔹 <a href="${link}">${a.title}</a>\n` +
           `${priceText}\n` +
           `${t('admin.auction_end_date_text').replace(/^(🕘|📅)\s*/, '')}: <b>${endDate}</b>\n` +
           `Статус: ${status}`;

    if (isFinished && a.leader_id) {
        const winnerLink = formatUserLinkById(a.leader_id, { name: a.leader_name });
        caption += `\n${t('bid.winner_label')}: ${winnerLink}`;
    }

    return truncateCaption(caption);
}

function formatWonAuctionCaption(a) {
    const link = getAuctionLink(a.chat_id, a.message_id);
    const endDate = formatInTimeZone(new Date(a.end_at), TZ, 'dd.MM HH:mm');
    const caption = t('bid.won_item', {
        link: link,
        title: a.title,
        price: a.current_price,
        date: endDate
    });
    return truncateCaption(caption);
}

function formatWatchlistAuctionCaption(a) {
    const link = getAuctionLink(a.chat_id, a.message_id);
    const endDate = formatInTimeZone(new Date(a.end_at), TZ, 'dd.MM HH:mm');
    
    const isFinished = a.status === 'finished';
    const cur = getCurrency();
    let priceText;
    
    if (isFinished) {
        if (a.leader_id) {
            priceText = `${t('bid.winner_bid_label')}: <b>${a.current_price} ${cur}</b>`;
        } else {
            priceText = `${t('bid.no_bids')}`;
        }
    } else {
        const currentBidText = q.getSetting.get('AUCTION_CURRENT_BID_TEXT')?.value || t('bid.current_bid_label');
        if (a.leader_id) {
            priceText = `${currentBidText}: <b>${a.current_price} ${cur}</b>`;
        } else {
            priceText = `${t('bid.no_bids')}`;
        }
    }

    let caption = `🔔 <a href="${link}">${a.title}</a>\n` +
           `${priceText}\n` +
           `${t('admin.auction_end_date_text').replace(/^(🕘|📅)\s*/, '')}: <b>${endDate}</b>`;

    if (isFinished && a.leader_id) {
        const winnerLink = formatUserLinkById(a.leader_id, { name: a.leader_name });
        caption += `\n${t('bid.winner_label')}: ${winnerLink}`;
    }

    return truncateCaption(caption);
}

function formatCreatedAuctionCaption(a) {
    const link = getAuctionLink(a.chat_id, a.message_id);
    const endDate = formatInTimeZone(new Date(a.end_at), TZ, 'dd.MM HH:mm');
    let statusText = a.status === 'active' 
        ? t('bid.created_status_active', { date: endDate })
        : t('bid.created_status_finished', { date: endDate });

    const isFinished = a.status === 'finished';
    const cur = getCurrency();
    let priceText;
    
    if (isFinished) {
        if (a.leader_id) {
            priceText = `${t('bid.winner_bid_label')}: <b>${a.current_price} ${cur}</b>`;
        } else {
            priceText = `${t('bid.no_bids')}`;
        }
    } else {
        const currentBidText = q.getSetting.get('AUCTION_CURRENT_BID_TEXT')?.value || t('bid.current_bid_label');
        if (a.leader_id) {
            priceText = `${currentBidText}: <b>${a.current_price} ${cur}</b>`;
        } else {
            priceText = `${t('bid.no_bids')}`;
        }
    }

    let caption = `👨‍⚖ <a href="${link}">${a.title}</a>\n` +
           `${priceText}\n` +
           `Статус: ${statusText}`;

    if (isFinished && a.leader_id) {
        const winnerLink = formatUserLinkById(a.leader_id, { name: a.leader_name });
        caption += `\n${t('bid.winner_label')}: ${winnerLink}`;
    }

    return truncateCaption(caption);
}

export function registerUserCommands(bot) {
    registerUserPostHandlers(bot);
    bot.on('message', async (msg) => {
        if (msg.chat.type !== 'private') return;
        if (msg.text?.startsWith('/')) return;
        const handled = await handleUserPostInput(bot, msg);
        if (handled) return;

        const supportHandled = await handleSupportInput(bot, msg);
        if (supportHandled) return;

        const restartHandled = await handleUserRestartInput(bot, msg);
        if (restartHandled) return;
    });
    bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
        const payload = match[1];
        const chatId = msg.chat.id;
        bot.deleteMessage(chatId, msg.message_id).catch(() => {});
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
                let messageText = t('bid.confirm_text', {
                    title: row.full_text || row.title,
                    price: newPrice
                });
                if (!msg.from.username) {
                    messageText += `\n\n${t('admin.privacy_warning')}`;
                }
                const replyMarkup = confirmBidKb(targetChatId, targetMessageId, newPrice);
                if (row.photo_id) {
                    await bot.sendPhoto(chatId, row.photo_id, {
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
            }
        } else if (payload && payload.startsWith('notify_')) {
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
                const existing = q.getNotification.get(targetChatId, targetMessageId, msg.from.id);
                const text = existing 
                    ? t('admin.notify_already_set', { title: row.title, hours: existing.hours })
                    : t('admin.notify_welcome', { title: row.title, hours: 1 });
                await bot.sendMessage(chatId, text, {
                    parse_mode: 'HTML',
                    reply_markup: makeNotifyKb(targetChatId, targetMessageId, !!existing)
                });
            }
        } else {
            await bot.sendMessage(chatId, t('bid.welcome'), { parse_mode: 'HTML' });
        }
    });
    bot.onText(/^\/about$/, async (msg) => {
        await bot.sendMessage(msg.chat.id, t('bid.about_text', { version: BOT_VERSION }), { parse_mode: 'HTML' });
    });
    bot.onText(/^\/menu$/, async (msg) => {
        bot.deleteMessage(msg.chat.id, msg.message_id).catch(() => {});
        await bot.sendMessage(msg.chat.id, t('bid.menu_header'), {
            parse_mode: 'HTML',
            reply_markup: makeUserMenuKb()
        });
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
        const replyMarkup = makeMyCarouselKb(0, auctions.length, 'my', a);
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
        const watchlistCarouselMatch = data.match(/^watchlist_(prev|next):(\d+)$/);
        const createdCarouselMatch = data.match(/^created_(prev|next):(\d+)$/);
        if (myCarouselMatch || wonCarouselMatch || watchlistCarouselMatch || createdCarouselMatch) {
            const isWon = !!wonCarouselMatch;
            const isWatchlist = !!watchlistCarouselMatch;
            const isCreated = !!createdCarouselMatch;
            const match = isWon ? wonCarouselMatch : (isWatchlist ? watchlistCarouselMatch : (isCreated ? createdCarouselMatch : myCarouselMatch));
            const action = match[1];
            const currentIndex = parseInt(match[2], 10);
            let auctions, noItemsKey;
            if (isWon) {
                auctions = q.getWonAuctions.all(userId);
                noItemsKey = 'bid.no_won';
            } else if (isWatchlist) {
                auctions = q.getWatchlistAuctions.all(userId);
                noItemsKey = 'bid.no_watchlist';
            } else if (isCreated) {
                auctions = q.getCreatedAuctions.all(userId);
                noItemsKey = 'bid.no_created';
            } else {
                auctions = q.getParticipatingAuctions.all(userId);
                noItemsKey = 'bid.no_my_active';
            }
            if (auctions.length === 0) {
                await bot.answerCallbackQuery(query.id, { text: t(noItemsKey), show_alert: true }).catch(() => {});
                return bot.deleteMessage(chatId, messageId).catch(() => {});
            }
            let nextIndex;
            if (action === 'prev') {
                nextIndex = (currentIndex - 1 + auctions.length) % auctions.length;
            } else {
                nextIndex = (currentIndex + 1) % auctions.length;
            }
            const a = auctions[nextIndex];
            let caption, prefix;
            if (isWon) {
                caption = formatWonAuctionCaption(a);
                prefix = 'won';
            } else if (isWatchlist) {
                caption = formatWatchlistAuctionCaption(a);
                prefix = 'watchlist';
            } else if (isCreated) {
                caption = formatCreatedAuctionCaption(a);
                prefix = 'created';
            } else {
                caption = formatMyAuctionCaption(a, userId);
                prefix = 'my';
            }
            const replyMarkup = makeMyCarouselKb(nextIndex, auctions.length, prefix, a);
            await bot.answerCallbackQuery(query.id).catch(() => {});
            try {
                if (a.photo_id) {
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
                        await bot.deleteMessage(chatId, messageId).catch(() => {});
                        await bot.sendPhoto(chatId, a.photo_id, {
                            caption,
                            parse_mode: 'HTML',
                            reply_markup: replyMarkup
                        });
                    }
                } else {
                    if (message.photo) {
                        await bot.deleteMessage(chatId, messageId).catch(() => {});
                        await bot.sendMessage(chatId, caption, {
                            parse_mode: 'HTML',
                            reply_markup: replyMarkup,
                            disable_web_page_preview: true
                        });
                    } else {
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
            }
            return;
        }
        if (data === 'menu_won' || data === 'menu_my' || data === 'menu_watchlist' || data === 'menu_created') {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            let auctions, noItemsKey, prefix, formatter;
            if (data === 'menu_won') {
                auctions = q.getWonAuctions.all(userId);
                noItemsKey = 'bid.no_won';
                prefix = 'won';
                formatter = formatWonAuctionCaption;
            } else if (data === 'menu_watchlist') {
                auctions = q.getWatchlistAuctions.all(userId);
                noItemsKey = 'bid.no_watchlist';
                prefix = 'watchlist';
                formatter = formatWatchlistAuctionCaption;
            } else if (data === 'menu_created') {
                auctions = q.getCreatedAuctions.all(userId);
                noItemsKey = 'bid.no_created';
                prefix = 'created';
                formatter = formatCreatedAuctionCaption;
            } else {
                auctions = q.getParticipatingAuctions.all(userId);
                noItemsKey = 'bid.no_my_active';
                prefix = 'my';
                formatter = (a) => formatMyAuctionCaption(a, userId);
            }
            if (auctions.length === 0) {
                return bot.sendMessage(chatId, t(noItemsKey), { parse_mode: 'HTML' });
            }
            const a = auctions[0];
            const caption = formatter(a);
            const replyMarkup = makeMyCarouselKb(0, auctions.length, prefix, a);
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
            return;
        }
        if (data.startsWith('request_restart:')) {
            const [, chatIdParam, messageIdParam] = data.split(':');
            const targetChatId = Number(chatIdParam);
            const targetMessageId = Number(messageIdParam);
            const row = q.getAuction.get(targetChatId, targetMessageId);
            if (!row) return bot.answerCallbackQuery(query.id, { text: t('bid.not_found'), show_alert: true });
            
            await bot.answerCallbackQuery(query.id).catch(() => {});
            
            restartSessions.set(userId, {
                step: 'PRICE',
                data: {
                    userId,
                    chatId: targetChatId,
                    msgId: targetMessageId,
                    oldPrice: row.min_bid,
                    oldStep: row.step,
                    title: row.title
                }
            });

            await bot.sendMessage(chatId, t('admin.restart_step_min_bid', { price: row.min_bid }), {
                parse_mode: 'HTML',
                reply_markup: makeUserRestartCancelKb(true)
            });
            return;
        }

        if (data === 'restart_skip') {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            const session = restartSessions.get(userId);
            if (!session) return;

            if (session.step === 'PRICE') {
                session.data.min_bid = session.data.oldPrice;
                session.step = 'STEP';
                await bot.sendMessage(chatId, t('admin.restart_step_step', { step: session.data.oldStep }), {
                    parse_mode: 'HTML',
                    reply_markup: makeUserRestartCancelKb(true)
                });
            } else if (session.step === 'STEP') {
                session.data.step = session.data.oldStep;
                await goToRestartDurationStep(bot, chatId, session);
            }
            return;
        }

        if (data === 'restart_cancel') {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            restartSessions.delete(userId);
            await bot.sendMessage(chatId, t('admin.restart_cancelled'), { parse_mode: 'HTML' });
            return;
        }

        if (data.startsWith('restart_dur:')) {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            const session = restartSessions.get(userId);
            if (!session || session.step !== 'DURATION') return;

            session.data.duration_days = parseInt(data.split(':')[1]);
            await goToRestartTimeStep(bot, chatId, session);
            return;
        }

        if (data.startsWith('restart_time:')) {
            await bot.answerCallbackQuery(query.id).catch(() => {});
            const session = restartSessions.get(userId);
            if (!session || session.step !== 'TIME') return;

            session.data.hour = parseInt(data.split(':')[1]);
            
            // Send request to admins
            const { data: d } = session;
            const admins = q.getAllAdmins.all();
            const link = getAuctionLink(d.chat_id, d.msgId);
            const restartText = t('admin.post_restart_request', {
                user_id: userId,
                name: from.first_name + (from.last_name ? ' ' + from.last_name : ''),
                link: link,
                title: d.title,
                price: d.min_bid,
                step: d.step,
                duration: d.duration_days,
                time: d.hour,
                cur: q.getSetting.get('CURRENCY')?.value || '₴'
            });
            const restartKb = makeAdminRestartRequestKb(userId, d.chatId, d.msgId, d);
            for (const admin of admins) {
                await bot.sendMessage(admin.user_id, restartText, {
                    parse_mode: 'HTML',
                    reply_markup: restartKb
                }).catch(() => {});
            }

            restartSessions.delete(userId);
            await bot.sendMessage(chatId, t('admin.post_restart_sent'), { parse_mode: 'HTML' });
            return;
        }
    });
    registerSupportHandlers(bot);
    bot.onText(/^\/won$/, async (msg) => {
        const userId = msg.from.id;
        const chatId = msg.chat.id;
        const auctions = q.getWonAuctions.all(userId);
        if (auctions.length === 0) {
            return bot.sendMessage(chatId, t('bid.no_won'), { parse_mode: 'HTML' });
        }
        const a = auctions[0];
        const caption = formatWonAuctionCaption(a);
        const replyMarkup = makeMyCarouselKb(0, auctions.length, 'won', a);
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

async function handleUserRestartInput(bot, msg) {
    const userId = msg.from.id;
    const session = restartSessions.get(userId);
    if (!session) return false;

    const text = msg.text;
    const chatId = msg.chat.id;

    if (session.step === 'PRICE') {
        if (!text || isNaN(parseInt(text)) || parseInt(text) < 0) {
            await bot.sendMessage(chatId, t('admin.invalid_number'), { parse_mode: 'HTML' });
            return true;
        }
        session.data.min_bid = parseInt(text);
        session.step = 'STEP';
        await bot.sendMessage(chatId, t('admin.restart_step_step', { step: session.data.oldStep }), {
            parse_mode: 'HTML',
            reply_markup: makeUserRestartCancelKb(true)
        });
        return true;
    }

    if (session.step === 'STEP') {
        if (!text || isNaN(parseInt(text)) || parseInt(text) <= 0) {
            await bot.sendMessage(chatId, t('admin.invalid_number'), { parse_mode: 'HTML' });
            return true;
        }
        session.data.step = parseInt(text);
        await goToRestartDurationStep(bot, chatId, session);
        return true;
    }

    return false;
}

async function goToRestartDurationStep(bot, chatId, session) {
    session.step = 'DURATION';
    await bot.sendMessage(chatId, t('admin.restart_step_duration'), {
        parse_mode: 'HTML',
        reply_markup: makeUserRestartDurationKb()
    });
}

async function goToRestartTimeStep(bot, chatId, session) {
    session.step = 'TIME';
    await bot.sendMessage(chatId, t('admin.restart_step_time'), {
        parse_mode: 'HTML',
        reply_markup: makeUserRestartTimeKb()
    });
}
