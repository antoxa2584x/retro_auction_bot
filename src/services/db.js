import Database from 'better-sqlite3';

export const db = new Database('auction.sqlite3');
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS auctions
    (
        chat_id INTEGER,
        message_id INTEGER,
        title TEXT,
        full_text TEXT,
        photo_id TEXT,
        min_bid INTEGER,
        step INTEGER,
        current_price INTEGER,
        leader_id INTEGER,
        leader_name TEXT,
        end_at TEXT,
        status TEXT DEFAULT 'active',
        participants_count INTEGER DEFAULT 0,
        PRIMARY KEY (chat_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS bids
    (
        chat_id INTEGER,
        message_id INTEGER,
        user_id INTEGER,
        amount INTEGER,
        ts TEXT
    );

    CREATE TABLE IF NOT EXISTS participants
    (
        chat_id INTEGER,
        message_id INTEGER,
        user_id INTEGER,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        PRIMARY KEY (chat_id, message_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS admins
    (
        user_id INTEGER PRIMARY KEY,
        username TEXT,
        otp_code TEXT,
        otp_expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings
    (
        key TEXT PRIMARY KEY,
        value TEXT
    );
`);

// Migration: add missing columns to auctions table if they don't exist
const columns = db.prepare("PRAGMA table_info(auctions)").all();
const columnNames = columns.map(c => c.name);

const migrations = [
    { name: 'full_text', type: 'TEXT' },
    { name: 'photo_id', type: 'TEXT' },
    { name: 'participants_count', type: 'INTEGER DEFAULT 0' }
];

for (const m of migrations) {
    if (!columnNames.includes(m.name)) {
        console.log(`Migrating: Adding column ${m.name} to auctions table`);
        db.exec(`ALTER TABLE auctions ADD COLUMN ${m.name} ${m.type}`);
    }
}

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

// 4) count total bids
const countBids = db.prepare(`
  SELECT COUNT(*) AS cnt
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
      (chat_id, message_id, title, full_text, photo_id, min_bid, step, current_price, leader_id, leader_name, end_at, status, participants_count)
    VALUES (@chat_id, @message_id, @title, @full_text, @photo_id, @min_bid, @step, @current_price, NULL, NULL, @end_at, 'active', 0)
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
  checkBidExists: db.prepare(`SELECT 1 FROM bids WHERE chat_id=? AND message_id=? AND amount=? LIMIT 1`),

  // NEW:
  getParticipatingAuctions: db.prepare(`
    SELECT DISTINCT a.*
      FROM auctions a
      JOIN bids b ON a.chat_id=b.chat_id AND a.message_id=b.message_id
     WHERE b.user_id=? AND a.status='active'
  `),
  getWonAuctions: db.prepare(`
    SELECT *
      FROM auctions
     WHERE status='finished' AND leader_id=?
     ORDER BY end_at DESC
     LIMIT 10
  `),

  // Admin related
  getAdmin: db.prepare(`SELECT * FROM admins WHERE user_id=?`),
  upsertAdminOtp: db.prepare(`
    INSERT INTO admins (user_id, username, otp_code, otp_expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username=excluded.username, otp_code=excluded.otp_code, otp_expires_at=excluded.otp_expires_at
  `),
  verifyOtp: db.prepare(`
    UPDATE admins 
       SET otp_code=NULL, otp_expires_at=NULL 
     WHERE user_id=? AND otp_code=? AND otp_expires_at > ?
  `),
  setAdmin: db.prepare(`
    INSERT INTO admins (user_id, username)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET username=excluded.username
  `),
  getAllAdmins: db.prepare(`SELECT user_id FROM admins WHERE otp_code IS NULL`),
  getAllActiveAuctions: db.prepare(`SELECT * FROM auctions WHERE status='active' ORDER BY end_at ASC`),
  getRecentlyFinishedAuctions: db.prepare(`SELECT * FROM auctions WHERE status='finished' ORDER BY end_at DESC LIMIT 10`),
  restartAuction: db.prepare(`
    UPDATE auctions 
       SET status='active', end_at=?, current_price=min_bid, leader_id=NULL, leader_name=NULL, participants_count=0
     WHERE chat_id=? AND message_id=?
  `),

  // Settings related
  getSetting: db.prepare(`SELECT value FROM settings WHERE key=?`),
  setSetting: db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`),

  // NEW:
  getLastBid,
  deleteBidByRowId,
  getNewLeader,
  countBids,
  resetAuctionNoBids
};

/**
 * Places a bid atomically.
 * Checks if the auction is still active and if the price is still the expected one.
 * Returns { success: true, ... } or { success: false, reason: '...' }
 */
export const placeBidTransaction = db.transaction((chat_id, message_id, user, price) => {
    // 1. Get current auction state with a lock (SQLite's WAL mode and transactions handle this)
    const auction = q.getAuction.get(chat_id, message_id);
    if (!auction) return { success: false, reason: 'not_found' };

    // 2. Check if active
    const now = new Date();
    const end = new Date(auction.end_at);
    if (now >= end || auction.status !== 'active') {
        return { success: false, reason: 'finished' };
    }

    // 3. Check if price is still correct
    const expectedPrice = auction.leader_id ? auction.current_price + auction.step : auction.current_price;
    
    // Check if bid with this amount already exists from ANY user
    const bidExists = q.checkBidExists.get(chat_id, message_id, price);
    if (bidExists) {
        return { success: false, reason: 'bid_exists', expectedPrice };
    }

    if (price !== expectedPrice) {
        return { success: false, reason: 'price_changed', expectedPrice };
    }

    // 4. Upsert participant
    q.upsertParticipant.run(
        chat_id, message_id, user.id,
        user.username || null, user.first_name || null, user.last_name || null
    );

    // 5. Insert bid
    q.insertBid.run(chat_id, message_id, user.id, price, now.toISOString());

    // 6. Update auction state
    const bidsCount = q.countBids.get(chat_id, message_id);
    const finalParticipants = bidsCount?.cnt ?? 0;
    const leaderName = user.first_name + (user.last_name ? ` ${user.last_name}` : '');

    q.updateState.run(
        price,
        user.id,
        leaderName,
        finalParticipants,
        chat_id, message_id
    );

    return { 
        success: true, 
        previousLeaderId: auction.leader_id,
        auctionTitle: auction.title,
        participantsCount: finalParticipants
    };
});
