import Database from 'better-sqlite3';

export const db = new Database('auction.sqlite3');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS auctions(
    chat_id INTEGER,
    message_id INTEGER,
    title TEXT,
    min_bid INTEGER,
    step INTEGER,
    current_price INTEGER,
    leader_id INTEGER,
    leader_name TEXT,
    end_at TEXT,
    status TEXT DEFAULT 'active',
    participants_count INTEGER DEFAULT 0,
    discussion_chat_id INTEGER,
    PRIMARY KEY(chat_id, message_id)
  );
  CREATE TABLE IF NOT EXISTS bids(
    chat_id INTEGER, message_id INTEGER, user_id INTEGER, amount INTEGER, ts TEXT
  );
  CREATE TABLE IF NOT EXISTS participants(
    chat_id INTEGER, message_id INTEGER, user_id INTEGER,
    username TEXT, first_name TEXT, last_name TEXT,
    PRIMARY KEY(chat_id, message_id, user_id)
  );
`);

export const q = {
    insertAuction: db.prepare(`
    INSERT OR REPLACE INTO auctions
      (chat_id, message_id, title, min_bid, step, current_price, leader_id, leader_name, end_at, status, participants_count, discussion_chat_id)
    VALUES (@chat_id, @message_id, @title, @min_bid, @step, @current_price, NULL, NULL, @end_at, 'active', 0, @discussion_chat_id)
  `),
    getAuction: db.prepare(`SELECT * FROM auctions WHERE chat_id=? AND message_id=?`),
    updateState: db.prepare(`
    UPDATE auctions
       SET current_price=?, leader_id=?, leader_name=?, participants_count=?
     WHERE chat_id=? AND message_id=?
  `),
    finish: db.prepare(`UPDATE auctions SET status='finished' WHERE chat_id=? AND message_id=?`),
    insertBid: db.prepare(`INSERT INTO bids (chat_id, message_id, user_id, amount, ts) VALUES (?, ?, ?, ?, ?)`),
    upsertParticipant: db.prepare(`
    INSERT INTO participants (chat_id, message_id, user_id, username, first_name, last_name)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, message_id, user_id) DO UPDATE SET
      username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name
  `),
    selectBidsForInfo: db.prepare(`
    SELECT b.user_id, b.amount, b.ts, p.username, p.first_name, p.last_name
      FROM bids b
      LEFT JOIN participants p
        ON p.chat_id=b.chat_id AND p.message_id=b.message_id AND p.user_id=b.user_id
     WHERE b.chat_id=? AND b.message_id=?
     ORDER BY b.ts ASC
  `),
    selectActive: db.prepare(`SELECT chat_id, message_id, end_at FROM auctions WHERE status='active'`)
};
