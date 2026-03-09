import { BOT_USERNAME } from '../config/env.js';
import { t, getCurrency } from '../services/i18n.js';

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

export function makeAdminActiveKb(auctions) {
    const cur = getCurrency();
    const buttons = auctions.map(a => ([{
        text: `${a.title} - ${a.current_price} ${cur}`,
        callback_data: `adm_view:${a.chat_id}:${a.message_id}`
    }]));
    buttons.push([{ text: t('admin.kb.view_finished'), callback_data: 'adm_finished' }]);
    buttons.push([{ text: t('admin.kb.settings'), callback_data: 'adm_settings' }]);
    return { inline_keyboard: buttons };
}

export function makeAdminSettingsKb() {
    return {
        inline_keyboard: [
            [{ text: '📺 Channel ID', callback_data: 'set_conf:CHANNEL_ID' }],
            [{ text: '👤 Admin ID', callback_data: 'set_conf:ADMIN_ID' }],
            [{ text: '🏷 Admin Nickname', callback_data: 'set_conf:ADMIN_NICKNAME' }],
            [{ text: `🌐 ${t('admin.lang_button')}`, callback_data: 'adm_lang' }],
            [{ text: `💰 ${t('admin.cur_button')}`, callback_data: 'adm_cur' }],
            [{ text: t('common.back'), callback_data: 'adm_list' }]
        ]
    };
}


export function makeAdminLangKb() {
    return {
        inline_keyboard: [
            [{ text: t('admin.lang_uk'), callback_data: 'set_lang:uk' }],
            [{ text: t('admin.lang_en'), callback_data: 'set_lang:en' }],
            [{ text: t('common.back'), callback_data: 'adm_settings' }]
        ]
    };
}

export function makeAdminFinishedKb(auctions) {
    const cur = getCurrency();
    const buttons = auctions.map(a => ([{
        text: `🏁 ${a.title} - ${a.current_price} ${cur}`,
        callback_data: `adm_view:${a.chat_id}:${a.message_id}`
    }]));
    buttons.push([{ text: t('admin.kb.back_to_panel'), callback_data: 'adm_list' }]);
    return { inline_keyboard: buttons };
}

export function makeAdminAuctionActionKb(chatId, messageId, status) {
    const buttons = [];
    if (status === 'finished') {
        buttons.push([{ text: t('admin.kb.restart'), callback_data: `adm_restart:${chatId}:${messageId}` }]);
    } else if (status === 'active') {
        buttons.push([{ text: t('admin.kb.finish_now'), callback_data: `adm_finish_now:${chatId}:${messageId}` }]);
    }
    buttons.push([{ text: t('common.back'), callback_data: `adm_list` }]);
    return {
        inline_keyboard: buttons
    };
}

export function confirmBidKb(chatId, msgId, price) {
    return {
        inline_keyboard: [[
            {text: t('bid.kb.confirm', { price }), callback_data: `confbid:${chatId}:${msgId}:${price}`},
            {text: t('bid.kb.cancel'), callback_data: `cancelbid`}
        ]]
    };
}

export function makeEmptyFinishKb() {
    return {
        inline_keyboard: [[
            {text: t('bid.kb.no_bids'), callback_data: `none`}
        ]]
    };
}

export function winnerKeyboard(leaderId, leaderName, price) {
    const url = `tg://user?id=${leaderId}`;
    const cur = getCurrency();
    return {inline_keyboard: [[{text: `🏆 ${price} ${cur} : ${leaderName}`, url}]]};
}
