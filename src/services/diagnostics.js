import { q } from './db.js';
import { logInfo, logWarn, logError } from './logger.js';
import { getChannelId } from '../config/env.js';

/**
 * The key the channel buttons will use to find an auction. The deep-link payload
 * carries the chat id without its sign (see makeKb) and the /start handler
 * rebuilds it as `-Math.abs(...)`, so a row stored under any other form of the
 * same id is posted to the channel but unreachable from its own buttons.
 *
 * @param {number} chatId
 * @returns {number} Chat id as the bid/notify deep links will reconstruct it.
 */
export function deepLinkChatId(chatId) {
    return -Math.abs(Number(chatId));
}

/**
 * Verifies that a freshly posted auction is actually readable from the database,
 * both by the key it was written with and by the key its buttons will use.
 *
 * Called right after the insert: the auction is already live in the channel at
 * this point, so a miss here is the "posted but not found" bug and needs to be on
 * disk with the ids needed to clean it up.
 *
 * @param {string} source - Which flow created it, e.g. 'pending_approval'.
 * @param {number} chatId - Chat id the row was inserted with.
 * @param {number} messageId - Message id of the channel post.
 * @param {Object} [extra] - Extra context (pending id, creator, end date, ...).
 * @returns {boolean} True when the row is reachable both ways.
 */
export function verifyAuctionStored(source, chatId, messageId, extra = {}) {
    const linkChatId = deepLinkChatId(chatId);
    const context = { source, chat_id: chatId, message_id: messageId, deep_link_chat_id: linkChatId, ...extra };

    let stored = null;
    let storedByLink = null;
    try {
        stored = q.getAuction.get(chatId, messageId);
        storedByLink = linkChatId === chatId ? stored : q.getAuction.get(linkChatId, messageId);
    } catch (e) {
        logError('auction_verify_failed', { ...context, error: e });
        return false;
    }

    if (!stored) {
        logError('auction_row_missing_after_insert', context);
        return false;
    }
    if (!storedByLink) {
        // Row exists, but under an id the buttons can't reconstruct.
        logError('auction_row_unreachable_by_deep_link', context);
        return false;
    }

    logInfo('auction_created', { ...context, end_at: stored.end_at, status: stored.status });
    return true;
}

/**
 * Records a failed auction lookup with enough context to tell the causes apart:
 * the row was never written, it was deleted, or it exists under a different
 * chat_id than the button encoded.
 *
 * @param {string} source - Which button/handler missed, e.g. 'bid_deep_link'.
 * @param {number} chatId - Chat id that was looked up.
 * @param {number} messageId - Message id that was looked up.
 * @param {Object} [extra] - Extra context (user id, ...).
 */
export function logAuctionNotFound(source, chatId, messageId, extra = {}) {
    let sameMessageId = [];
    let channelId = null;
    try {
        // A NaN/undefined id would throw here — the handler is already failing,
        // so swallow it and still record the lookup that missed.
        sameMessageId = q.getAuctionsByMessageId.all(messageId);
        channelId = getChannelId();
    } catch (e) {
        logWarn('auction_not_found_diagnostics_failed', { source, error: e });
    }

    logWarn('auction_not_found', {
        source,
        // NaN/Infinity would be written as null by JSON.stringify — keep the bad
        // value visible, since an unparsable id is itself a cause worth seeing.
        looked_up: {
            chat_id: Number.isFinite(chatId) ? chatId : String(chatId),
            message_id: Number.isFinite(messageId) ? messageId : String(messageId)
        },
        configured_channel_id: channelId,
        rows_with_same_message_id: sameMessageId,
        ...extra
    });
}
