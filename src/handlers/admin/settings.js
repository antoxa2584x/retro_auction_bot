import { q } from '../../services/db.js';
import { 
    makeAdminSettingsKb, 
    makeAdminLangKb,
    makeAdminSettingsMainKb,
    makeAdminSettingsTemplateKb,
    makeAdminSettingsDefaultsKb
} from '../../utils/keyboards.js';
import { getAdminId, getChannelId, getAdminNickname } from "../../config/env.js";
import { t, setLocale, getLocale, setCurrency, getCurrency } from '../../services/i18n.js';

export const userSessions = new Map();

/**
 * Registers handlers for the admin settings panel (language, currency, IDs).
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 */
export function registerSettingsHandlers(bot) {
    bot.on('callback_query', async (query) => {
        const { data, message, from } = query;
        const chatId = message.chat.id;
        const messageId = message.message_id;

        if (data === 'adm_settings') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);
            await sendSettingsPanel(bot, chatId, from.id, true, messageId);
        }

        if (data === 'adm_settings_main') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);
            await sendSettingsMainPanel(bot, chatId, from.id, true, messageId);
        }

        if (data === 'adm_settings_template') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);
            await sendSettingsTemplatePanel(bot, chatId, from.id, true, messageId);
        }

        if (data === 'adm_settings_defaults') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);
            await sendSettingsDefaultsPanel(bot, chatId, from.id, true, messageId);
        }

        if (data === 'adm_lang') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);

            const text = t('admin.panel_language') + '\n\n' +
                t('admin.current_language', { lang: getLocale() === 'uk' ? t('admin.lang_uk') : t('admin.lang_en') }) + '\n\n' +
                t('admin.choose_language');

            await bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                reply_markup: makeAdminLangKb()
            });
        }

        if (data === 'adm_cur') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);

            userSessions.set(from.id, 'CURRENCY');

            const currentCurrency = getCurrency();
            const text = t('admin.panel_currency') + '\n\n' +
                t('admin.current_currency', { cur: currentCurrency }) + '\n\n' +
                t('admin.enter_currency');

            await bot.sendMessage(chatId, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: t('common.cancel'), callback_data: 'cancel_settings', style: 'danger' }]]
                }
            });
        }

        const setLangMatch = data.match(/^set_lang:(.+)$/);
        if (setLangMatch) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);

            const lang = setLangMatch[1];
            setLocale(lang);
            q.setSetting.run('LOCALE', lang);

            await bot.answerCallbackQuery(query.id, { text: t('admin.language_changed'), show_alert: true });
            await sendSettingsPanel(bot, chatId, from.id, true, messageId);
        }

        const setConfMatch = data.match(/^set_conf:(.+)$/);
        if (setConfMatch) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);

            const key = setConfMatch[1];
            userSessions.set(from.id, key);

            await bot.sendMessage(chatId, t('admin.enter_new_value', { key }), { 
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: t('common.cancel'), callback_data: 'cancel_settings', style: 'danger' }]]
                }
            });
        }

        if (data === 'cancel_settings') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true });
            await bot.answerCallbackQuery(query.id);

            userSessions.delete(from.id);
            const lastPanel = userSessions.get(`${from.id}:last_panel`) || 'adm_settings';
            await bot.deleteMessage(chatId, messageId).catch(() => {});
            
            if (lastPanel === 'adm_settings_main') await sendSettingsMainPanel(bot, chatId, from.id, false);
            else if (lastPanel === 'adm_settings_template') await sendSettingsTemplatePanel(bot, chatId, from.id, false);
            else if (lastPanel === 'adm_settings_defaults') await sendSettingsDefaultsPanel(bot, chatId, from.id, false);
            else await sendSettingsPanel(bot, chatId, from.id, false);
        }
    });
}

/**
 * Handles text input for updating settings.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {Object} msg - Telegram message object.
 * @param {string} text - The new value for the setting.
 * @returns {Promise<boolean>} True if the input was processed as a setting update.
 */
export async function handleSettingsInput(bot, msg, text) {
    if (!userSessions.has(msg.from.id)) return false;

    console.log(`[ADMIN SETTINGS] User ${msg.from.id} updating ${userSessions.get(msg.from.id)} to ${text}`);
    const settingKey = userSessions.get(msg.from.id);
    const userId = msg.from.id;
    const chatId = msg.chat.id;

    try {
        if (settingKey === 'CURRENCY') {
            setCurrency(text);
        }
        q.setSetting.run(settingKey, text);
        userSessions.delete(userId);
        await bot.sendMessage(chatId, t('admin.setting_updated', { key: settingKey, value: text }), { parse_mode: 'HTML' });
        
        const lastPanel = userSessions.get(`${userId}:last_panel`) || 'adm_settings';
        if (lastPanel === 'adm_settings_main') await sendSettingsMainPanel(bot, chatId, userId, false);
        else if (lastPanel === 'adm_settings_template') await sendSettingsTemplatePanel(bot, chatId, userId, false);
        else if (lastPanel === 'adm_settings_defaults') await sendSettingsDefaultsPanel(bot, chatId, userId, false);
        else await sendSettingsPanel(bot, chatId, userId, false);
    } catch (e) {
        console.error(`[ADMIN SETTINGS ERROR] ${e.message}`);
        await bot.sendMessage(chatId, t('admin.setting_error', { error: e.message }), { parse_mode: 'HTML' });
    }
    return true;
}

/**
 * Sends or updates the settings panel message.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} chatId - Chat ID.
 * @param {number} userId - User ID.
 * @param {boolean} isEdit - Whether to edit the existing message instead of sending a new one.
 * @param {number} [messageId] - Message ID to edit.
 */
export async function sendSettingsPanel(bot, chatId, userId, isEdit = false, messageId = null) {
    userSessions.set(`${userId}:last_panel`, 'adm_settings');
    const text = t('admin.panel_settings') + '\n\n' + t('admin.click_below_to_change');
    const kb = makeAdminSettingsKb();
    await updateOrSendMessage(bot, chatId, text, kb, isEdit, messageId);
}

/**
 * Sends or updates the main settings panel message.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} chatId - Chat ID.
 * @param {number} userId - User ID.
 * @param {boolean} isEdit - Whether to edit the existing message instead of sending a new one.
 * @param {number} [messageId] - Message ID to edit.
 */
export async function sendSettingsMainPanel(bot, chatId, userId, isEdit = false, messageId = null) {
    userSessions.set(`${userId}:last_panel`, 'adm_settings_main');
    const channelId = getChannelId() || 'Not set';
    const adminId = getAdminId() || 'Not set';
    const adminNickname = getAdminNickname();

    const text = t('admin.panel_settings_main') + '\n\n' +
        `📺 <b>Channel ID:</b> <code>${channelId}</code>\n` +
        `👤 <b>Admin ID:</b> <code>${adminId}</code>\n` +
        `🏷 <b>Admin Nickname:</b> <code>${adminNickname}</code>\n\n` +
        t('admin.click_below_to_change');

    const kb = makeAdminSettingsMainKb();
    await updateOrSendMessage(bot, chatId, text, kb, isEdit, messageId);
}

/**
 * Sends or updates the template settings panel message.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} chatId - Chat ID.
 * @param {number} userId - User ID.
 * @param {boolean} isEdit - Whether to edit the existing message instead of sending a new one.
 * @param {number} [messageId] - Message ID to edit.
 */
export async function sendSettingsTemplatePanel(bot, chatId, userId, isEdit = false, messageId = null) {
    userSessions.set(`${userId}:last_panel`, 'adm_settings_template');
    const text = t('admin.panel_settings_template') + '\n\n' +
        `📢 <b>Header:</b> <code>${q.getSetting.get('AUCTION_HEADER')?.value || t('parse.defaults.header')}</code>\n` +
        `💰 <b>Min Bid Text:</b> <code>${q.getSetting.get('AUCTION_MIN_BID_TEXT')?.value || t('parse.defaults.min_bid')}</code>\n` +
        `📈 <b>Bid Step Text:</b> <code>${q.getSetting.get('AUCTION_BID_STEP_TEXT')?.value || t('parse.defaults.bid_step')}</code>\n` +
        `🕘 <b>End Date Text:</b> <code>${q.getSetting.get('AUCTION_END_DATE_TEXT')?.value || t('parse.defaults.end_date')}</code>\n` +
        `📝 <b>Footer:</b> <code>${q.getSetting.get('AUCTION_FOOTER')?.value || t('parse.defaults.footer')}</code>\n\n` +
        t('admin.click_below_to_change');

    const kb = makeAdminSettingsTemplateKb();
    await updateOrSendMessage(bot, chatId, text, kb, isEdit, messageId);
}

/**
 * Sends or updates the defaults settings panel message.
 * 
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {number} chatId - Chat ID.
 * @param {number} userId - User ID.
 * @param {boolean} isEdit - Whether to edit the existing message instead of sending a new one.
 * @param {number} [messageId] - Message ID to edit.
 */
export async function sendSettingsDefaultsPanel(bot, chatId, userId, isEdit = false, messageId = null) {
    userSessions.set(`${userId}:last_panel`, 'adm_settings_defaults');
    const text = t('admin.panel_settings_defaults') + '\n\n' +
        `📅 <b>Default End Days:</b> <code>${q.getSetting.get('DEFAULT_END_DAYS')?.value || '5'}</code>\n` +
        `🕒 <b>Default End Time:</b> <code>${q.getSetting.get('DEFAULT_END_TIME')?.value || '21:00'}</code>\n\n` +
        t('admin.click_below_to_change');

    const kb = makeAdminSettingsDefaultsKb();
    await updateOrSendMessage(bot, chatId, text, kb, isEdit, messageId);
}

/**
 * Helper to either edit existing message or send a new one.
 * 
 * @param {TelegramBot} bot 
 * @param {number} chatId 
 * @param {string} text 
 * @param {object} kb 
 * @param {boolean} isEdit 
 * @param {number} [messageId] 
 */
async function updateOrSendMessage(bot, chatId, text, kb, isEdit, messageId = null) {
    if (isEdit && messageId) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: kb });
        } catch (e) {
            if (!e.message.includes('message is not modified')) {
                await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
            }
        }
    } else {
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
    }
}

function isAdmin(userId) {
    const admin = q.getAdmin.get(userId);
    return admin && admin.otp_code === null;
}
