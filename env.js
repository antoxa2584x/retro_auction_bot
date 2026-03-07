import 'dotenv/config';
import { q } from './db.js';

function getSetting(key, defaultValue) {
    try {
        const row = q.getSetting.get(key);
        return row ? row.value : defaultValue;
    } catch (e) {
        return defaultValue;
    }
}

export const BOT_TOKEN   = process.env.BOT_TOKEN;
export const TZ          = process.env.TZ || 'Europe/Kyiv';
export const BOT_USERNAME = process.env.BOT_USERNAME || 'RetroAuctionTestBot';
export const CHANNEL_USERNAME = process.env.CHANNEL_USERNAME;

// Dynamic settings
export const getChannelId = () => {
    const val = getSetting('CHANNEL_ID', process.env.CHANNEL_ID);
    return val ? Number(val) : null;
};
export const getAdminId = () => {
    const val = getSetting('ADMIN_ID', process.env.ADMIN_ID);
    return val ? Number(val) : null;
};
export const getAdminNickname = () => getSetting('ADMIN_NICKNAME', process.env.ADMIN_NICKNAME || 'admin');

// For backward compatibility or one-time checks
export const CHANNEL_ID  = process.env.CHANNEL_ID ? Number(process.env.CHANNEL_ID) : null;
export const ADMIN_ID = process.env.ADMIN_ID ? Number(process.env.ADMIN_ID) : null;
export const ADMIN_NICKNAME = process.env.ADMIN_NICKNAME || 'admin';

if (!BOT_TOKEN) {
    console.error('Please set BOT_TOKEN in .env');
    process.exit(1);
}
