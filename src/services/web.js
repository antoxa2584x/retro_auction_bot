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
import { getCategories } from './categories.js';

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
/** The lot page's gallery (and search engines) get a larger copy. */
const PHOTO_WIDTH_LARGE = 1280;

/**
 * Old channel posts were saved with the post header ("🎮 Аукціон!") as their
 * title and no text to recover a name from; the page shows "lot #id" instead.
 */
const GENERIC_TITLE = /^[^\p{L}\p{N}]*(аукціон|аукцион|auction)[^\p{L}\p{N}]*$/iu;

/** Status hashtags occasionally leaked into old titles ("… #активний"). */
const STATUS_TAG = /#(активний|завершений|active|finished)(?=\s|$)/giu;

const cleanTitle = (title) => (title || '').replace(STATUS_TAG, '').replace(/\s+/g, ' ').trim();

/** A lot's name for the website, or null for the old posts that have none. */
function lotTitle(title) {
    const cleaned = cleanTitle(title);
    return cleaned && !GENERIC_TITLE.test(cleaned) ? cleaned : null;
}

/**
 * Every photo of a lot, main one first. Lots posted before photo_ids was
 * tracked only have their main photo.
 */
function photoList(a) {
    const ids = (a.photo_ids || '').split(',').filter(Boolean);
    if (a.photo_id && !ids.includes(a.photo_id)) ids.unshift(a.photo_id);
    return ids;
}

// Ukrainian national transliteration (plus the few Russian letters that show up).
// Same as tg-store's slugify, which renders these pages for search engines.
const TRANSLIT = {
    а: 'a', б: 'b', в: 'v', г: 'h', ґ: 'g', д: 'd', е: 'e', є: 'ie', ж: 'zh', з: 'z', и: 'y', і: 'i', ї: 'i', й: 'i',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch',
    ш: 'sh', щ: 'shch', ь: '', ю: 'iu', я: 'ia', ы: 'y', э: 'e', ё: 'e', ъ: '',
};

/** The lot's page on the site, e.g. /auctions/9363-ps3-call-of-duty-ghosts. */
function lotPath(id, title) {
    const slug = (title || '')
        .toLowerCase()
        .replace(/[ʼ'’`"«»]/g, '')
        .replace(/./g, (c) => TRANSLIT[c] ?? c)
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        // Cut long titles at a whole word.
        .replace(/^(.{0,70})(-.*)?$/, '$1')
        .slice(0, 90) || 'lot';
    return `/auctions/${id}-${slug}`;
}

/**
 * Lines of the post that come after the lot's own text: the seller credit, the
 * bid terms (🟢/🔵/🔸, 🕘, ♻️) and the channel's footer links.
 */
const POST_FOOTER = /^(?:лот від|🟢|🔵|🔸|🕘|♻|🏆|мінімальна ставка|крок ставки|завершення аукціону|виставити свій лот|всі активні аукціони|зробити ставку|щоб зробити ставку)/iu;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

/**
 * The seller's description from the channel post: the text between the lot's
 * name and the bid terms, without the "🎮 Аукціон!" header or the HTML.
 */
function lotDescription(fullText, title) {
    const lines = (fullText || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENTITIES[e])
        .split('\n')
        .map((l) => l.trim());
    const flat = (s) => s.replace(STATUS_TAG, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    let i = 0;
    const skipBlank = () => { while (i < lines.length && !lines[i]) i++; };
    skipBlank();
    if (i < lines.length && GENERIC_TITLE.test(cleanTitle(lines[i]))) i++;
    skipBlank();
    if (i < lines.length && title && flat(lines[i]) === flat(title)) i++;
    const out = [];
    for (; i < lines.length && !POST_FOOTER.test(lines[i]); i++) out.push(lines[i]);
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

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

function bidUrl(chatId, messageId) {
    return `https://t.me/${BOT_USERNAME || 'retro_auction_bot'}?start=bid_${Math.abs(chatId)}_${messageId}`;
}

/**
 * One lot for its page on the site: the list fields plus the seller's
 * description. Lots that closed without a bid aren't shown anywhere, so they
 * count as missing.
 */
function buildLot(id) {
    const channelId = getChannelId();
    const a = channelId && q.getWebAuction.get(channelId, id);
    if (!a || (a.status !== 'active' && !a.has_winner)) return null;
    const active = a.status === 'active';
    const title = active ? cleanTitle(a.title) : lotTitle(a.title);
    const now = Date.now();
    return JSON.stringify({
        currency: getCurrency(),
        id: a.message_id,
        title,
        path: lotPath(a.message_id, title),
        description: lotDescription(a.full_text, a.title),
        status: active ? 'active' : 'sold',
        price: a.current_price ?? a.min_bid,
        minBid: a.min_bid,
        step: a.step,
        endAt: a.end_at,
        // Same rule as the sold list: lots finished early ended at their last bid.
        endedAt: active ? null : Date.parse(a.end_at) <= now ? a.end_at : a.last_bid_at,
        participants: a.participants_count || 0,
        continuous: !!a.is_continuous,
        byAdmin: !!a.by_admin,
        category: a.category || null,
        photos: photoList(a).length,
        postUrl: postUrl(channelId, a.message_id),
        bidUrl: active ? bidUrl(channelId, a.message_id) : null,
    });
}

/** Every lot that has a page, for the site's sitemap: active ones, then sold. */
function buildIndex() {
    const active = q.selectActiveForWeb.all()
        .filter((a) => a.chat_id === getChannelId())
        .map((a) => ({
            id: a.message_id,
            title: cleanTitle(a.title),
            path: lotPath(a.message_id, cleanTitle(a.title)),
            status: 'active',
            photos: photoList(a).length,
        }));
    const sold = getSoldRows()
        .filter((a) => a.title)
        .map((a) => ({ id: a.id, title: a.title, path: a.path, status: 'sold', photos: a.photos, endedAt: a.endedAt }));
    return JSON.stringify({ lots: [...active, ...sold] });
}

function getSoldRows() {
    const now = Date.now();
    if (now - soldCache.at < SOLD_TTL_MS) return soldCache.rows;

    const channelId = getChannelId();
    const rows = channelId
        ? q.selectSoldForWeb.all(channelId).map((a) => {
            const title = lotTitle(a.title);
            return {
                id: a.message_id,
                title,
                path: lotPath(a.message_id, title),
                price: a.current_price,
                participants: a.participants_count || 0,
                // Lots finished early from the admin panel keep their planned,
                // still-future end date; their last bid is the closest thing
                // to when they actually ended.
                endedAt: Date.parse(a.end_at) <= now ? a.end_at : a.last_bid_at,
                byAdmin: !!a.by_admin,
                category: a.category || null,
                hasPhoto: !!a.photo_id,
                photos: photoList(a).length,
                postUrl: postUrl(channelId, a.message_id),
                search: (title || '').toLocaleLowerCase(),
            };
        })
        : [];
    // Most recently ended first; the few lots with no known end time go last.
    rows.sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || '') || b.id - a.id);
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
    const category = params.get('cat');
    const offset = Math.max(0, parseInt(params.get('offset'), 10) || 0);
    const limit = Math.min(SOLD_PAGE_MAX, Math.max(1, parseInt(params.get('limit'), 10) || 24));

    let rows = getSoldRows().filter((a) =>
        (by !== 'admin' || a.byAdmin) &&
        (by !== 'users' || !a.byAdmin) &&
        (!category || a.category === category) &&
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

    const auctions = q.selectActiveForWeb.all().map((a) => ({
        id: a.message_id,
        title: cleanTitle(a.title),
        path: lotPath(a.message_id, cleanTitle(a.title)),
        price: a.current_price ?? a.min_bid,
        minBid: a.min_bid,
        step: a.step,
        endAt: a.end_at,
        participants: a.participants_count || 0,
        continuous: !!a.is_continuous,
        byAdmin: !!a.by_admin,
        category: a.category || null,
        hasPhoto: !!a.photo_id,
        photos: photoList(a).length,
        postUrl: postUrl(a.chat_id, a.message_id),
        bidUrl: bidUrl(a.chat_id, a.message_id),
    }));

    const botName = BOT_USERNAME || 'retro_auction_bot';
    const body = JSON.stringify({
        currency: getCurrency(),
        channelUrl: channelUsername ? `https://t.me/${channelUsername}` : null,
        // Same flow as the bot menu's "submit auction"; null while users can't post.
        addUrl: isUserPostEnabled() ? `https://t.me/${botName}?start=post` : null,
        updatedAt: new Date(now).toISOString(),
        soldTotal: getSoldRows().length,
        // The admin's list, in their order, for the page's category filter.
        categories: getCategories(),
        auctions,
    });
    listCache = { at: now, body };
    return body;
}

async function fetchPhoto(bot, fileId, width = PHOTO_WIDTH) {
    const key = `${fileId}:${width}`;
    const cached = photoCache.get(key);
    if (cached) {
        photoCache.delete(key);
        photoCache.set(key, cached);
        return cached;
    }
    if (photoInFlight.has(key)) return photoInFlight.get(key);

    const job = (async () => {
        const link = await bot.getFileLink(fileId);
        const res = await fetch(link);
        if (!res.ok) throw new Error(`Telegram file fetch failed: ${res.status}`);
        const input = Buffer.from(await res.arrayBuffer());
        const out = await sharp(input)
            .resize({ width, withoutEnlargement: true })
            .jpeg({ quality: 78, mozjpeg: true })
            .toBuffer();
        photoCache.set(key, out);
        if (photoCache.size > PHOTO_CACHE_MAX) photoCache.delete(photoCache.keys().next().value);
        return out;
    })();
    photoInFlight.set(key, job);
    try {
        return await job;
    } finally {
        photoInFlight.delete(key);
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

            if (url.pathname === '/api/auctions/index') {
                return send(res, 200, buildIndex(), {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'public, max-age=60',
                });
            }

            const lotMatch = url.pathname.match(/^\/api\/auctions\/item\/(\d+)$/);
            if (lotMatch) {
                const body = buildLot(Number(lotMatch[1]));
                if (!body) return send(res, 404, 'Not Found');
                return send(res, 200, body, {
                    'Content-Type': 'application/json; charset=utf-8',
                    'Cache-Control': 'public, max-age=5',
                });
            }

            // The list's main photo (/api/auctions/:id/photo), and every photo of
            // a lot in the larger size: /api/auctions/:id/photo/:n, or
            // /auction-photos/:id/:n.jpg outside /api/ so search engines may index it.
            const photoMatch = url.pathname.match(/^\/api\/auctions\/(\d+)\/photo(?:\/(\d+))?$/) ||
                url.pathname.match(/^\/auction-photos\/(\d+)\/(\d+)\.jpg$/);
            if (photoMatch) {
                const row = q.getWebPhotoId.get(getChannelId(), Number(photoMatch[1]));
                const n = photoMatch[2] === undefined ? 0 : Number(photoMatch[2]);
                const fileId = row && photoList(row)[n];
                if (!fileId) return send(res, 404, 'Not Found');
                const img = await fetchPhoto(bot, fileId, photoMatch[2] === undefined ? PHOTO_WIDTH : PHOTO_WIDTH_LARGE);
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
