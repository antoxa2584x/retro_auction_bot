export function makeKb(chatId, msgId, price) {
    const t = `Зробити першу ставку - ${price} грн`;
    return {
        inline_keyboard: [[
            {text: t, callback_data: `confirm:${chatId}:${msgId}:${price}`}
        ]]
    };
}

export function makeActiveKb(chatId, msgId, price, participants, leaderId, leaderName) {
    const t = `${participants > 10 ? '🔥' : '🟢'} ${price} грн`;
    const url = `tg://user?id=${leaderId}`;
    return leaderName ? {
            inline_keyboard: [[
                {text: `Лідер: ${leaderName}`, url}
            ],
                [
                    {text: t, callback_data: `confirm:${chatId}:${msgId}:${price}`},
                    {text: `👥 Ставки (${participants})`, callback_data: `info:${chatId}:${msgId}`}
                ],
            ]
        } :
        {
            inline_keyboard: [[{text: t, callback_data: `confirm:${chatId}:${msgId}:${price}`},
                {text: `👥 Ставки (${participants})`, callback_data: `info:${chatId}:${msgId}`}
            ], []]
        };
}

export function makeEmptyFinishKb(chatId, msgId) {
    return {
        inline_keyboard: [[
            {text: '🔴 Фініш! Ставок не було.', callback_data: `bid:${chatId}:${msgId}`}
        ]]
    };
}

export function winnerKeyboard(leaderId, leaderName, price, chatId, msgId) {
    const url = `tg://user?id=${leaderId}`;
    return {
        inline_keyboard: [
            [
                {text: `🏁 Переможець: ${leaderName} • ${price} грн`, url}
            ],
            [
                {text: `👥 Учасники`, callback_data: `info:${chatId}:${msgId}`}
            ]
        ]
    };
}
