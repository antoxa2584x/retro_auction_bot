/**
 * Main entry point of the Telegram Auction Bot.
 * Initializes the bot, loads settings, registers handlers, and restores jobs.
 */
import TelegramBot from 'node-telegram-bot-api';
import { BOT_TOKEN, TZ, setBotUsername, WEBAPP_URL, POLLING } from './config/env.js';
import { registerCallbackHandler } from './handlers/callbacks.js';
import { registerChannelPostHandler } from './handlers/channelPost.js';
import { registerAdminHandlers } from './handlers/admin.js';
import { restoreJobs } from './services/scheduler.js';
import { q } from './services/db.js';
import { setLocale, setCurrency } from './services/i18n.js';
import { startServer } from './server.js';

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

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Set webhook or start polling
if (!POLLING) {
    bot.setWebHook(`${WEBAPP_URL}/bot${BOT_TOKEN}`)
        .then(() => console.log(`Webhook set to ${WEBAPP_URL}/bot${BOT_TOKEN}`))
        .catch((err) => console.error('Error setting webhook:', err.message));
} else {
    bot.deleteWebHook()
        .then(() => {
            bot.startPolling();
            console.log('Polling started (POLLING=true)');
        })
        .catch((err) => console.error('Error deleting webhook for polling:', err.message));
}

// Get and set bot username
bot.getMe().then((me) => {
    setBotUsername(me.username);
    console.log(`Bot username set to: @${me.username}`);
}).catch((err) => {
    console.error('Error fetching bot info:', err.message);
});

// Handlers
bot.on('message', (msg) => {
    console.log(`[Bot] Message from ${msg.from.username || msg.from.id}: ${msg.text || '[non-text message]'}`);
});

bot.on('callback_query', (query) => {
    console.log(`[Bot] Callback from ${query.from.username || query.from.id}: ${query.data}`);
});

registerCallbackHandler(bot);
registerChannelPostHandler(bot);
registerAdminHandlers(bot);

// Error handling
bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, error.message);
});

bot.on('webhook_error', (error) => {
    console.error('Webhook error:', error.message);
});

bot.on('error', (error) => {
    console.error('General bot error:', error.message);
});

// Restore scheduled jobs
restoreJobs(bot);

// Start Mini App & Webhook server
startServer(bot);

console.log('Auction bot started. Timezone:', TZ);
