import 'dotenv/config';

export const BOT_TOKEN   = process.env.BOT_TOKEN;
export const CHANNEL_ID  = Number(process.env.CHANNEL_ID);
export const COMMENTS_ID = Number(process.env.COMMENTS_ID);
export const ADMIN_ID = Number(process.env.ADMIN_ID);
export const TZ          = process.env.TZ || 'Europe/Kyiv';

if (!BOT_TOKEN || !CHANNEL_ID) {
    console.error('Please set BOT_TOKEN and CHANNEL_ID in .env');
    process.exit(1);
}
