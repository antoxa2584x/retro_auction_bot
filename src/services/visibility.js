import { q } from './db.js';
import { logWarn } from './logger.js';

// A "visible" result is trusted for a day before we probe again. A "hidden" one
// is recorded but never trusted — it is re-probed on every attempt, so a user
// who fixes the setting can bid immediately instead of waiting out a cache.
const VISIBLE_TTL_MS = 24 * 60 * 60 * 1000;

// Sent and deleted right away — kept to a single character so the blip in the
// user's chat is as small as possible.
const PROBE_TEXT = '⌛';

/**
 * Tells whether a user's profile can be linked to — i.e. their Telegram
 * "Forwarded Messages" privacy is set to Everybody rather than Nobody.
 *
 * The Bot API exposes no field for that setting. The one reliable probe is an
 * inline button pointing at tg://user?id=<id>: Telegram rejects the whole
 * request with BUTTON_USER_PRIVACY_RESTRICTED when the user has restricted
 * forwarding — the same error the winner banner already falls back from. So we
 * send a throwaway message carrying such a button into the user's own chat with
 * the bot and delete it again.
 *
 * Fails open: a probe that breaks for any other reason (network, rate limit)
 * reports visible and is not cached, so a Telegram hiccup can never lock
 * someone out of bidding.
 *
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} userId - User whose profile is probed.
 * @param {number} [probeChatId] - Chat to send the throwaway message to;
 *   defaults to the user's own private chat with the bot.
 * @returns {Promise<boolean>} true when the profile can be linked to.
 */
export async function isProfileVisible(bot, userId, probeChatId = userId) {
    const cached = q.getUserVisibility.get(userId);
    if (cached?.visible === 1 && Date.now() - cached.checked_at < VISIBLE_TTL_MS) {
        return true;
    }

    let visible;
    try {
        const probe = await bot.sendMessage(probeChatId, PROBE_TEXT, {
            disable_notification: true,
            reply_markup: { inline_keyboard: [[{ text: PROBE_TEXT, url: `tg://user?id=${userId}` }]] }
        });
        visible = true;
        bot.deleteMessage(probeChatId, probe.message_id).catch(() => {});
    } catch (err) {
        if (!err.message?.includes('BUTTON_USER_PRIVACY_RESTRICTED')) {
            logWarn('visibility_probe_failed', { user_id: userId, error: err.message });
            return true;
        }
        visible = false;
    }

    q.setUserVisibility.run(userId, visible ? 1 : 0, Date.now());
    return visible;
}
