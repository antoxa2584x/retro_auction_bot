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
 * @param {import('telegraf').Telegraf} bot - Telegraf bot instance.
 */
export function registerSettingsHandlers(bot) {
    bot.action('adm_settings', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));
        await sendSettingsPanel(ctx, true);
        await ctx.answerCbQuery();
    });

    bot.action('adm_settings_main', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));
        await sendSettingsMainPanel(ctx, true);
        await ctx.answerCbQuery();
    });

    bot.action('adm_settings_template', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));
        await sendSettingsTemplatePanel(ctx, true);
        await ctx.answerCbQuery();
    });

    bot.action('adm_settings_defaults', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));
        await sendSettingsDefaultsPanel(ctx, true);
        await ctx.answerCbQuery();
    });

    bot.action('adm_lang', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        const text = t('admin.panel_language') + '\n\n' +
            t('admin.current_language', { lang: getLocale() === 'uk' ? t('admin.lang_uk') : t('admin.lang_en') }) + '\n\n' +
            t('admin.choose_language');

        await ctx.editMessageText(text, {
            parse_mode: 'HTML',
            reply_markup: makeAdminLangKb()
        });
        await ctx.answerCbQuery();
    });

    bot.action('adm_cur', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        userSessions.set(ctx.from.id, 'CURRENCY');

        const currentCurrency = getCurrency();
        const text = t('admin.panel_currency') + '\n\n' +
            t('admin.current_currency', { cur: currentCurrency }) + '\n\n' +
            t('admin.enter_currency');

        await ctx.reply(text, {
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: t('common.cancel'), callback_data: 'cancel_settings' }]]
            }
        });
        await ctx.answerCbQuery();
    });

    bot.action(/^set_lang:(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        const lang = ctx.match[1];
        setLocale(lang);
        q.setSetting.run('LOCALE', lang);

        await ctx.answerCbQuery(t('admin.language_changed'));
        await sendSettingsPanel(ctx, true);
    });

    bot.action(/^set_conf:(.+)$/, async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        const key = ctx.match[1];
        userSessions.set(ctx.from.id, key);

        await ctx.reply(t('admin.enter_new_value', { key }), { 
            parse_mode: 'HTML',
            reply_markup: {
                inline_keyboard: [[{ text: t('common.cancel'), callback_data: 'cancel_settings' }]]
            }
        });
        await ctx.answerCbQuery();
    });

    bot.action('cancel_settings', async (ctx) => {
        if (!isAdmin(ctx)) return ctx.answerCbQuery(t('admin.insufficient_permissions'));

        userSessions.delete(ctx.from.id);
        const lastPanel = userSessions.get(`${ctx.from.id}:last_panel`) || 'adm_settings';
        await ctx.deleteMessage().catch(() => {});
        
        if (lastPanel === 'adm_settings_main') await sendSettingsMainPanel(ctx, false);
        else if (lastPanel === 'adm_settings_template') await sendSettingsTemplatePanel(ctx, false);
        else if (lastPanel === 'adm_settings_defaults') await sendSettingsDefaultsPanel(ctx, false);
        else await sendSettingsPanel(ctx, false);

        await ctx.answerCbQuery(t('admin.cancelled'));
    });
}

/**
 * Handles text input for updating settings.
 * 
 * @param {import('telegraf').Context} ctx - Telegram context.
 * @param {string} text - The new value for the setting.
 * @returns {Promise<boolean>} True if the input was processed as a setting update.
 */
export async function handleSettingsInput(ctx, text) {
    if (!userSessions.has(ctx.from.id)) return false;

    console.log(`[ADMIN SETTINGS] User ${ctx.from.id} updating ${userSessions.get(ctx.from.id)} to ${text}`);
    const settingKey = userSessions.get(ctx.from.id);
    try {
        if (settingKey === 'CURRENCY') {
            setCurrency(text);
        }
        q.setSetting.run(settingKey, text);
        userSessions.delete(ctx.from.id);
        await ctx.reply(t('admin.setting_updated', { key: settingKey, value: text }), { parse_mode: 'HTML' });
        
        const lastPanel = userSessions.get(`${ctx.from.id}:last_panel`) || 'adm_settings';
        if (lastPanel === 'adm_settings_main') await sendSettingsMainPanel(ctx, false);
        else if (lastPanel === 'adm_settings_template') await sendSettingsTemplatePanel(ctx, false);
        else if (lastPanel === 'adm_settings_defaults') await sendSettingsDefaultsPanel(ctx, false);
        else await sendSettingsPanel(ctx, false);
    } catch (e) {
        console.error(`[ADMIN SETTINGS ERROR] ${e.message}`);
        await ctx.reply(t('admin.setting_error', { error: e.message }));
    }
    return true;
}

/**
 * Sends or updates the settings panel message.
 * 
 * @param {import('telegraf').Context} ctx - Telegram context.
 * @param {boolean} isEdit - Whether to edit the existing message instead of sending a new one.
 */
export async function sendSettingsPanel(ctx, isEdit = false) {
    userSessions.set(`${ctx.from.id}:last_panel`, 'adm_settings');
    const text = t('admin.panel_settings') + '\n\n' + t('admin.click_below_to_change');
    const kb = makeAdminSettingsKb();
    await updateOrSendMessage(ctx, text, kb, isEdit);
}

/**
 * Sends or updates the main settings panel message.
 * 
 * @param {import('telegraf').Context} ctx - Telegram context.
 * @param {boolean} isEdit - Whether to edit the existing message instead of sending a new one.
 */
export async function sendSettingsMainPanel(ctx, isEdit = false) {
    userSessions.set(`${ctx.from.id}:last_panel`, 'adm_settings_main');
    const channelId = getChannelId() || 'Not set';
    const adminId = getAdminId() || 'Not set';
    const adminNickname = getAdminNickname();

    const text = t('admin.panel_settings_main') + '\n\n' +
        `📺 <b>Channel ID:</b> <code>${channelId}</code>\n` +
        `👤 <b>Admin ID:</b> <code>${adminId}</code>\n` +
        `🏷 <b>Admin Nickname:</b> <code>${adminNickname}</code>\n\n` +
        t('admin.click_below_to_change');

    const kb = makeAdminSettingsMainKb();
    await updateOrSendMessage(ctx, text, kb, isEdit);
}

/**
 * Sends or updates the template settings panel message.
 * 
 * @param {import('telegraf').Context} ctx - Telegram context.
 * @param {boolean} isEdit - Whether to edit the existing message instead of sending a new one.
 */
export async function sendSettingsTemplatePanel(ctx, isEdit = false) {
    userSessions.set(`${ctx.from.id}:last_panel`, 'adm_settings_template');
    const text = t('admin.panel_settings_template') + '\n\n' +
        `📢 <b>Header:</b> <code>${q.getSetting.get('AUCTION_HEADER')?.value || t('parse.defaults.header')}</code>\n` +
        `💰 <b>Min Bid Text:</b> <code>${q.getSetting.get('AUCTION_MIN_BID_TEXT')?.value || t('parse.defaults.min_bid')}</code>\n` +
        `📈 <b>Bid Step Text:</b> <code>${q.getSetting.get('AUCTION_BID_STEP_TEXT')?.value || t('parse.defaults.bid_step')}</code>\n` +
        `🕘 <b>End Date Text:</b> <code>${q.getSetting.get('AUCTION_END_DATE_TEXT')?.value || t('parse.defaults.end_date')}</code>\n` +
        `📝 <b>Footer:</b> <code>${q.getSetting.get('AUCTION_FOOTER')?.value || t('parse.defaults.footer')}</code>\n\n` +
        t('admin.click_below_to_change');

    const kb = makeAdminSettingsTemplateKb();
    await updateOrSendMessage(ctx, text, kb, isEdit);
}

/**
 * Sends or updates the defaults settings panel message.
 * 
 * @param {import('telegraf').Context} ctx - Telegram context.
 * @param {boolean} isEdit - Whether to edit the existing message instead of sending a new one.
 */
export async function sendSettingsDefaultsPanel(ctx, isEdit = false) {
    userSessions.set(`${ctx.from.id}:last_panel`, 'adm_settings_defaults');
    const text = t('admin.panel_settings_defaults') + '\n\n' +
        `📅 <b>Default End Days:</b> <code>${q.getSetting.get('DEFAULT_END_DAYS')?.value || '5'}</code>\n` +
        `🕒 <b>Default End Time:</b> <code>${q.getSetting.get('DEFAULT_END_TIME')?.value || '21:00'}</code>\n\n` +
        t('admin.click_below_to_change');

    const kb = makeAdminSettingsDefaultsKb();
    await updateOrSendMessage(ctx, text, kb, isEdit);
}

/**
 * Helper to either edit existing message or send a new one.
 * 
 * @param {import('telegraf').Context} ctx 
 * @param {string} text 
 * @param {object} kb 
 * @param {boolean} isEdit 
 */
async function updateOrSendMessage(ctx, text, kb, isEdit) {
    if (isEdit) {
        try {
            await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
        } catch (e) {
            if (!e.message.includes('message is not modified')) {
                await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
            }
        }
    } else {
        await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
    }
}

function isAdmin(ctx) {
    const admin = q.getAdmin.get(ctx.from.id);
    return admin && admin.otp_code === null;
}
