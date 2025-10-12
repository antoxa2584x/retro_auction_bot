import 'dotenv/config';
import {Telegraf} from 'telegraf';
import Database from 'better-sqlite3';
import schedule from 'node-schedule';
import {addYears, isBefore, parse, setYear} from 'date-fns';
import {toZonedTime} from 'date-fns-tz';

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHANNEL_ID = Number(process.env.CHANNEL_ID);
const COMMENTS_ID = Number(process.env.COMMENTS_ID);
const TZ = process.env.TZ || 'Europe/Kyiv';

if (!BOT_TOKEN || !CHANNEL_ID) {
    console.error('Please set BOT_TOKEN and CHANNEL_ID in .env');
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN, {handlerTimeout: 30_000});

// ---------- DB ----------
const db = new Database('auction.sqlite3');
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS auctions
    (
        chat_id
        INTEGER,
        message_id
        INTEGER,
        title
        TEXT,
        min_bid
        INTEGER,
        step
        INTEGER,
        current_price
        INTEGER,
        leader_id
        INTEGER,
        leader_name
        TEXT,
        end_at
        TEXT,
        status
        TEXT
        DEFAULT
        'active',
        participants_count
        INTEGER
        DEFAULT
        0,
        discussion_chat_id
        INTEGER,
        PRIMARY
        KEY
    (
        chat_id,
        message_id
    )
        );
    CREATE TABLE IF NOT EXISTS bids
    (
        chat_id
        INTEGER,
        message_id
        INTEGER,
        user_id
        INTEGER,
        amount
        INTEGER,
        ts
        TEXT
    );
    CREATE TABLE IF NOT EXISTS participants
    (
        chat_id
        INTEGER,
        message_id
        INTEGER,
        user_id
        INTEGER,
        username
        TEXT,
        PRIMARY
        KEY
    (
        chat_id,
        message_id,
        user_id
    )
        );
`);

const qInsertAuction = db.prepare(`
    INSERT
    OR REPLACE INTO auctions
(chat_id, message_id, title, min_bid, step, current_price, leader_id, leader_name, end_at, status, participants_count, discussion_chat_id)
VALUES (@chat_id, @message_id, @title, @min_bid, @step, @current_price, NULL, NULL, @end_at, 'active', 0, @discussion_chat_id)
`);
const qGetAuction = db.prepare(`SELECT *
                                FROM auctions
                                WHERE chat_id = ?
                                  AND message_id = ?`);
const qUpdateState = db.prepare(`
    UPDATE auctions
    SET current_price=?,
        leader_id=?,
        leader_name=?,
        participants_count=?
    WHERE chat_id = ?
      AND message_id = ?
`);
const qFinish = db.prepare(`UPDATE auctions
                            SET status='finished'
                            WHERE chat_id = ?
                              AND message_id = ?`);
const qInsertBid = db.prepare(`INSERT INTO bids (chat_id, message_id, user_id, amount, ts)
                               VALUES (?, ?, ?, ?, ?)`);
const qAddParticipant = db.prepare(`INSERT
OR IGNORE INTO participants (chat_id, message_id, user_id, username) VALUES (?, ?, ?, ?)`);

// ---------- Helpers ----------
const reMin = /Мінімальна\s+ставка:\s*([\d\s]+)\s*грн/i;
const reStep = /Крок\s+ставки:\s*([\d\s]+)\s*грн/i;
const reEnd = /Завершення\s+аукціону:\s*([0-3]?\d\.[01]?\d)\s*о\s*([0-2]?\d:[0-5]\d)/i;

function parsePost(text) {
    const m1 = reMin.exec(text || '');
    const m2 = reStep.exec(text || '');
    const m3 = reEnd.exec(text || '');
    if (!m1 || !m2 || !m3) throw new Error('Не знайшов мінімальну ставку, крок або час завершення');

    const minBid = parseInt(m1[1].replace(/\s+/g, ''), 10);
    const step = parseInt(m2[1].replace(/\s+/g, ''), 10);

    // build end date in timezone
    const [dd, mm] = m3[1].split('.').map(Number);
    const [HH, MM] = m3[2].split(':').map(Number);
    const nowZ = toZonedTime(new Date(), TZ);
    let end = setYear(parse(`${dd}.${mm} ${HH}:${MM}`, 'd.M H:mm', nowZ), nowZ.getFullYear());
    if (isBefore(end, nowZ)) end = addYears(end, 1);
    return {minBid, step, end};
}

function getDiscussionId() {
    return COMMENTS_ID;
}

function scheduleClose(ctx, chat_id, message_id, when) {
    const id = `${chat_id}:${message_id}`;
    schedule.cancelJob(id);
    schedule.scheduleJob(id, when, async () => closeAuction(ctx, chat_id, message_id));
}

async function closeAuction(ctx, chat_id, message_id) {
    const row = qGetAuction.get(chat_id, message_id);
    if (!row || row.status !== 'active') return;

    if (row.leader_id) {
        qFinish.run(chat_id, message_id);
        try {
            await ctx.telegram.editMessageReplyMarkup(chat_id, message_id, null, winnerKeyboard(row.leader_id, row.leader_name, row.current_price));
        } catch {
        }
    } else {
        qFinish.run(chat_id, message_id);

        await ctx.telegram.editMessageReplyMarkup(
            chat_id,
            message_id,
            null,
            makeEmptyFinishKb(chat_id, message_id)
        );
    }
}


// ---------- Bids (callback) ----------
bot.on('callback_query', async ctx => {
    const data = ctx.callbackQuery.data || '';
    if (!data.startsWith('bid:')) return;
    const [, chatIdStr, msgIdStr] = data.split(':');
    const chat_id = Number(chatIdStr);
    const message_id = Number(msgIdStr);

    const row = qGetAuction.get(chat_id, message_id);
    if (!row) {
        await ctx.answerCbQuery('Аукціон не знайдено', {show_alert: true});
        return;
    }
    if (row.status !== 'active') {
        await ctx.answerCbQuery('Аукціон завершено', {show_alert: true});
        return;
    }

    const now = new Date();
    const end = new Date(row.end_at);
    if (now >= end) {
        await ctx.answerCbQuery('Аукціон завершено', {show_alert: true});
        await closeAuction(ctx, chat_id, message_id);
        return;
    }

    const user = ctx.from;
    const newPrice = row.leader_id ? row.current_price + row.step : row.current_price; // first keeps minBid
    let participants = row.participants_count;

    const ins = qAddParticipant.run(chat_id, message_id, user.id, user.username || '');
    if (ins.changes > 0) participants += 1;

    qUpdateState.run(newPrice, user.id, user.first_name + (user.last_name ? ` ${user.last_name}` : ''), participants, chat_id, message_id);
    qInsertBid.run(chat_id, message_id, user.id, newPrice, new Date().toISOString());

    // Update the button
    try {
        await ctx.telegram.editMessageReplyMarkup(
            chat_id,
            message_id,
            null,
            makeKb(chat_id, message_id, newPrice, participants, null)
        );
    } catch {
    }

    await ctx.answerCbQuery(`Ваша ставка: ${newPrice} грн`);
});

// ---------- Restore schedules on restart ----------
(function restoreJobs() {
    const rows = db.prepare(`SELECT chat_id, message_id, end_at, status
                             FROM auctions
                             WHERE status = 'active'`).all();
    for (const r of rows) {
        const when = new Date(r.end_at);
        if (when > new Date()) {
            scheduleClose(bot, r.chat_id, r.message_id, when);
        } else {
            // if past due, close shortly after start
            setTimeout(() => closeAuction(bot, r.chat_id, r.message_id), 2_000);
        }
    }
})();

// ---------- Start ----------
bot.launch().then(() => {
    console.log('Auction bot started. Timezone:', TZ);
});

// keyboard
function makeKb(chatId, msgId, price, participants, leader) {
    const t = `${participants===0 ? '🟡' : '🟢'} Ставка: ${price} грн • Учасників: ${participants}` + (leader ? ` • Лідер: ${leader}` : '');
    return {inline_keyboard: [[{text: t, callback_data: `bid:${chatId}:${msgId}`}]]};
}

// keyboard
function makeEmptyFinishKb(chatId, msgId) {
    return {inline_keyboard: [[{text: '🔴 Фініш! Ставок не було.', callback_data: `bid:${chatId}:${msgId}`}]]};
}

function winnerKeyboard(leaderId, leaderName, price) {
    const url = `tg://user?id=${leaderId}`;

    return {inline_keyboard: [[{text: `🏁 Переможець: ${leaderName} • ${price} грн`, url}]]};
}

bot.on('channel_post', async (ctx) => {
    const post = ctx.channelPost;
    if (!post || post.chat.id !== CHANNEL_ID) return;

    const text = post.text || post.caption || '';
    let parsed;
    try {
        parsed = parsePost(text);
    } catch {
        return;
    }

    const {minBid, step, end} = parsed;
    const discussionId = getDiscussionId();
    if (!discussionId) return console.warn('No linked discussion group.');

    const title = text.split('\n')[0] || 'Аукціон';

    qInsertAuction.run({
        chat_id: post.chat.id,
        message_id: post.message_id,
        title,
        min_bid: minBid,
        step,
        current_price: minBid,
        end_at: end.toISOString(),
        discussion_chat_id: discussionId
    });

    // Update the keyboard callback to include the final msg id (so it matches)
    const finalKb = makeKb(post.chat.id, post.message_id, minBid, 0, null);

    await attachKbToMedia(ctx, post, finalKb)

    scheduleClose(ctx, post.chat.id, post.message_id, end);
});

async function attachKbToMedia(ctx, post, kb) {
    try {
        const reply = await ctx.telegram.editMessageCaption(
            post.chat.id,
            post.message_id,
            null,
            post.caption,
            {
                reply_markup: kb,
                parse_mode: 'HTML',
                caption_entities: post.caption_entities
            }
        );

        console.log(reply);
    } catch (e) {
        console.log(e)
    }
}

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
