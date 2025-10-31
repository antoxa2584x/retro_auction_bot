import { q } from '../db.js';
import { makeKb } from '../keyboards.js';
import {ADMIN_ID} from "../env.js";

export function registerAdminHandlers(bot) {
    bot.on('message', async (ctx) => {
        console.log('Auction bot message', ctx.message);
        console.log('Auction bot text', ctx.text);

        const msg = ctx.message;
        if (!msg || !msg.text) return;


        console.log('From', msg.from?.id);

        console.log('ADMIN_ID', ADMIN_ID);

        // must be admin
        if (msg.from?.id !== ADMIN_ID) return;

        // must be reply
        const replied = msg.reply_to_message;

        console.log('Auction replied', replied);

        if (!replied) return;

        // must match command "/undo" or "/undo@YourBot"
        const txt = msg.text.trim();

        console.log('Auction txt', txt);
        console.log('Auction txt', /^\/undo(@\w+)?$/i.test(txt));

        if (!/^\/undo(@\w+)?$/i.test(txt)) return;

        const chatId = msg.chat.id;
        const auctionMsgId = replied.message_id;

        // load auction
        const auction = q.getAuction.get(chatId, auctionMsgId);
        if (!auction) {
            // clean up admin cmd
            try { await ctx.deleteMessage(msg.message_id); } catch {}
            await ctx.reply('Аукціон не знайдено ❌', {
                reply_to_message_id: auctionMsgId
            });
            return;
        }

        // only allow undo if still active
        if (auction.status !== 'active') {
            try { await ctx.deleteMessage(msg.message_id); } catch {}
            await ctx.reply('Аукціон вже завершений 🔒', {
                reply_to_message_id: auctionMsgId
            });
            return;
        }

        // get last bid row
        const lastBid = q.getLastBid.get(chatId, auctionMsgId);
        if (!lastBid) {
            // nothing to undo
            try { await ctx.deleteMessage(msg.message_id); } catch {}
            await ctx.reply('Немає ставок для скасування 💤', {
                reply_to_message_id: auctionMsgId
            });
            return;
        }

        // delete that bid
        q.deleteBidByRowId.run(lastBid.rid);

        // now see what's the new leader after removal
        const newLeader = q.getNewLeader.get(chatId, auctionMsgId);
        const uniqueCount = q.countUniqueParticipants.get(chatId, auctionMsgId);
        const participantsCount = uniqueCount?.cnt ?? 0;

        if (!newLeader) {
            // no bids left at all -> reset auction to min_bid and clear leader
            q.resetAuctionNoBids.run(chatId, auctionMsgId);

            // try to refresh inline keyboard with min_bid and 0 participants
            try {
                await ctx.telegram.editMessageReplyMarkup(
                    chatId,
                    auctionMsgId,
                    undefined,
                    makeKb(chatId, auctionMsgId, auction.min_bid, 0)
                );
            } catch (e) {
                // silently ignore (message might be uneditable)
            }

            // delete admin command message to keep chat clean
            try { await ctx.deleteMessage(msg.message_id); } catch {}

            // public info message
            await ctx.reply(
                '⏪ Останню ставку скасовано. Активних ставок більше немає.',
                { reply_to_message_id: auctionMsgId }
            );

            return;
        }

        // still have bids -> update auction state to new leader
        const leaderName =
            newLeader.first_name
                ? newLeader.first_name + (newLeader.last_name ? ` ${newLeader.last_name}` : '')
                : (newLeader.username ? `@${newLeader.username}` : `ID ${newLeader.user_id}`);

        q.updateState.run(
            newLeader.amount,
            newLeader.user_id,
            leaderName,
            participantsCount,
            chatId,
            auctionMsgId
        );

        // update inline keyboard with new price and participantsCount
        try {
            await ctx.telegram.editMessageReplyMarkup(
                chatId,
                auctionMsgId,
                undefined,
                makeKb(chatId, auctionMsgId, newLeader.amount, participantsCount)
            );
        } catch (e) {
            // ignore edit errors
        }

        // delete admin command message
        try { await ctx.deleteMessage(msg.message_id); } catch {}

        // send public "undo" notification
        await ctx.reply(
            `⏪ Останню ставку скасовано.\nНовий лідер: ${leaderName}\nЦіна: ${newLeader.amount} грн`,
            { reply_to_message_id: auctionMsgId }
        );
    });
}