/**
 * Main entry point of the Telegram Auction Bot.
 * Initializes the bot, loads settings, registers handlers, and restores jobs.
 */
import { Telegraf } from 'telegraf';
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

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 30_000 });

// Handlers
registerCallbackHandler(bot);
registerChannelPostHandler(bot);
registerAdminHandlers(bot);

// Restore scheduled jobs (після рестарту)
restoreJobs(bot);

// Start
bot.launch().then(() => {
    console.log('Auction bot started. Timezone:', TZ);
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
