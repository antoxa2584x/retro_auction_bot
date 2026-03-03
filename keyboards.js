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
