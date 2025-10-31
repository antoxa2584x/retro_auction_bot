import Database from 'better-sqlite3';

export const db = new Database('auction.sqlite3');
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
        first_name
        TEXT,
        last_name
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

//
// Helpers for undo-last-bid
//

// 1) last bid (the most recent by ts DESC)
const getLastBid = db.prepare(`
  SELECT rowid AS rid, chat_id, message_id, user_id, amount, ts
    FROM bids
   WHERE chat_id=? AND message_id=?
   ORDER BY ts DESC
   LIMIT 1
`); // NEW

// 2) delete bid by rowid
const deleteBidByRowId = db.prepare(`
  DELETE FROM bids
   WHERE rowid=?
`); // NEW

// 3) after we remove the last bid, we need the NEW last bid (again ts DESC LIMIT 1)
const getNewLeader = db.prepare(`
  SELECT b.user_id, b.amount, b.ts,
         p.username, p.first_name, p.last_name
    FROM bids b
    LEFT JOIN participants p
      ON p.chat_id=b.chat_id AND p.message_id=b.message_id AND p.user_id=b.user_id
   WHERE b.chat_id=? AND b.message_id=?
   ORDER BY b.ts DESC
   LIMIT 1
`); // NEW

// 4) count unique participants still having at least one bid
const countUniqueParticipants = db.prepare(`
  SELECT COUNT(DISTINCT user_id) AS cnt
    FROM bids
   WHERE chat_id=? AND message_id=?
`); // NEW

// 5) reset auction to "no bids" state
const resetAuctionNoBids = db.prepare(`
  UPDATE auctions
     SET current_price=min_bid,
         leader_id=NULL,
         leader_name=NULL,
         participants_count=0
   WHERE chat_id=? AND message_id=?
`); // NEW

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
  selectActive: db.prepare(`SELECT chat_id, message_id, end_at FROM auctions WHERE status='active'`),

  // NEW:
  getLastBid,
  deleteBidByRowId,
  getNewLeader,
  countUniqueParticipants,
  resetAuctionNoBids
};
