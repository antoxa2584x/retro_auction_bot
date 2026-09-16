import { makeKb } from './keyboards.js';
import { logError, logInfo } from '../services/logger.js';

/**
 * Delays before each *background* retry. The first attempt runs inline, so a
 * keyboard that lands immediately — the normal case — costs nothing extra.
 * Telegram's per-channel flood limit is measured in minutes, so the tail is
 * long enough to outlive one.
 */
const RETRY_DELAYS_MS = [3000, 10000, 30000, 60000];

/**
 * Errors that will still be there on the next attempt: the message is gone, or
 * the bot may not touch it. Retrying these only delays the failure log.
 */
const PERMANENT_ERROR = /message to edit not found|message can't be edited|message identifier is not specified|chat not found|not enough rights|MESSAGE_ID_INVALID/i;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Attaches the auction keyboard to a channel post that was sent without one.
 *
 * The bid and subscribe buttons are deep links carrying the post's own
 * message_id, which Telegram only assigns on send — so the post goes out bare
 * and the keyboard is attached here. Sending a placeholder keyboard instead
 * (message_id 0) puts a live button on the post that resolves to a lookup for
 * `(channel, 0)` and answers "auction not found" until the patch lands; a post
 * with no buttons for a moment is the lesser evil.
 *
 * Only the first attempt is awaited, so a throttled channel doesn't hold up the
 * caller's callback answer or gallery send. The rest run detached: a keyboard
 * that never arrives leaves a lot nobody can bid on, which is worth several
 * minutes of retrying and, failing that, a line in the log.
 *
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {Object} params
 * @param {string} params.source - Flow that posted it, e.g. 'pending_approval'.
 * @param {number} params.chatId - Channel the post is in.
 * @param {number} params.messageId - Message id of the post.
 * @param {number} params.price - Price to show on the button.
 * @param {number} [params.bidsCount] - Bids placed so far.
 * @param {Object} [params.extra] - Extra context for the failure log.
 * @returns {Promise<boolean>} True when the keyboard is already on the post;
 *   false when it wasn't attached yet (retries may still be running).
 */
export async function attachAuctionKeyboard(bot, { source, chatId, messageId, price, bidsCount = 0, extra = {} }) {
    const kb = makeKb(chatId, messageId, price, bidsCount);
    const context = { source, chat_id: chatId, message_id: messageId, ...extra };

    const outcome = await attemptAttach(bot, kb, chatId, messageId);
    if (outcome.done) return true;

    if (outcome.permanent) {
        logError('auction_keyboard_patch_failed', { ...context, attempts: 1, error: outcome.error });
        return false;
    }

    // Detached on purpose: the caller still has a callback to answer and a
    // gallery to send, and a flood wait here can run into minutes.
    retryInBackground(bot, kb, chatId, messageId, context).catch(() => {});
    return false;
}

/**
 * One edit attempt, classified for the retry loop.
 *
 * @returns {Promise<{done: boolean, permanent?: boolean, error?: Error}>}
 */
async function attemptAttach(bot, kb, chatId, messageId) {
    try {
        await bot.editMessageReplyMarkup(kb, { chat_id: chatId, message_id: messageId });
        return { done: true };
    } catch (e) {
        // The post already carries this exact keyboard — the goal, reached by
        // someone else (a bid arriving mid-retry rewrites it too).
        if (e?.message?.includes('message is not modified')) return { done: true };
        return { done: false, permanent: PERMANENT_ERROR.test(e?.message || ''), error: e };
    }
}

/**
 * Keeps trying after the inline attempt failed, then gives up loudly.
 */
async function retryInBackground(bot, kb, chatId, messageId, context) {
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
        await sleep(RETRY_DELAYS_MS[attempt]);

        const outcome = await attemptAttach(bot, kb, chatId, messageId);
        if (outcome.done) {
            // The post was bare until now, so bids taken before this line are
            // the ones users couldn't place.
            logInfo('auction_keyboard_attached_late', { ...context, attempts: attempt + 2 });
            return;
        }
        if (outcome.permanent) {
            logError('auction_keyboard_patch_failed', { ...context, attempts: attempt + 2, error: outcome.error });
            return;
        }
        if (attempt === RETRY_DELAYS_MS.length - 1) {
            // The post is live with no buttons at all and needs a restart.
            logError('auction_keyboard_patch_failed', { ...context, attempts: attempt + 2, error: outcome.error });
        }
    }
}
