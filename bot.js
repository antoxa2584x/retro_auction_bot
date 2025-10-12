import { Telegraf } from 'telegraf';
import { BOT_TOKEN, TZ } from './env.js';
import { registerCallbackHandler } from './handlers/callbacks.js';
import { registerChannelPostHandler } from './handlers/channelPost.js';
import { restoreJobs } from './scheduler.js';

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 30_000 });

// Handlers
registerCallbackHandler(bot);
registerChannelPostHandler(bot);

// Restore scheduled jobs (після рестарту)
restoreJobs(bot);

// Start
bot.launch().then(() => {
    console.log('Auction bot started. Timezone:', TZ);
});

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
