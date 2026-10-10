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

/** The list is cheap to build but polled by every open page (every 10s). */
const LIST_TTL_MS = 5 * 1000;
/** Finished lots only change when an auction closes; nobody polls this list. */
const SOLD_TTL_MS = 60 * 1000;
const SOLD_PAGE_MAX = 60;
/** file_ids never change for an auction, so resized photos can be kept a while. */
const PHOTO_CACHE_MAX = 400;
const PHOTO_WIDTH = 640;

/**
 * Old channel posts were saved with the post header ("🎮 Аукціон!") as their
 * title and no text to recover a name from; the page shows "lot #id" instead.
 */
const GENERIC_TITLE = /^[^\p{L}\p{N}]*(аукціон|аукцион|auction)[^\p{L}\p{N}]*$/iu;

/** Status hashtags occasionally leaked into old titles ("… #активний"). */
const STATUS_TAG = /#(активний|завершений|active|finished)(?=\s|$)/giu;

const cleanTitle = (title) => (title || '').replace(STATUS_TAG, '').replace(/\s+/g, ' ').trim();

let listCache = { at: 0, body: null };
let soldCache = { at: 0, rows: [] };
const photoCache = new Map(); // file_id -> Buffer (insertion order = LRU order)
const photoInFlight = new Map(); // file_id -> Promise<Buffer>
let channelUsername = null;

function postUrl(chatId, messageId) {
    return channelUsername
        ? `https://t.me/${channelUsername}/${messageId}`
        : getAuctionLink(chatId, messageId);
}

function getSoldRows() {
    const now = Date.now();
    if (now - soldCache.at < SOLD_TTL_MS) return soldCache.rows;

    const channelId = getChannelId();
    const rows = channelId
        ? q.selectSoldForWeb.all(channelId).map((a) => {
            const cleaned = cleanTitle(a.title);
            const title = cleaned && !GENERIC_TITLE.test(cleaned) ? cleaned : null;
            return {
                id: a.message_id,
                title,
                price: a.current_price,
                participants: a.participants_count || 0,
                // Lots finished early from the admin panel keep their planned,
                // still-future end date, which would read as nonsense here.
                endedAt: Date.parse(a.end_at) <= now ? a.end_at : null,
                byAdmin: !!a.by_admin,
                hasPhoto: !!a.photo_id,
                postUrl: postUrl(channelId, a.message_id),
                search: (title || '').toLocaleLowerCase(),
            };
        })
        : [];
    soldCache = { at: now, rows };
    return rows;
}

/**
 * One page of sold lots. Filtering is done here rather than in SQL: SQLite's
 * LIKE only folds ASCII case, and nearly every title is Cyrillic.
 */
function buildSoldPage(params) {
    const words = (params.get('q') || '').toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const by = params.get('by');
    const offset = Math.max(0, parseInt(params.get('offset'), 10) || 0);
    const limit = Math.min(SOLD_PAGE_MAX, Math.max(1, parseInt(params.get('limit'), 10) || 24));

    let rows = getSoldRows().filter((a) =>
        (by !== 'admin' || a.byAdmin) &&
        (by !== 'users' || !a.byAdmin) &&
        words.every((w) => a.search.includes(w)));
    if (params.get('sort') === 'price') rows = [...rows].sort((a, b) => b.price - a.price);

    return JSON.stringify({
        currency: getCurrency(),
        total: rows.length,
        offset,
        auctions: rows.slice(offset, offset + limit).map(({ search, ...a }) => a),
    });
}

function buildList() {
    const now = Date.now();
    if (listCache.body && now - listCache.at < LIST_TTL_MS) return listCache.body;

    const botName = BOT_USERNAME || 'retro_auction_bot';
    const auctions = q.selectActiveForWeb.all().map((a) => ({
        id: a.message_id,
        title: cleanTitle(a.title),
        price: a.current_price ?? a.min_bid,
        minBid: a.min_bid,
        step: a.step,
        endAt: a.end_at,
        participants: a.participants_count || 0,
        continuous: !!a.is_continuous,
        byAdmin: !!a.by_admin,
        hasPhoto: !!a.photo_id,
        postUrl: postUrl(a.chat_id, a.message_id),
        bidUrl: `https://t.me/${botName}?start=bid_${Math.abs(a.chat_id)}_${a.message_id}`,
    }));

    const body = JSON.stringify({
        currency: getCurrency(),
        channelUrl: channelUsername ? `https://t.me/${channelUsername}` : null,
        // Same flow as the bot menu's "submit auction"; null while users can't post.
        addUrl: isUserPostEnabled() ? `https://t.me/${botName}?start=post` : null,
        updatedAt: new Date(now).toISOString(),
        soldTotal: getSoldRows().length,
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
            .then((chat) => {
                channelUsername = chat.username || null;
                // Both lists may already hold t.me/c/ links built before this resolved.
                listCache.at = 0;
                soldCache.at = 0;
            })
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
                    'Cache-Control': 'public, max-age=5',
                });
            }

            if (url.pathname === '/api/auctions/finished') {
                return send(res, 200, buildSoldPage(url.searchParams), {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'public, max-age=60',
                });
            }

            const photoMatch = url.pathname.match(/^\/api\/auctions\/(\d+)\/photo$/);
            if (photoMatch) {
                const row = q.getWebPhotoId.get(getChannelId(), Number(photoMatch[1]));
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
