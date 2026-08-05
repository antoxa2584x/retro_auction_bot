/**
 * Main entry point of the Telegram Auction Bot.
 * Initializes the bot, loads settings, registers handlers, and restores jobs.
 */
import TelegramBot from 'node-telegram-bot-api';
import schedule from 'node-schedule';
import { BOT_TOKEN, TZ, setBotUsername } from './config/env.js';
import { registerCallbackHandler } from './handlers/callbacks.js';
import { registerChannelPostHandler } from './handlers/channelPost.js';
import { registerAdminHandlers } from './handlers/admin.js';
import { restoreJobs } from './services/scheduler.js';
import { q } from './services/db.js';
import { setLocale, setCurrency } from './services/i18n.js';
import { logInfo, logError, pruneOldLogs, LOG_RETENTION_DAYS } from './services/logger.js';

// Load global locale from DB
q.initDefaults();
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

// Get and set bot username
bot.getMe().then((me) => {
    setBotUsername(me.username);
    console.log(`Bot username set to: @${me.username}`);
}).catch((err) => {
    console.error('Error fetching bot info:', err.message);
});

// Handlers
registerCallbackHandler(bot);
registerChannelPostHandler(bot);
registerAdminHandlers(bot);

// Error handling
bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, error.message);
});

// Safety net: node-telegram-bot-api does not catch rejections thrown inside
// async event listeners. Without this an unhandled rejection (e.g. a user who
// blocked the bot mid-handler) would crash the whole process.
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason?.message || reason);
    // To disk as well: a rejection swallowed mid-handler is how an auction ends up
    // posted to the channel with no row behind it.
    logError('unhandled_rejection', { error: reason instanceof Error ? reason : { message: String(reason) } });
});

// Keep roughly a week of log files. Checked once a day rather than once a week so
// the window stays a week; a bot restarted more often than that would otherwise
// never reach its prune. Runs at startup too, in case the process was down.
pruneOldLogs();
schedule.scheduleJob('log-prune', '30 4 * * *', () => pruneOldLogs());

// Restore scheduled jobs
restoreJobs(bot);

console.log('Auction bot started. Timezone:', TZ);
logInfo('bot_started', { timezone: TZ, pid: process.pid, log_retention_days: LOG_RETENTION_DAYS });
