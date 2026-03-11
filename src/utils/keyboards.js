import { BOT_USERNAME } from '../config/env.js';
import { t, getCurrency } from '../services/i18n.js';

/**
 * Creates the main auction keyboard for the channel post.
 * 
 * @param {number} chatId - The chat ID of the channel.
 * @param {number} msgId - The message ID of the post.
 * @param {number} price - Current price to display.
 * @param {number} bidsCount - Number of bids made.
 * @returns {Object} Telegraf inline keyboard object.
 */
export function makeKb(chatId, msgId, price, bidsCount) {
    let t_price;
    const cur = getCurrency();
    if (bidsCount === 0) {
        t_price = `🟡 ${price} ${cur}`;
    } else if (bidsCount < 10) {
        t_price = `🟢 ${price} ${cur}`;
    } else {
        t_price = `🔥 ${price} ${cur}`;
    }

    const absChatId = Math.abs(chatId);
    const url = `https://t.me/${BOT_USERNAME}?start=bid_${absChatId}_${msgId}`;

    return {
        inline_keyboard: [[
            {text: t_price, url: url},
            {text: t('bid.kb.bids_count', { count: bidsCount }), callback_data: `info:${chatId}:${msgId}`}
        ]]
    };
}

/**
 * Creates the main admin panel keyboard.
 * 
 * @returns {Object} Telegraf inline keyboard object.
 */
export function makeAdminPanelKb() {
    return {
        inline_keyboard: [
            [{ text: t('admin.post_new'), callback_data: 'adm_post' }],
            [{ text: t('admin.kb.view_active'), callback_data: 'adm_active' }],
            [{ text: t('admin.kb.view_finished'), callback_data: 'adm_finished' }],
            [{ text: t('admin.kb.refresh'), callback_data: 'adm_list' }],
            [{ text: t('admin.kb.settings'), callback_data: 'adm_settings' }]
        ]
    };
}

/**
 * Creates the admin panel keyboard with a list of active auctions.
 * 
 * @param {Array} auctions - List of active auction objects.
 * @returns {Object} Telegraf inline keyboard object.
 */
export function makeAdminActiveKb(auctions) {
    const cur = getCurrency();
    const buttons = auctions.map(a => ([{
        text: `🚀 ${a.title} - ${a.current_price} ${cur}`,
        callback_data: `adm_view:${a.chat_id}:${a.message_id}`
    }]));
    buttons.push([{ text: t('admin.kb.back_to_panel'), callback_data: 'adm_list' }]);
    return { inline_keyboard: buttons };
}

/**
 * Creates the admin settings keyboard.
 * 
 * @returns {Object} Telegraf inline keyboard object.
 */
export function makeAdminSettingsKb() {
    return {
        inline_keyboard: [
            [
                { text: t('admin.settings_main'), callback_data: 'adm_settings_main' },
                { text: t('admin.settings_template'), callback_data: 'adm_settings_template' },
                { text: t('admin.settings_defaults'), callback_data: 'adm_settings_defaults' }
            ],
            [{ text: `🌐 ${t('admin.lang_button')}`, callback_data: 'adm_lang' }],
            [{ text: `💰 ${t('admin.cur_button')}`, callback_data: 'adm_cur' }],
            [{ text: t('common.back'), callback_data: 'adm_list' }]
        ]
    };
}

/**
 * Creates the admin settings keyboard for main configuration.
 * 
 * @returns {Object} Telegraf inline keyboard object.
 */
export function makeAdminSettingsMainKb() {
    return {
        inline_keyboard: [
            [{ text: '📺 Channel ID', callback_data: 'set_conf:CHANNEL_ID' }],
            [{ text: '👤 Admin ID', callback_data: 'set_conf:ADMIN_ID' }],
            [{ text: '🏷 Admin Nickname', callback_data: 'set_conf:ADMIN_NICKNAME' }],
            [{ text: t('common.back'), callback_data: 'adm_settings' }]
        ]
    };
}

/**
 * Creates the admin settings keyboard for auction template.
 * 
 * @returns {Object} Telegraf inline keyboard object.
 */
export function makeAdminSettingsTemplateKb() {
    return {
        inline_keyboard: [
            [{ text: `📢 ${t('admin.auction_header')}`, callback_data: 'set_conf:AUCTION_HEADER' }],
            [{ text: `💰 ${t('admin.auction_min_bid_text')}`, callback_data: 'set_conf:AUCTION_MIN_BID_TEXT' }],
            [{ text: `📈 ${t('admin.auction_bid_step_text')}`, callback_data: 'set_conf:AUCTION_BID_STEP_TEXT' }],
            [{ text: `🕘 ${t('admin.auction_end_date_text')}`, callback_data: 'set_conf:AUCTION_END_DATE_TEXT' }],
            [{ text: `📝 ${t('admin.auction_footer')}`, callback_data: 'set_conf:AUCTION_FOOTER' }],
            [{ text: t('common.back'), callback_data: 'adm_settings' }]
        ]
    };
}

/**
 * Creates the admin settings keyboard for default values.
 * 
 * @returns {Object} Telegraf inline keyboard object.
 */
export function makeAdminSettingsDefaultsKb() {
    return {
        inline_keyboard: [
            [{ text: `📅 ${t('admin.def_days')}`, callback_data: 'set_conf:DEFAULT_END_DAYS' }],
            [{ text: `🕒 ${t('admin.def_time')}`, callback_data: 'set_conf:DEFAULT_END_TIME' }],
            [{ text: t('common.back'), callback_data: 'adm_settings' }]
        ]
    };
}

/**
 * Creates the keyboard for selecting a bid step.
 * 
 * @returns {Object} Telegraf inline keyboard object.
 */
export function makeAdminPostStepKb() {
    return {
        inline_keyboard: [
            [
                { text: '10', callback_data: 'post_step:10' },
                { text: '25', callback_data: 'post_step:25' },
                { text: '50', callback_data: 'post_step:50' }
            ],
            [
                { text: '100', callback_data: 'post_step:100' },
                { text: '200', callback_data: 'post_step:200' },
                { text: t('admin.kb.custom'), callback_data: 'post_step:custom' }
            ],
            [{ text: t('common.cancel'), callback_data: 'post_cancel' }]
        ]
    };
}

/**
 * Creates a simple cancel keyboard for auction posting.
 * 
 * @param {boolean} [includeSkip=false] - Whether to include a skip button.
 * @returns {Object} Telegraf inline keyboard object.
 */
export function makeAdminPostCancelKb(includeSkip = false) {
    const row = [];
    if (includeSkip) {
        row.push({ text: t('admin.kb.skip'), callback_data: 'post_skip' });
    }
    row.push({ text: t('common.cancel'), callback_data: 'post_cancel' });
    return { inline_keyboard: [row] };
}

/**
 * Creates the keyboard for selecting an admin contact.
 * 
 * @returns {Object} Telegraf inline keyboard object.
 */
export function makeAdminPostContactKb() {
    return {
        inline_keyboard: [
            [{ text: t('admin.kb.use_settings_contact'), callback_data: 'post_contact:default' }],
            [{ text: t('admin.kb.enter_contact_manually'), callback_data: 'post_contact:manual' }],
            [{ text: t('common.cancel'), callback_data: 'post_cancel' }]
        ]
    };
}

/**
 * Creates the confirmation keyboard for posting an auction.
 * 
 * @returns {Object} Telegraf inline keyboard object.
 */
export function makeAdminPostConfirmKb() {
    return {
        inline_keyboard: [
            [{ text: t('admin.kb.post_now'), callback_data: 'post_confirm' }],
            [{ text: t('common.cancel'), callback_data: 'post_cancel' }]
        ]
    };
}


/**
 * Creates the language selection keyboard for admins.
 * 
 * @returns {Object} Telegraf inline keyboard object.
 */
export function makeAdminLangKb() {
    return {
        inline_keyboard: [
            [{ text: t('admin.lang_uk'), callback_data: 'set_lang:uk' }],
            [{ text: t('admin.lang_en'), callback_data: 'set_lang:en' }],
            [{ text: t('common.back'), callback_data: 'adm_settings' }]
        ]
    };
}

/**
 * Creates the keyboard with a list of recently finished auctions.
 * 
 * @param {Array} auctions - List of finished auction objects.
 * @returns {Object} Telegraf inline keyboard object.
 */
export function makeAdminFinishedKb(auctions) {
    const cur = getCurrency();
    const buttons = auctions.map(a => ([{
        text: `🏁 ${a.title} - ${a.current_price} ${cur}`,
        callback_data: `adm_view:${a.chat_id}:${a.message_id}`
    }]));
    buttons.push([{ text: t('admin.kb.back_to_panel'), callback_data: 'adm_list' }]);
    return { inline_keyboard: buttons };
}

/**
 * Creates the action keyboard for a specific auction in the admin panel.
 * 
 * @param {number} chatId - Chat ID.
 * @param {number} messageId - Message ID.
 * @param {string} status - Current status of the auction.
 * @returns {Object} Telegraf inline keyboard object.
 */
export function makeAdminAuctionActionKb(chatId, messageId, status) {
    const buttons = [];
    if (status === 'finished') {
        buttons.push([{ text: t('admin.kb.restart'), callback_data: `adm_restart:${chatId}:${messageId}` }]);
    } else if (status === 'active') {
        buttons.push([{ text: t('admin.kb.finish_now'), callback_data: `adm_finish_now:${chatId}:${messageId}` }]);
    }
    if (status === 'finished') {
        buttons.push([{ text: t('common.back'), callback_data: `adm_finished` }]);
    } else {
        buttons.push([{ text: t('common.back'), callback_data: `adm_active` }]);
    }
    return {
        inline_keyboard: buttons
    };
}

/**
 * Creates a confirmation keyboard for placing a bid.
 * 
 * @param {number} chatId - Chat ID.
 * @param {number} msgId - Message ID.
 * @param {number} price - Bid amount.
 * @returns {Object} Telegraf inline keyboard object.
 */
export function confirmBidKb(chatId, msgId, price) {
    return {
        inline_keyboard: [[
            {text: t('bid.kb.confirm', { price }), callback_data: `confbid:${chatId}:${msgId}:${price}`},
            {text: t('bid.kb.cancel'), callback_data: `cancelbid`}
        ]]
    };
}

/**
 * Creates a keyboard for finished auctions with no bids.
 * 
 * @returns {Object} Telegraf inline keyboard object.
 */
export function makeEmptyFinishKb() {
    return {
        inline_keyboard: [[
            {text: t('bid.kb.no_bids'), callback_data: `none`}
        ]]
    };
}

/**
 * Creates the winner banner keyboard with a link to the winner's profile.
 * 
 * @param {number} leaderId - Winner's user ID.
 * @param {string} leaderName - Winner's display name.
 * @param {number} price - Final price.
 * @returns {Object} Telegraf inline keyboard object.
 */
export function winnerKeyboard(leaderId, leaderName, price) {
    const url = `tg://user?id=${leaderId}`;
    const cur = getCurrency();
    return {inline_keyboard: [[{text: `🏆 ${price} ${cur} : ${leaderName}`, url}]]};
}
