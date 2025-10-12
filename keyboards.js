export function makeKb(chatId, msgId, price, participants) {
    const t = `${participants === 0 ? '🟡' : '🟢'} ${price} грн`;
    return {
        inline_keyboard: [[
            { text: t, callback_data: `bid:${chatId}:${msgId}` },
            { text: `👥 Ставки (${participants})`, callback_data: `info:${chatId}:${msgId}` }
        ]]
    };
}

export function makeEmptyFinishKb(chatId, msgId) {
    return { inline_keyboard: [[
            { text: '🔴 Фініш! Ставок не було.', callback_data: `bid:${chatId}:${msgId}` }
        ]]};
}

export function winnerKeyboard(leaderId, leaderName, price) {
    const url = `tg://user?id=${leaderId}`;
    return { inline_keyboard: [[{ text: `🏁 Переможець: ${leaderName} • ${price} грн`, url }]] };
}
