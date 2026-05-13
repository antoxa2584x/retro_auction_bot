import { formatInTimeZone } from 'date-fns-tz';
import { q } from '../../services/db.js';
import { 
    makeAdminSettingsKb, 
    makeAdminLangKb,
    makeAdminSettingsMainKb,
    makeAdminSettingsTemplateKb,
    makeAdminSettingsDefaultsKb,
    makeAdminListKb
} from '../../utils/keyboards.js';
import { getChannelId, getContactNickname } from "../../config/env.js";
import { formatUserLink, sanitizeHtml } from '../../utils/utils.js';
import { t, setLocale, getLocale, setCurrency, getCurrency } from '../../services/i18n.js';

export const userSessions = new Map();


/**
 * Checks if a user has admin rights (verified record in admins table).
 * 
 * @param {number} userId 
 * @returns {boolean}
 */
function isAdmin(userId) {
    const admin = q.getAdmin.get(userId);
    return !!(admin && admin.otp_code === null);
}

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
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});
            await sendSettingsPanel(bot, chatId, from.id, true, messageId);
        }

        if (data === 'adm_settings_main') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});
            await sendSettingsMainPanel(bot, chatId, from.id, true, messageId);
        }

        if (data === 'adm_settings_template') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});
            await sendSettingsTemplatePanel(bot, chatId, from.id, true, messageId);
        }

        if (data === 'adm_settings_defaults') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});
            await sendSettingsDefaultsPanel(bot, chatId, from.id, true, messageId);
        }

        if (data === 'clear_openai_key') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});

            q.setSetting.run('OPENAI_API_KEY', null);
            await bot.sendMessage(chatId, t('admin.openai_key_deleted'), { parse_mode: 'HTML' });
            await sendSettingsMainPanel(bot, chatId, from.id, false);
        }

        if (data === 'adm_admins') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});
            await sendAdminManagementPanel(bot, chatId, from.id, true, messageId);
        }

        if (data.startsWith('adm_del:')) {
            try {
                if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            } catch (e) {
                console.error('Error answering adm_del perm check callback:', e.message);
            }
            const delUserId = parseInt(data.split(':')[1]);
            
            // Prevent self-deletion if needed, though typically we want to allow it
            // but at least one admin must remain?
            
            q.deleteAdmin.run(delUserId);
            try {
                await bot.answerCallbackQuery(query.id, { text: t('admin.admin_deleted', { user_id: delUserId }), show_alert: true }).catch(() => {});
            } catch (e) {
                console.error('Error answering admin_deleted callback:', e.message);
            }
            await sendAdminManagementPanel(bot, chatId, from.id, true, messageId);
        }

        if (data === 'adm_lang') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});

            const text = t('admin.panel_language') + '\n\n' +
                t('admin.current_language', { lang: getLocale() === 'uk' ? t('admin.lang_uk') : t('admin.lang_en') }) + '\n\n' +
                t('admin.choose_language');

            const kb = makeAdminLangKb();
            try {
                await bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'HTML',
                    reply_markup: kb
                });
            } catch (e) {
                if (e.message.includes('there is no text in the message to edit')) {
                    await bot.deleteMessage(chatId, messageId).catch(() => {});
                    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
                } else {
                    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
                }
            }
        }

        if (data === 'adm_cur') {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});

            userSessions.set(from.id, 'CURRENCY');

            const currentCurrency = getCurrency();
            const text = t('admin.panel_currency') + '\n\n' +
                t('admin.current_currency', { cur: currentCurrency }) + '\n\n' +
                t('admin.enter_currency');

            await bot.sendMessage(chatId, text, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: t('common.cancel'), callback_data: 'cancel_settings' }]]
                }
            });
        }

        const setLangMatch = data.match(/^set_lang:(.+)$/);
        if (setLangMatch) {
            if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
            bot.answerCallbackQuery(query.id).catch(() => {});

            const lang = setLangMatch[1];
            setLocale(lang);
            q.setSetting.run('LOCALE', lang);

            try {
                await bot.answerCallbackQuery(query.id, { text: t('admin.language_changed'), show_alert: true }).catch(() => {});
            } catch (e) {
                console.error('Error answering language_changed callback:', e.message);
            }
            await sendSettingsPanel(bot, chatId, from.id, true, messageId);
        }

        const setConfMatch = data.match(/^set_conf:(.+)$/);
        if (setConfMatch) {
            try {
                if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
                await bot.answerCallbackQuery(query.id).catch(() => {});
            } catch (e) {
                console.error('Error answering set_conf callback:', e.message);
            }

            const key = setConfMatch[1];

            if (key === 'USER_POST_ENABLED') {
                const currentVal = q.getSetting.get('USER_POST_ENABLED')?.value || 'true';
                const newVal = currentVal === 'true' ? 'false' : 'true';
                q.setSetting.run('USER_POST_ENABLED', newVal);
                await sendSettingsDefaultsPanel(bot, chatId, from.id, true, messageId);
                return;
            }

            userSessions.set(from.id, key);

            await bot.sendMessage(chatId, t('admin.enter_new_value', { key }), { 
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[{ text: t('common.cancel'), callback_data: 'cancel_settings' }]]
                }
            });
        }

        if (data === 'cancel_settings') {
            try {
                if (!isAdmin(from.id)) return bot.answerCallbackQuery(query.id, { text: t('admin.insufficient_permissions'), show_alert: true }).catch(() => {});
                await bot.answerCallbackQuery(query.id).catch(() => {});
            } catch (e) {
                console.error('Error answering cancel_settings callback:', e.message);
            }

            userSessions.delete(from.id);
            const lastPanel = userSessions.get(`${from.id}:last_panel`) || 'adm_settings';
            await bot.deleteMessage(chatId, messageId).catch(() => {});
            
            if (lastPanel === 'adm_settings_main') await sendSettingsMainPanel(bot, chatId, from.id, false);
            else if (lastPanel === 'adm_settings_template') await sendSettingsTemplatePanel(bot, chatId, from.id, false);
            else if (lastPanel === 'adm_settings_defaults') await sendSettingsDefaultsPanel(bot, chatId, from.id, false);
            else if (lastPanel === 'adm_admins') await sendAdminManagementPanel(bot, chatId, from.id, false);
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
        let finalValue = text;
        if (['AUCTION_HEADER', 'AUCTION_FOOTER', 'AUCTION_MIN_BID_TEXT', 'AUCTION_BID_STEP_TEXT', 'AUCTION_END_DATE_TEXT'].includes(settingKey)) {
            finalValue = sanitizeHtml(text);
        }

        if (settingKey === 'MAX_USER_AUCTIONS') {
            const val = parseInt(text);
            if (isNaN(val) || val < 0) {
                throw new Error(t('admin.invalid_number'));
            }
            finalValue = val.toString();
        }

        if (settingKey === 'CURRENCY') {
            setCurrency(finalValue);
        }
        if (settingKey === 'TZ') {
            try {
                formatInTimeZone(new Date(), finalValue, 'yyyy-MM-dd HH:mm:ss');
            } catch (e) {
                throw new Error(t('admin.setting_error_tz'));
            }
        }
        q.setSetting.run(settingKey, finalValue);
        userSessions.delete(userId);
        await bot.sendMessage(chatId, t('admin.setting_updated', { key: settingKey, value: finalValue }), { parse_mode: 'HTML' });
        
        const lastPanel = userSessions.get(`${userId}:last_panel`) || 'adm_settings';
        if (lastPanel === 'adm_settings_main') await sendSettingsMainPanel(bot, chatId, userId, false);
        else if (lastPanel === 'adm_settings_template') await sendSettingsTemplatePanel(bot, chatId, userId, false);
        else if (lastPanel === 'adm_settings_defaults') await sendSettingsDefaultsPanel(bot, chatId, userId, false);
        else if (lastPanel === 'adm_admins') await sendAdminManagementPanel(bot, chatId, userId, false);
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
    const channelId = getChannelId() || t('admin.not_set');
    const adminNickname = getContactNickname() || t('admin.not_set');
    const openAiKey = q.getSetting.get('OPENAI_API_KEY')?.value ? '********' : t('admin.not_set');
    const timezone = q.getSetting.get('TZ')?.value || 'UTC';

    const text = t('admin.panel_settings_main') + '\n\n' +
        t('admin.panel_settings_main_channel', { id: channelId }) + '\n' +
        t('admin.panel_settings_main_contact_nickname', { nickname: adminNickname }) + '\n' +
        t('admin.panel_settings_main_openai', { key: openAiKey }) + '\n' +
        t('admin.panel_settings_main_timezone', { tz: timezone }) + '\n\n' +
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
        t('admin.panel_settings_template_header', { value: q.getSetting.get('AUCTION_HEADER')?.value || t('parse.defaults.header') }) + '\n' +
        t('admin.panel_settings_template_min_bid', { value: q.getSetting.get('AUCTION_MIN_BID_TEXT')?.value || t('parse.defaults.min_bid') }) + '\n' +
        t('admin.panel_settings_template_current_bid', { value: q.getSetting.get('AUCTION_CURRENT_BID_TEXT')?.value || t('bid.current_bid_label') }) + '\n' +
        t('admin.panel_settings_template_bid_step', { value: q.getSetting.get('AUCTION_BID_STEP_TEXT')?.value || t('parse.defaults.bid_step') }) + '\n' +
        t('admin.panel_settings_template_end_date', { value: q.getSetting.get('AUCTION_END_DATE_TEXT')?.value || t('parse.defaults.end_date') }) + '\n' +
        t('admin.panel_settings_template_footer', { value: q.getSetting.get('AUCTION_FOOTER')?.value || t('parse.defaults.footer') }) + '\n\n' +
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
        t('admin.panel_settings_defaults_days', { value: q.getSetting.get('DEFAULT_END_DAYS')?.value || '5' }) + '\n' +
        t('admin.panel_settings_defaults_time', { value: q.getSetting.get('DEFAULT_END_TIME')?.value || '21:00' }) + '\n' +
        t('admin.panel_settings_defaults_continuous', { value: q.getSetting.get('CONTINUOUS_MINUTES')?.value || '5' }) + '\n' +
        t('admin.panel_settings_defaults_max_user_auctions', { value: q.getSetting.get('MAX_USER_AUCTIONS')?.value || '3' }) + '\n' +
        t('admin.panel_settings_defaults_rules_link', { value: q.getSetting.get('RULES_LINK')?.value || t('admin.not_set') }) + '\n' +
        t('admin.panel_settings_defaults_user_post_enabled', { value: q.getSetting.get('USER_POST_ENABLED')?.value || 'true' }) + '\n\n' +
        t('admin.click_below_to_change');

    const kb = makeAdminSettingsDefaultsKb();
    await updateOrSendMessage(bot, chatId, text, kb, isEdit, messageId);
}

/**
 * Sends or updates the admin management panel.
 * 
 * @param {TelegramBot} bot 
 * @param {number} chatId 
 * @param {number} userId 
 * @param {boolean} isEdit 
 * @param {number} messageId 
 */
export async function sendAdminManagementPanel(bot, chatId, userId, isEdit = false, messageId = null) {
    userSessions.set(`${userId}:last_panel`, 'adm_admins');
    const admins = q.getAllAdmins.all();
    
    let text = t('admin.panel_admins') + '\n\n' + t('admin.admin_list_header');
    
    if (admins.length === 0) {
        text += t('admin.no_admins');
    } else {
        admins.forEach(a => {
            const name = a.username ? `@${a.username}` : (a.first_name ? `${a.first_name} ${a.last_name || ''}`.trim() : `ID ${a.user_id}`);
            text += t('admin.admin_item', { user_id: a.user_id, name: formatUserLink(a.user_id, name, a.username) }) + '\n';
        });
    }

    const kb = makeAdminListKb(admins);
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
            if (e.message.includes('there is no text in the message to edit')) {
                await bot.deleteMessage(chatId, messageId).catch(() => {});
                await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
            } else if (!e.message.includes('message is not modified')) {
                await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
            }
        }
    } else {
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: kb });
    }
}
