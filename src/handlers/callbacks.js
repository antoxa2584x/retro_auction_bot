import { registerUserCommands } from './user/commands.js';
import { registerBidHandlers } from './user/bids.js';
import { registerInfoHandlers } from './user/info.js';
import { registerNotificationHandlers } from './user/notifications.js';

export function registerCallbackHandler(bot) {
    registerUserCommands(bot);
    registerBidHandlers(bot);
    registerInfoHandlers(bot);
    registerNotificationHandlers(bot);
}
