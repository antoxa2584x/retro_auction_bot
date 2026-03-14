/**
 * Main entry point of the Telegram Auction Bot.
 * Initializes the bot, loads settings, registers handlers, and restores jobs.
 */
import TelegramBot from 'node-telegram-bot-api';
import { BOT_TOKEN, TZ } from './config/env.js';
import { registerCallbackHandler } from './handlers/callbacks.js';
import { registerChannelPostHandler } from './handlers/channelPost.js';
import { registerAdminHandlers } from './handlers/admin.js';
import { restoreJobs } from './services/scheduler.js';
import { q } from './services/db.js';
import { setLocale, setCurrency } from './services/i18n.js';

// Load global locale from DB
const dbLocale = q.getSetting.get('LOCALE')?.value;
if (dbLocale) {
    setLocale(dbLocale);
}

// Load global currency from DB
const dbCurrency = q.getSetting.get('CURRENCY')?.value;
if (dbCurrency) {
    setCurrency(dbCurrency);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Handlers
registerCallbackHandler(bot);
registerChannelPostHandler(bot);
registerAdminHandlers(bot);

// Catch-all for unanswered callback queries to prevent "query is too old" errors
bot.on('callback_query', async (query) => {
    try {
        await bot.answerCallbackQuery(query.id);
    } catch (e) {
        // Silently ignore if already answered
    }
});

// Restore scheduled jobs
restoreJobs(bot);

console.log('Auction bot started. Timezone:', TZ);

// Error handling
bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, error.message);
});
