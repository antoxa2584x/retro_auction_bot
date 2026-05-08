import 'dotenv/config';
import {q} from '../services/db.js';

function getSetting(key, defaultValue) {
    try {
        const row = q.getSetting.get(key);
        return row ? row.value : defaultValue;
    } catch (e) {
        return defaultValue;
    }
}

export const BOT_TOKEN = process.env.BOT_TOKEN;
export const TZ = getSetting('TZ', 'UTC');
export let BOT_USERNAME = null;
export const setBotUsername = (username) => {
    BOT_USERNAME = username;
};
export const CHANNEL_USERNAME = getSetting('CHANNEL_USERNAME', null);

// Dynamic settings
export const getChannelId = () => {
    const val = getSetting('CHANNEL_ID', null);
    return val ? Number(val) : null;
};
export const getContactNickname = () => getSetting('CONTACT_NICKNAME', null);

// For backward compatibility or one-time checks
export const CHANNEL_ID = getChannelId();
export const CONTACT_NICKNAME = getContactNickname();
export const OPENAI_API_KEY = getSetting('OPENAI_API_KEY', null);

export const getMaxUserAuctions = () => {
    const val = getSetting('MAX_USER_AUCTIONS', '3');
    return parseInt(val);
};

export const isUserPostEnabled = () => {
    const val = getSetting('USER_POST_ENABLED', 'true');
    return val === 'true';
};

if (!BOT_TOKEN) {
    console.error('Please set BOT_TOKEN in .env');
    process.exit(1);
}
