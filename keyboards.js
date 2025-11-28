export function makeKb(chatId, msgId, price, participants) {
    let t;
    if (participants === 0) {
        t = `🟡 ${price} грн`;
    } else if (participants < 10) {
        t = `🟢 ${price} грн`;
    } else {
        t = `🔥 ${price} грн`;
    }

    return {
        inline_keyboard: [[
            {text: t, callback_data: `bid:${chatId}:${msgId}`},
            {text: `👥 Ставки (${participants})`, callback_data: `info:${chatId}:${msgId}`}
        ]]
    };
}

export function makeEmptyFinishKb(chatId, msgId) {
    return {
        inline_keyboard: [[
            {text: '🏁 Ставок не було.', callback_data: `bid:${chatId}:${msgId}`}
        ]]
    };
}

export function winnerKeyboard(leaderId, leaderName, price) {
    const url = `tg://user?id=${leaderId}`;
    return {inline_keyboard: [[{text: `🏆 ${price} грн : ${leaderName}`, url}]]};
}
