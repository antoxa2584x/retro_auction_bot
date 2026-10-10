/**
 * Read-only HTTP API behind the website's /auctions page.
 *
 * Listens on localhost only; nginx proxies /api/ to it. Lives inside the bot
 * process so it can reuse the DB statements and the bot instance (photos are
 * stored as Telegram file_ids and can only be fetched with the bot token).
 */
import http from 'node:http';
import sharp from 'sharp';
import { q } from './db.js';
import { getChannelId, BOT_USERNAME, isUserPostEnabled } from '../config/env.js';
import { getCurrency } from './i18n.js';
import { getAuctionLink } from '../utils/utils.js';
import { logInfo, logError } from './logger.js';

const PORT = Number(process.env.WEB_PORT) || 3010;
const HOST = process.env.WEB_HOST || '127.0.0.1';

/** The list is cheap to build but polled by every open page. */
const LIST_TTL_MS = 15 * 1000;
/** file_ids never change for an auction, so resized photos can be kept a while. */
const PHOTO_CACHE_MAX = 200;
const PHOTO_WIDTH = 640;

let listCache = { at: 0, body: null };
const photoCache = new Map(); // file_id -> Buffer (insertion order = LRU order)
const photoInFlight = new Map(); // file_id -> Promise<Buffer>
let channelUsername = null;

function buildList() {
    const now = Date.now();
    if (listCache.body && now - listCache.at < LIST_TTL_MS) return listCache.body;

    const botName = BOT_USERNAME || 'retro_auction_bot';
    const auctions = q.selectActiveForWeb.all().map((a) => ({
        id: a.message_id,
        title: a.title,
        price: a.current_price ?? a.min_bid,
        minBid: a.min_bid,
        step: a.step,
        endAt: a.end_at,
        participants: a.participants_count || 0,
        continuous: !!a.is_continuous,
        byAdmin: !!a.by_admin,
        hasPhoto: !!a.photo_id,
        postUrl: channelUsername
            ? `https://t.me/${channelUsername}/${a.message_id}`
            : getAuctionLink(a.chat_id, a.message_id),
        bidUrl: `https://t.me/${botName}?start=bid_${Math.abs(a.chat_id)}_${a.message_id}`,
    }));

    const body = JSON.stringify({
        currency: getCurrency(),
        channelUrl: channelUsername ? `https://t.me/${channelUsername}` : null,
        // Same flow as the bot menu's "submit auction"; null while users can't post.
        addUrl: isUserPostEnabled() ? `https://t.me/${botName}?start=post` : null,
        updatedAt: new Date(now).toISOString(),
        auctions,
    });
    listCache = { at: now, body };
    return body;
}

async function fetchPhoto(bot, fileId) {
    const cached = photoCache.get(fileId);
    if (cached) {
        photoCache.delete(fileId);
        photoCache.set(fileId, cached);
        return cached;
    }
    if (photoInFlight.has(fileId)) return photoInFlight.get(fileId);

    const job = (async () => {
        const link = await bot.getFileLink(fileId);
        const res = await fetch(link);
        if (!res.ok) throw new Error(`Telegram file fetch failed: ${res.status}`);
        const input = Buffer.from(await res.arrayBuffer());
        const out = await sharp(input)
            .resize({ width: PHOTO_WIDTH, withoutEnlargement: true })
            .jpeg({ quality: 78, mozjpeg: true })
            .toBuffer();
        photoCache.set(fileId, out);
        if (photoCache.size > PHOTO_CACHE_MAX) photoCache.delete(photoCache.keys().next().value);
        return out;
    })();
    photoInFlight.set(fileId, job);
    try {
        return await job;
    } finally {
        photoInFlight.delete(fileId);
    }
}

function send(res, status, body, headers = {}) {
    res.writeHead(status, headers);
    res.end(body);
}

/**
 * Starts the API server. Failures are logged and never thrown, so the website
 * side can't take the bot down.
 *
 * @param {import('node-telegram-bot-api')} bot
 */
export function startWebServer(bot) {
    const channelId = getChannelId();
    if (channelId) {
        bot.getChat(channelId)
            .then((chat) => { channelUsername = chat.username || null; listCache.at = 0; })
            .catch((err) => logError('web_channel_lookup_failed', { error: err }));
    }

    const server = http.createServer(async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            return send(res, 405, 'Method Not Allowed', { Allow: 'GET, HEAD' });
        }
        const url = new URL(req.url, 'http://localhost');

        try {
            if (url.pathname === '/api/auctions') {
                return send(res, 200, buildList(), {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'public, max-age=15',
                });
            }

            const photoMatch = url.pathname.match(/^\/api\/auctions\/(\d+)\/photo$/);
            if (photoMatch) {
                const row = q.getActivePhotoId.get(Number(photoMatch[1]));
                if (!row?.photo_id) return send(res, 404, 'Not Found');
                const img = await fetchPhoto(bot, row.photo_id);
                return send(res, 200, img, {
                    'Content-Type': 'image/jpeg',
                    'Cache-Control': 'public, max-age=86400',
                });
            }

            return send(res, 404, 'Not Found');
        } catch (err) {
            logError('web_request_failed', { path: url.pathname, error: err });
            if (!res.headersSent) send(res, 500, 'Internal Server Error');
        }
    });

    server.on('error', (err) => logError('web_server_error', { error: err }));
    server.listen(PORT, HOST, () => {
        console.log(`Web API listening on http://${HOST}:${PORT}`);
        logInfo('web_server_started', { host: HOST, port: PORT });
    });
    return server;
}
