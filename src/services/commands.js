/**
 * Per-user command menu.
 *
 * Telegram resolves the "/" menu by scope: a chat-specific list wins over the
 * default one. So the public list carries only what everyone may use, and each
 * verified admin gets a chat-scoped list with /admin_panel on top of it. Neither
 * list offers /admin: the key request stays typable but is never advertised.
 */
import { q } from './db.js';
import { t } from './i18n.js';

/**
 * The commands every user gets, in menu order. Built per call so a language
 * change is picked up.
 *
 * @returns {Array<{command: string, description: string}>}
 */
function commonCommands() {
    return [
        { command: 'menu', description: t('commands.menu') },
        { command: 'my', description: t('commands.my') },
        { command: 'bids', description: t('commands.bids') },
        { command: 'won', description: t('commands.won') },
        { command: 'about', description: t('commands.about') }
    ];
}

/**
 * Commands offered to a verified admin: the panel first, then the common ones.
 *
 * @returns {Array<{command: string, description: string}>}
 */
function adminCommands() {
    return [{ command: 'admin_panel', description: t('commands.admin_panel') }, ...commonCommands()];
}

/**
 * Sets the chat-scoped admin command list for one user.
 *
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} userId - Telegram user ID (private chat ID).
 * @returns {Promise<void>}
 */
export async function applyAdminCommands(bot, userId) {
    try {
        await bot.setMyCommands(adminCommands(), { scope: { type: 'chat', chat_id: userId } });
    } catch (e) {
        console.error(`Error setting admin commands for ${userId}:`, e.message);
    }
}

/**
 * Drops the chat-scoped list for a user, so they fall back to the public one.
 * Used when admin rights are revoked.
 *
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} userId - Telegram user ID (private chat ID).
 * @returns {Promise<void>}
 */
export async function clearAdminCommands(bot, userId) {
    try {
        await bot.deleteMyCommands({ scope: { type: 'chat', chat_id: userId } });
    } catch (e) {
        console.error(`Error clearing admin commands for ${userId}:`, e.message);
    }
}

/**
 * Re-applies the whole command layout: the common list on the public scopes
 * plus a chat-scoped list for every verified admin. Run at startup and after a
 * language change, since descriptions are localized.
 *
 * @param {TelegramBot} bot - Telegram bot instance.
 * @returns {Promise<void>}
 */
export async function syncBotCommands(bot) {
    // Both scopes, not just the default one: a leftover all_private_chats list
    // (what BotFather writes) outranks the default in private chats, which is
    // exactly where the menu is read — leaving it would keep showing the old
    // commands, /admin included, to regular users.
    for (const scope of [{ type: 'default' }, { type: 'all_private_chats' }]) {
        try {
            await bot.setMyCommands(commonCommands(), { scope });
        } catch (e) {
            console.error(`Error setting ${scope.type} commands:`, e.message);
        }
    }

    for (const admin of q.getAllAdmins.all()) {
        await applyAdminCommands(bot, admin.user_id);
    }
}
