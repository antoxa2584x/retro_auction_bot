import { CHANNEL_ID, COMMENTS_ID, TZ } from '../env.js';
import { q } from '../db.js';
import { makeKb } from '../keyboards.js';
import { parsePost } from '../parse.js';
import { scheduleClose } from '../scheduler.js';

export function registerChannelPostHandler(bot) {
    bot.on('channel_post', async (ctx) => {
        const post = ctx.channelPost;
        if (!post || post.chat.id !== CHANNEL_ID) return;

        const text = post.text || post.caption || '';
        let parsed;
        try {
            parsed = parsePost(text, TZ);
        } catch {
            return; // пост не у форматі аукціону — ігноруємо
        }

        const { minBid, step, end } = parsed;
        const discussionId = COMMENTS_ID;
        if (!discussionId) {
            console.warn('No linked discussion group.');
            return;
        }

        const title = text.split('\n')[0] || 'Аукціон';

        q.insertAuction.run({
            chat_id: post.chat.id,
            message_id: post.message_id,
            title,
            min_bid: minBid,
            step,
            current_price: minBid,
            end_at: end.toISOString(),
            discussion_chat_id: discussionId
        });

        const finalKb = makeKb(post.chat.id, post.message_id, minBid);
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
