import { BOT_USERNAME } from './env.js';

export function makeKb(chatId, msgId, price, bidsCount) {
    let t;
    if (bidsCount === 0) {
        t = `🟡 ${price} грн`;
    } else if (bidsCount < 10) {
        t = `🟢 ${price} грн`;
    } else {
        t = `🔥 ${price} грн`;
    }

    const absChatId = Math.abs(chatId);
    const url = `https://t.me/${BOT_USERNAME}?start=bid_${absChatId}_${msgId}`;

    return {
        inline_keyboard: [[
            {text: t, url: url},
            {text: `💬 Ставки (${bidsCount})`, callback_data: `info:${chatId}:${msgId}`}
        ]]
    };
}

export function makeAdminActiveKb(auctions) {
    const buttons = auctions.map(a => ([{
        text: `${a.title} - ${a.current_price} грн`,
        callback_data: `adm_view:${a.chat_id}:${a.message_id}`
    }]));
    buttons.push([{ text: '🏁 Переглянути завершені', callback_data: 'adm_finished' }]);
    buttons.push([{ text: '⚙️ Налаштування', callback_data: 'adm_settings' }]);
    return { inline_keyboard: buttons };
}

export function makeAdminSettingsKb() {
    return {
        inline_keyboard: [
            [{ text: '📺 Channel ID', callback_data: 'set_conf:CHANNEL_ID' }],
            [{ text: '👤 Admin ID', callback_data: 'set_conf:ADMIN_ID' }],
            [{ text: '🏷 Admin Nickname', callback_data: 'set_conf:ADMIN_NICKNAME' }],
            [{ text: '⬅️ Назад', callback_data: 'adm_list' }]
        ]
    };
}

export function makeAdminFinishedKb(auctions) {
    const buttons = auctions.map(a => ([{
        text: `🏁 ${a.title} - ${a.current_price} грн`,
        callback_data: `adm_view:${a.chat_id}:${a.message_id}`
    }]));
    buttons.push([{ text: '⬅️ Назад до адмін-панелі', callback_data: 'adm_list' }]);
    return { inline_keyboard: buttons };
}

export function makeAdminAuctionActionKb(chatId, messageId, status) {
    const buttons = [];
    if (status === 'finished') {
        buttons.push([{ text: '🔄 Рестарт (4 дні)', callback_data: `adm_restart:${chatId}:${messageId}` }]);
    } else if (status === 'active') {
        buttons.push([{ text: '🏁 Завершити негайно', callback_data: `adm_finish_now:${chatId}:${messageId}` }]);
    }
    buttons.push([{ text: '⬅️ Назад', callback_data: `adm_list` }]);
    return {
        inline_keyboard: buttons
    };
}

export function confirmBidKb(chatId, msgId, price) {
    return {
        inline_keyboard: [[
            {text: `✅ Підтвердити ${price} грн`, callback_data: `confbid:${chatId}:${msgId}:${price}`},
            {text: `❌ Відміна`, callback_data: `cancelbid`}
        ]]
    };
}

export function makeEmptyFinishKb() {
    return {
        inline_keyboard: [[
            {text: '🏁 Ставок не було', callback_data: `none`}
        ]]
    };
}

export function winnerKeyboard(leaderId, leaderName, price) {
    const url = `tg://user?id=${leaderId}`;
    return {inline_keyboard: [[{text: `🏆 ${price} грн : ${leaderName}`, url}]]};
}
