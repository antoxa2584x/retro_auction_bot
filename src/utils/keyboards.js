import {BOT_USERNAME} from '../config/env.js';
import {t, getCurrency} from '../services/i18n.js';
import { q } from '../services/db.js';

/**
 * Creates the main auction keyboard for the channel post.
 *
 * @param {number} chatId - The chat ID of the channel.
 * @param {number} msgId - The message ID of the post.
 * @param {number} price - Current price to display.
 * @param {number} bidsCount - Number of bids made.
 * @returns {Object} Inline keyboard object.
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
    const username = BOT_USERNAME || 'bot'; // Fallback if not yet set
    const url = `https://t.me/${username}?start=bid_${absChatId}_${msgId}`;
    const notifyUrl = `https://t.me/${username}?start=notify_${absChatId}_${msgId}`;

    return {
        inline_keyboard: [
            [{text: t('admin.kb.subscribe'), url: notifyUrl}],
            [
                {text: t_price, url: url, style: 'success'},
                {
                    text: t('bid.kb.bids_count', {count: bidsCount}),
                    callback_data: `info:${chatId}:${msgId}`,
                    style: 'primary'
                }
            ]
        ]
    };
}

/**
 * Creates the keyboard for setting notifications.
 *
 * @param {number} chatId - Chat ID.
 * @param {number} messageId - Message ID.
 * @param {boolean} alreadySet - If user already has a notification.
 * @returns {Object} Inline keyboard object.
 */
export function makeNotifyKb(chatId, messageId, alreadySet = false) {
    const buttons = [
        [
            {text: t('admin.kb.notify_1h'), callback_data: `set_notify:${chatId}:${messageId}:1`},
            {text: t('admin.kb.notify_2h'), callback_data: `set_notify:${chatId}:${messageId}:2`},
            {text: t('admin.kb.notify_3h'), callback_data: `set_notify:${chatId}:${messageId}:3`}
        ],
        [
            {text: t('admin.kb.notify_6h'), callback_data: `set_notify:${chatId}:${messageId}:6`},
            {text: t('admin.kb.notify_12h'), callback_data: `set_notify:${chatId}:${messageId}:12`}
        ]
    ];

    if (alreadySet) {
        buttons.push([{
            text: t('admin.kb.notify_remove'),
            callback_data: `rem_notify:${chatId}:${messageId}`,
            style: 'danger'
        }]);
    }

    buttons.push([{text: t('common.cancel'), callback_data: 'cancel_notify', style: 'danger'}]);

    return {inline_keyboard: buttons};
}

/**
 * Creates the user menu keyboard.
 *
 * @returns {Object} Inline keyboard object.
 */
export function makeUserMenuKb() {
    return {
        inline_keyboard: [
            [{text: t('bid.kb.menu_won'), callback_data: 'menu_won'}],
            [{text: t('bid.kb.menu_my'), callback_data: 'menu_my'}],
            [{text: t('bid.kb.menu_watchlist'), callback_data: 'menu_watchlist'}],
            [{text: t('bid.kb.menu_created'), callback_data: 'menu_created'}],
            [{text: t('admin.kb.support'), callback_data: 'support_contact'}],
            [{text: t('bid.kb.post_new'), callback_data: 'user_post', style: 'success'}]
        ]
    };
}

/**
 * Creates the keyboard for managing pending auctions.
 * 
 * @param {Array} pending - List of pending auctions.
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminPendingKb(pending) {
    const buttons = pending.map(p => {
        const user = q.getUserFromAnywhere.get(p.user_id, p.user_id, p.user_id, p.user_id);
        const name = user?.name || p.user_id;
        return [{
            text: `⏳ ${p.title} (${name})`,
            callback_data: `adm_pen_view:${p.id}`
        }];
    });

    buttons.push([{ text: t('admin.kb.back_to_panel'), callback_data: 'adm_list' }]);

    return { inline_keyboard: buttons };
}

/**
 * Creates the keyboard for a single pending auction view.
 * 
 * @param {number} id - Pending auction ID.
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminPendingViewKb(id) {
    return {
        inline_keyboard: [
            [
                { text: t('admin.kb.approve'), callback_data: `adm_pen_approve:${id}`, style: 'success' },
                { text: t('admin.kb.reject'), callback_data: `adm_pen_reject:${id}`, style: 'danger' }
            ],
            [{ text: t('common.back'), callback_data: 'adm_pending' }]
        ]
    };
}

/**
 * Creates the keyboard for entering rejection reason.
 * 
 * @param {number} id - Pending auction ID.
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminPendingRejectKb(id) {
    return {
        inline_keyboard: [
            [{ text: t('admin.pending_auction_reject_no_reason'), callback_data: `adm_pen_reject_confirm:${id}` }],
            [{ text: t('common.cancel'), callback_data: 'adm_pen_reject_cancel', style: 'danger' }]
        ]
    };
}

/**
 * Creates the main admin panel keyboard.
 *
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminPanelKb() {
    return {
        inline_keyboard: [
            [{text: t('admin.kb.view_active'), callback_data: 'adm_active'}],
            [{text: t('admin.kb.view_finished'), callback_data: 'adm_finished'}],
            [{text: t('admin.kb.pending_auctions'), callback_data: 'adm_pending'}],
            [{text: t('admin.kb.support_history'), callback_data: 'adm_support_history'}],
            [{text: t('admin.post_new'), callback_data: 'adm_post', style: 'success'}],
            [{text: t('admin.kb.broadcast'), callback_data: 'adm_broadcast', style: 'primary'}],
            [{text: t('admin.kb.settings'), callback_data: 'adm_settings', style: 'danger'}]
        ]
    };
}

/**
 * Creates the admin panel keyboard with a list of active auctions.
 *
 * @param {Array} auctions - List of active auction objects.
 * @param {number} page - Current page number.
 * @param {number} totalCount - Total count of active auctions.
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminActiveKb(auctions, page = 0, totalCount = 0) {
    const cur = getCurrency();
    const buttons = auctions.map(a => {
        let emoji = '🚀';
        if (a.participants_count === 0) {
            emoji = '⚪';
        } else if (a.participants_count < 10) {
            emoji = '🟢';
        } else {
            emoji = '🔥';
        }
        return [{
            text: `${emoji} ${a.title} - ${a.current_price} ${cur}`,
            callback_data: `adm_view:${a.chat_id}:${a.message_id}`
        }];
    });

    // Pagination
    const totalPages = Math.ceil(totalCount / 10);
    if (totalPages > 1) {
        const row = [];
        if (page > 0) {
            row.push({ text: '⬅️', callback_data: `adm_active:${page - 1}` });
        }
        row.push({ text: `${page + 1} / ${totalPages}`, callback_data: 'none' });
        if (page < totalPages - 1) {
            row.push({ text: '➡️', callback_data: `adm_active:${page + 1}` });
        }
        buttons.push(row);
    }

    buttons.push([{text: t('admin.kb.back_to_panel'), callback_data: 'adm_list', style: 'primary'}]);
    return {inline_keyboard: buttons};
}

/**
 * Creates a keyboard for support messages history.
 * 
 * @param {Array} messages - List of support messages.
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminSupportHistoryKb(messages) {
    console.log(`[DEBUG] Building history KB for ${messages?.length} messages`);
    const buttons = (messages || []).map(m => {
        const date = m.created_at ? new Date(m.created_at).toLocaleDateString('uk-UA', { day: '2-digit', month: '2-digit' }) : '??.??';
        const status = m.status === 'open' ? '✉️' : '✅';
        const truncatedMessage = m.message ? (m.message.length > 20 ? m.message.substring(0, 20) + '...' : m.message) : '...';
        return [{
            text: `${status} ${date} | ${m.user_name || 'User'}: ${truncatedMessage}`,
            callback_data: `adm_support_view:${m.id}`
        }];
    });

    buttons.push([{ text: t('admin.kb.back_to_panel'), callback_data: 'adm_list' }]);
    console.log(`[DEBUG] History KB built with ${buttons.length} rows`);
    return { inline_keyboard: buttons };
}

/**
 * Creates a keyboard for viewing a specific support message.
 * 
 * @param {Object} message - Support message object.
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminSupportViewKb(message) {
    const buttons = [];
    const canReply = message.status === 'open' || !message.admin_reply || String(message.admin_reply).trim() === '';
    
    if (canReply) {
        buttons.push([{ text: t('admin.kb.reply'), callback_data: `support_reply:${message.id}` }]);
    }
    buttons.push([{ text: t('admin.kb.prev'), callback_data: 'adm_support_history' }]);
    return { inline_keyboard: buttons };
}

/**
 * Creates a carousel navigation keyboard for "/my" or "/won" auctions.
 *
 * @param {number} index - Current auction index.
 * @param {number} total - Total number of auctions.
 * @param {string} [prefix='my'] - Prefix for callback data ('my' or 'won').
 * @param {Object} [auction] - Optional auction object to add more buttons.
 * @returns {Object} Inline keyboard object.
 */
export function makeMyCarouselKb(index, total, prefix = 'my', auction = null) {
    const buttons = [];
    
    if (prefix === 'created' && auction && auction.status === 'finished') {
        buttons.push([{
            text: t('bid.kb.request_restart'),
            callback_data: `request_restart:${auction.chat_id}:${auction.message_id}`,
            style: 'primary'
        }]);
    }

    if (total > 1) {
        const row = [];
        row.push({text: t('admin.kb.prev'), callback_data: `${prefix}_prev:${index}`});
        row.push({text: `${index + 1} / ${total}`, callback_data: 'undefined'});
        row.push({text: t('admin.kb.next'), callback_data: `${prefix}_next:${index}`});
        buttons.push(row);
    }

    return {inline_keyboard: buttons};
}

/**
 * Creates the duration selection keyboard for user auction post.
 * 
 * @returns {Object} Inline keyboard object.
 */
export function makeUserPostDurationKb() {
    const buttons = [];
    for (let i = 1; i <= 7; i += 2) {
        const row = [];
        row.push({ text: t(`bid.kb.days_${i}`), callback_data: `user_post_dur:${i}` });
        if (i + 1 <= 7) {
            row.push({ text: t(`bid.kb.days_${i + 1}`), callback_data: `user_post_dur:${i + 1}` });
        }
        buttons.push(row);
    }
    buttons.push([{ text: t('common.cancel'), callback_data: 'user_post_cancel', style: 'danger' }]);
    return { inline_keyboard: buttons };
}

/**
 * Creates the time selection keyboard for user auction post.
 * 
 * @returns {Object} Inline keyboard object.
 */
export function makeUserPostTimeKb() {
    const buttons = [];
    for (let h = 9; h <= 21; h += 3) {
        const row = [];
        row.push({ text: t('bid.kb.time_h', { h }), callback_data: `user_post_time:${h}` });
        if (h + 1 <= 21) row.push({ text: t('bid.kb.time_h', { h: h + 1 }), callback_data: `user_post_time:${h + 1}` });
        if (h + 2 <= 21) row.push({ text: t('bid.kb.time_h', { h: h + 2 }), callback_data: `user_post_time:${h + 2}` });
        buttons.push(row);
    }
    buttons.push([{ text: t('common.cancel'), callback_data: 'user_post_cancel', style: 'danger' }]);
    return { inline_keyboard: buttons };
}

/**
 * Creates a cancel keyboard for user restart.
 * 
 * @param {boolean} hasSkip - If it should have a skip button.
 * @returns {Object} Inline keyboard object.
 */
export function makeUserRestartCancelKb(hasSkip = false) {
    const row = [];
    if (hasSkip) {
        row.push({ text: t('admin.kb.skip'), callback_data: 'restart_skip' });
    }
    row.push({ text: t('common.cancel'), callback_data: 'restart_cancel', style: 'danger' });
    return { inline_keyboard: [row] };
}

/**
 * Creates the keyboard for selecting restart duration.
 *
 * @returns {Object} Inline keyboard object.
 */
export function makeUserRestartDurationKb() {
    const buttons = [];
    const row1 = [1, 2, 3, 4].map(d => ({ text: d.toString(), callback_data: `restart_dur:${d}` }));
    const row2 = [5, 6, 7].map(d => ({ text: d.toString(), callback_data: `restart_dur:${d}` }));
    buttons.push(row1);
    buttons.push(row2);
    buttons.push([{ text: t('common.cancel'), callback_data: 'restart_cancel', style: 'danger' }]);
    return { inline_keyboard: buttons };
}

/**
 * Creates the keyboard for selecting restart time.
 *
 * @returns {Object} Inline keyboard object.
 */
export function makeUserRestartTimeKb() {
    const buttons = [];
    for (let h = 18; h <= 21; h += 2) {
        const row = [];
        row.push({ text: t('bid.kb.time_h', { h }), callback_data: `restart_time:${h}` });
        if (h + 1 <= 21) row.push({ text: t('bid.kb.time_h', { h: h + 1 }), callback_data: `restart_time:${h + 1}` });
        buttons.push(row);
    }
    buttons.push([{ text: t('common.cancel'), callback_data: 'restart_cancel', style: 'danger' }]);
    return { inline_keyboard: buttons };
}

/**
 * Creates the admin restart approval keyboard.
 * 
 * @param {number} userId - User ID who requested restart.
 * @param {number} chatId - Auction chat ID.
 * @param {number} msgId - Auction message ID.
 * @param {Object} params - New parameters for restart.
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminRestartRequestKb(userId, chatId, msgId, params = null) {
    let approveData = `adm_res_approve:${userId}:${chatId}:${msgId}`;
    if (params) {
        approveData += `:${params.min_bid}:${params.step}:${params.duration_days}:${params.hour}`;
    }
    return {
        inline_keyboard: [
            [
                { text: t('admin.kb.approve'), callback_data: approveData, style: 'success' },
                { text: t('admin.kb.reject'), callback_data: `adm_res_reject:${userId}:${chatId}:${msgId}`, style: 'danger' }
            ]
        ]
    };
}

/**
 * Creates the admin settings keyboard.
 *
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminSettingsKb() {
    return {
        inline_keyboard: [
            [
                {text: t('admin.settings_main'), callback_data: 'adm_settings_main'},
                {text: t('admin.settings_template'), callback_data: 'adm_settings_template'},
                {text: t('admin.settings_defaults'), callback_data: 'adm_settings_defaults'}
            ],
            [{text: t('admin.settings_admins'), callback_data: 'adm_admins'}],
            [{text: `🌐 ${t('admin.lang_button')}`, callback_data: 'adm_lang'}],
            [{text: `💰 ${t('admin.cur_button')}`, callback_data: 'adm_cur'}],
            [{text: t('common.back'), callback_data: 'adm_list', style: 'primary'}]
        ]
    };
}

/**
 * Creates the admin settings keyboard for main configuration.
 *
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminSettingsMainKb() {
    return {
        inline_keyboard: [
            [{text: '📺 Channel ID', callback_data: 'set_conf:CHANNEL_ID'}],
            [{text: '🏷 Contact Nickname', callback_data: 'set_conf:CONTACT_NICKNAME'}],
            [{text: '🤖 OpenAI API Key', callback_data: 'set_conf:OPENAI_API_KEY'}],
            [{text: '🕒 Timezone', callback_data: 'set_conf:TZ'}],
            [{text: t('common.back'), callback_data: 'adm_settings', style: 'primary'}]
        ]
    };
}

/**
 * Creates the admin settings keyboard for auction template.
 *
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminSettingsTemplateKb() {
    return {
        inline_keyboard: [
            [{text: `📢 ${t('admin.auction_header')}`, callback_data: 'set_conf:AUCTION_HEADER'}],
            [{text: `💰 ${t('admin.auction_min_bid_text')}`, callback_data: 'set_conf:AUCTION_MIN_BID_TEXT'}],
            [{text: `📈 ${t('admin.auction_bid_step_text')}`, callback_data: 'set_conf:AUCTION_BID_STEP_TEXT'}],
            [{text: `🕘 ${t('admin.auction_end_date_text')}`, callback_data: 'set_conf:AUCTION_END_DATE_TEXT'}],
            [{text: `📝 ${t('admin.auction_footer')}`, callback_data: 'set_conf:AUCTION_FOOTER'}],
            [{text: t('common.back'), callback_data: 'adm_settings', style: 'primary'}]
        ]
    };
}

/**
 * Creates the admin settings keyboard for default values.
 *
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminSettingsDefaultsKb() {
    return {
        inline_keyboard: [
            [{text: `📅 ${t('admin.def_days')}`, callback_data: 'set_conf:DEFAULT_END_DAYS'}],
            [{text: `🕒 ${t('admin.def_time')}`, callback_data: 'set_conf:DEFAULT_END_TIME'}],
            [{text: `⏳ ${t('admin.def_continuous')}`, callback_data: 'set_conf:CONTINUOUS_MINUTES'}],
            [{text: t('common.back'), callback_data: 'adm_settings', style: 'primary'}]
        ]
    };
}

/**
 * Creates the "is continuous" keyboard for post creation.
 *
 * @param {number} min - Extension minutes.
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminPostContinuousKb(min) {
    return {
        inline_keyboard: [
            [
                {text: t('admin.continuous_yes', {min}), callback_data: 'post_cont:1'},
                {text: t('admin.continuous_no'), callback_data: 'post_cont:0', style: 'primary'}
            ],
            [{text: t('bid.kb.cancel'), callback_data: 'post_cancel', style: 'danger'}]
        ]
    };
}

/**
 * Creates the keyboard for selecting a bid step.
 *
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminPostStepKb() {
    return {
        inline_keyboard: [
            [
                {text: '10', callback_data: 'post_step:10'},
                {text: '25', callback_data: 'post_step:25'},
                {text: '50', callback_data: 'post_step:50'}
            ],
            [
                {text: '100', callback_data: 'post_step:100'},
                {text: '200', callback_data: 'post_step:200'},
                {text: t('admin.kb.custom'), callback_data: 'post_step:custom'}
            ],
            [{text: t('common.cancel'), callback_data: 'post_cancel', style: 'danger'}]
        ]
    };
}

/**
 * Creates the "is continuous" keyboard for post creation for users.
 *
 * @param {number} min - Extension minutes.
 * @returns {Object} Inline keyboard object.
 */
export function makeUserPostContinuousKb(min) {
    return {
        inline_keyboard: [
            [
                {text: t('admin.continuous_yes', {min}), callback_data: 'user_post_cont:1', style: 'success'},
                {text: t('admin.continuous_no'), callback_data: 'user_post_cont:0', style: 'primary'}
            ],
            [{text: t('common.cancel'), callback_data: 'user_post_cancel', style: 'danger'}]
        ]
    };
}

/**
 * Creates the keyboard for selecting a bid step for users.
 *
 * @returns {Object} Inline keyboard object.
 */
export function makeUserPostStepKb() {
    return {
        inline_keyboard: [
            [
                {text: '50', callback_data: 'user_post_step:50'},
                {text: '100', callback_data: 'user_post_step:100'},
                {text: '200', callback_data: 'user_post_step:200'}
            ],
            [
                {text: '500', callback_data: 'user_post_step:500'},
                {text: t('admin.kb.custom'), callback_data: 'user_post_step:custom', style: 'primary'}
            ],
            [{text: t('common.cancel'), callback_data: 'user_post_cancel', style: 'danger'}]
        ]
    };
}

/**
 * Creates the confirmation keyboard for user auction posting.
 *
 * @returns {Object} Inline keyboard object.
 */
export function makeUserPostConfirmKb() {
    return {
        inline_keyboard: [
            [{text: t('admin.kb.ai_confirm'), callback_data: 'user_post_confirm', style: 'success'}],
            [{text: t('common.cancel'), callback_data: 'user_post_cancel', style: 'danger'}]
        ]
    };
}

/**
 * Creates the duration selection keyboard for admin auction post.
 * 
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminPostDurationKb() {
    const buttons = [];
    const row1 = [1, 2, 3, 4].map(d => ({ text: d.toString(), callback_data: `post_dur:${d}` }));
    const row2 = [5, 6, 7, 10, 14].map(d => ({ text: d.toString(), callback_data: `post_dur:${d}` }));
    buttons.push(row1);
    buttons.push(row2);
    buttons.push([{ text: t('admin.kb.skip'), callback_data: 'post_skip', style: 'primary' }]);
    buttons.push([{ text: t('common.cancel'), callback_data: 'post_cancel', style: 'danger' }]);
    return { inline_keyboard: buttons };
}

/**
 * Creates a simple cancel keyboard for auction posting.
 *
 * @param {boolean} [includeSkip=false] - Whether to include a skip button.
 * @param {boolean} [isUser=false] - Whether this is for a user post.
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminPostCancelKb(includeSkip = false, isUser = false, includeContinue = false) {
    const row = [];
    if (includeSkip) {
        row.push({
            text: t('admin.kb.skip'), 
            callback_data: isUser ? 'user_post_skip' : 'post_skip', 
            style: 'primary'
        });
    }
    if (includeContinue) {
        row.push({
            text: t('admin.kb.continue'), 
            callback_data: isUser ? 'user_post_continue' : 'post_continue', 
            style: 'success'
        });
    }
    row.push({
        text: t('common.cancel'), 
        callback_data: isUser ? 'user_post_cancel' : 'post_cancel', 
        style: 'danger'
    });
    return {inline_keyboard: [row]};
}

/**
 * Creates a keyboard with an option to generate description using AI.
 *
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminPostAIGenKb() {
    return {
        inline_keyboard: [
            [{text: t('admin.kb.ai_gen'), callback_data: 'post_ai_gen', style: 'success'}],
            [{text: t('admin.kb.skip'), callback_data: 'post_skip', style: 'primary'}],
            [{text: t('common.cancel'), callback_data: 'post_cancel', style: 'danger'}]
        ]
    };
}

/**
 * Creates a keyboard for confirming or editing AI-generated text.
 *
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminPostAIConfirmKb() {
    return {
        inline_keyboard: [
            [
                {text: t('admin.kb.ai_confirm'), callback_data: 'post_ai_confirm', style: 'success'},
                {text: t('admin.kb.ai_edit'), callback_data: 'post_ai_edit', style: 'primary'}
            ],
            [{text: t('common.cancel'), callback_data: 'post_cancel', style: 'danger'}]
        ]
    };
}

/**
 * Creates the keyboard for selecting an admin contact.
 *
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminPostContactKb() {
    return {
        inline_keyboard: [
            [{text: t('admin.kb.enter_contact_manually'), callback_data: 'post_contact:manual'}],
            [{text: t('admin.kb.use_settings_contact'), callback_data: 'post_contact:default', style: 'primary'}],
            [{text: t('common.cancel'), callback_data: 'post_cancel', style: 'danger'}]
        ]
    };
}

/**
 * Creates the confirmation keyboard for posting an auction.
 *
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminPostConfirmKb() {
    return {
        inline_keyboard: [
            [{text: t('admin.kb.post_now'), callback_data: 'post_confirm', style: 'success'}],
            [{text: t('common.cancel'), callback_data: 'post_cancel', style: 'danger'}]
        ]
    };
}


/**
 * Creates the language selection keyboard for admins.
 *
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminLangKb() {
    return {
        inline_keyboard: [
            [{text: t('admin.lang_uk'), callback_data: 'set_lang:uk'}],
            [{text: t('admin.lang_en'), callback_data: 'set_lang:en'}],
            [{text: t('common.back'), callback_data: 'adm_settings', style: 'primary'}]
        ]
    };
}

/**
 * Creates the keyboard with a list of recently finished auctions.
 *
 * @param {Array} auctions - List of finished auction objects.
 * @param {number} page - Current page number.
 * @param {number} totalCount - Total count of finished auctions.
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminFinishedKb(auctions, page = 0, totalCount = 0) {
    const cur = getCurrency();
    const buttons = auctions.map(a => ([
        {text: `🏁 ${a.title} - ${a.current_price} ${cur}`, callback_data: `adm_view:${a.chat_id}:${a.message_id}`}
    ]));

    // Pagination
    const totalPages = Math.ceil(totalCount / 10);
    if (totalPages > 1) {
        const row = [];
        if (page > 0) {
            row.push({ text: '⬅️', callback_data: `adm_finished:${page - 1}` });
        }
        row.push({ text: `${page + 1} / ${totalPages}`, callback_data: 'none' });
        if (page < totalPages - 1) {
            row.push({ text: '➡️', callback_data: `adm_finished:${page + 1}` });
        }
        buttons.push(row);
    }

    buttons.push([{text: t('admin.kb.back_to_panel'), callback_data: 'adm_list', style: 'primary'}]);
    return {inline_keyboard: buttons};
}

/**
 * Creates the action keyboard for a specific auction in the admin panel.
 *
 * @param {number} chatId - Chat ID.
 * @param {number} messageId - Message ID.
 * @param {string} status - Current status of the auction.
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminAuctionActionKb(chatId, messageId, status) {
    const buttons = [];
    if (status === 'finished') {
        buttons.push([{
            text: t('admin.kb.restart'),
            callback_data: `adm_restart:${chatId}:${messageId}`,
            style: 'primary'
        }]);
        buttons.push([{
            text: t('admin.kb.delete_auction'),
            callback_data: `adm_delete:${chatId}:${messageId}`,
            style: 'danger'
        }]);
    } else if (status === 'active') {
        buttons.push([{
            text: t('admin.kb.finish_now'),
            callback_data: `adm_finish_now:${chatId}:${messageId}`,
            style: 'danger'
        }]);
    }

    buttons.push([{
        text: t('admin.kb.undo_bid'),
        callback_data: `adm_undo_bid:${chatId}:${messageId}`,
        style: 'danger'
    }]);

    if (status === 'finished') {
        buttons.push([{text: t('common.back'), callback_data: 'adm_finished', style: 'primary'}]);
    } else {
        buttons.push([{text: t('common.back'), callback_data: 'adm_active', style: 'primary'}]);
    }
    return {inline_keyboard: buttons};
}

/**
 * Creates a confirmation keyboard for placing a bid.
 *
 * @param {number} chatId - Chat ID.
 * @param {number} msgId - Message ID.
 * @param {number} price - Bid amount.
 * @returns {Object} Inline keyboard object.
 */
export function confirmBidKb(chatId, msgId, price) {
    return {
        inline_keyboard: [
            [
                {
                    text: t('bid.kb.confirm', {price}),
                    callback_data: `confbid:${chatId}:${msgId}:${price}`,
                    style: 'success'
                },
                {text: t('bid.kb.manual'), callback_data: `manualbid:${chatId}:${msgId}`, style: 'primary'}
            ],
            [
                {text: t('bid.kb.cancel'), callback_data: 'cancelbid', style: 'danger'}
            ]
        ]
    };
}

/**
 * Creates a confirmation keyboard for a manual bid.
 *
 * @param {number} chatId - Chat ID.
 * @param {number} msgId - Message ID.
 * @param {number} price - Bid amount.
 * @returns {Object} Inline keyboard object.
 */
export function confirmManualBidKb(chatId, msgId, price) {
    return {
        inline_keyboard: [
            [
                {
                    text: t('bid.kb.confirm', {price}),
                    callback_data: `confbid:${chatId}:${msgId}:${price}`,
                    style: 'success'
                },
                {text: t('bid.kb.cancel'), callback_data: 'cancelbid', style: 'danger'}
            ]
        ]
    };
}

/**
 * Creates a keyboard for finished auctions with no bids.
 *
 * @returns {Object} Inline keyboard object.
 */
export function makeEmptyFinishKb() {
    return {
        inline_keyboard: [
            [{text: t('bid.kb.no_bids'), callback_data: 'none', style: 'danger'}]
        ]
    };
}

/**
 * Creates the winner banner keyboard with a link to the winner's profile.
 *
 * @param {number} leaderId - Winner's user ID.
 * @param {string} leaderName - Winner's display name.
 * @param {number} price - Final price.
 * @param {boolean} includeLink - Whether to include the link to the winner's profile.
 * @returns {Object} Inline keyboard object.
 */
export function winnerKeyboard(leaderId, leaderName, price, includeLink = true) {
    const cur = getCurrency();
    const button = {text: `🏆 ${price} ${cur} : ${leaderName}`, style: 'success'};
    if (includeLink) {
        button.url = `tg://user?id=${leaderId}`;
    } else {
        button.callback_data = `winner_info:${leaderId}`;
    }
    return {
        inline_keyboard: [[button]]
    };
}

/**
 * Creates the admin list keyboard with delete buttons.
 *
 * @param {Array} admins - List of admin objects {user_id, username}.
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminListKb(admins) {
    const buttons = admins.map(a => ([
        {text: `${a.username || a.user_id}`, callback_data: 'none'},
        {text: t('admin.kb.delete_admin'), callback_data: `adm_del:${a.user_id}`, style: 'danger'}
    ]));
    buttons.push([{text: t('common.back'), callback_data: 'adm_settings', style: 'primary'}]);
    return {inline_keyboard: buttons};
}

/**
 * Creates a keyboard for outbid notification.
 *
 * @param {number} chatId - Chat ID.
 * @param {number} msgId - Message ID.
 * @param {number} nextPrice - Recommended next bid amount.
 * @returns {Object} Inline keyboard object.
 */
export function makeOutbidKb(chatId, msgId, nextPrice) {
    const absChatId = Math.abs(chatId);
    const username = BOT_USERNAME || 'bot';
    const url = `https://t.me/${username}?start=bid_${absChatId}_${msgId}`;
    const cur = getCurrency();

    return {
        inline_keyboard: [
            [{text: t('bid.kb.increase_bid', {price: nextPrice, cur}), url: url, style: 'success'}]
        ]
    };
}

/**
 * Creates a confirmation keyboard for broadcast.
 *
 * @returns {Object} Inline keyboard object.
 */
export function makeAdminBroadcastConfirmKb() {
    return {
        inline_keyboard: [
            [{text: t('admin.kb.broadcast_send'), callback_data: 'broadcast_confirm', style: 'success'}],
            [{text: t('common.cancel'), callback_data: 'broadcast_cancel', style: 'danger'}]
        ]
    };
}
