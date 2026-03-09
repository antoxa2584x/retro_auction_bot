import {getChannelId, TZ} from '../config/env.js';
import {q} from '../services/db.js';
import {makeKb} from '../utils/keyboards.js';
import {parsePost} from '../utils/parse.js';
import {scheduleClose} from '../services/scheduler.js';
import { t } from '../services/i18n.js';

export function registerChannelPostHandler(bot) {
    bot.on('channel_post', async (ctx) => {
        const post = ctx.channelPost;
        const currentChannelId = getChannelId();
        if (!post || post.chat.id !== currentChannelId) return;

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

        q.insertAuction.run({
            chat_id: post.chat.id,
            message_id: post.message_id,
            title,
            full_text: text,
            photo_id: photoId,
            min_bid: minBid,
            step,
            current_price: minBid,
            end_at: end.toISOString()
        });

        const finalKb = makeKb(post.chat.id, post.message_id, minBid, 0);
        await attachKbToMedia(ctx, post, finalKb);

        scheduleClose(ctx, post.chat.id, post.message_id, end);
    });
}

async function attachKbToMedia(ctx, post, kb) {
    try {
        await ctx.telegram.editMessageCaption(
            post.chat.id,
            post.message_id,
            null,
            post.caption,
            {
                reply_markup: kb,
                parse_mode: 'HTML',
                caption_entities: post.caption_entities
            }
        );
    } catch (e) {
        console.log(e);
    }
}
