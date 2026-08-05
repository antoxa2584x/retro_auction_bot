import {getChannelId, TZ, getContactNickname} from '../config/env.js';
import {q} from '../services/db.js';
import {makeKb} from '../utils/keyboards.js';
import {parsePost} from '../utils/parse.js';
import {scheduleClose} from '../services/scheduler.js';
import {verifyAuctionStored} from '../services/diagnostics.js';
import { t } from '../services/i18n.js';

/**
 * Registers a handler for new posts in the auction channel.
 * Parses the post, saves it to the database, and attaches the "Bid" button.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 */
export function registerChannelPostHandler(bot) {
    bot.on('channel_post', async (post) => {
        const currentChannelId = getChannelId();
        if (!post || post.chat.id !== currentChannelId) return;

        // Auctions posted by the bot itself (admin wizard / approval flow) are
        // inserted synchronously the moment they're sent, with the correct
        // keyboard already attached. Telegram still delivers a channel_post
        // update for them — ignore it so we don't double-insert (INSERT OR
        // REPLACE would wipe an existing leader/price) or fight over the
        // keyboard. Only genuinely manually-typed posts (not yet in the DB)
        // are processed below.
        if (q.getAuction.get(post.chat.id, post.message_id)) return;

        const text = post.text || post.caption || '';

        let parsed;
        try {
            parsed = parsePost(text, TZ);
        } catch {
            return; // пост не у форматі аукціону — ігноруємо
        }

        const {minBid, step, end} = parsed;

        const photoId = post.photo ? post.photo[post.photo.length - 1].file_id : null;

        // Extract title: find the first line between "🎮 Аукціон!" and "Мінімальна ставка"
        let title = text.split('\n')[0] || 'Аукціон';
        const auctionMarker = '🎮 Аукціон!';
        const minBidMarker = 'Мінімальна ставка';
        
        const auctionIdx = text.indexOf(auctionMarker);
        const minBidIdx = text.indexOf(minBidMarker);

        if (auctionIdx !== -1 && minBidIdx !== -1 && minBidIdx > auctionIdx) {
            const between = text.substring(auctionIdx + auctionMarker.length, minBidIdx);
            const lines = between.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            if (lines.length > 0) {
                title = lines[0];
            }
        }

        const continuousMinutes = parseInt(q.getSetting.get('CONTINUOUS_MINUTES')?.value || '5');
        const isContinuous = continuousMinutes > 0 ? 1 : 0;

        q.insertAuction.run({
            chat_id: post.chat.id,
            message_id: post.message_id,
            title,
            full_text: text,
            photo_id: photoId,
            photo_ids: photoId ? photoId : null,
            min_bid: minBid,
            step,
            current_price: minBid,
            admin_contact: getContactNickname(),
            end_at: end.toISOString(),
            is_continuous: isContinuous,
            continuous_minutes: continuousMinutes,
            creator_id: null
        });

        verifyAuctionStored('channel_post', post.chat.id, post.message_id, { creator_id: null });

        const finalKb = makeKb(post.chat.id, post.message_id, minBid, 0);
        await attachKbToMedia(bot, post, finalKb);

        scheduleClose(bot, post.chat.id, post.message_id, end);
    });
}

async function attachKbToMedia(bot, post, kb) {
    try {
        if (post.caption) {
            await bot.editMessageCaption(post.caption, {
                chat_id: post.chat.id,
                message_id: post.message_id,
                reply_markup: kb,
                parse_mode: 'HTML',
                caption_entities: post.caption_entities
            });
        } else {
            await bot.editMessageReplyMarkup(kb, {
                chat_id: post.chat.id,
                message_id: post.message_id
            });
        }
    } catch (e) {
        console.log('Error attaching keyboard:', e.message);
    }
}
