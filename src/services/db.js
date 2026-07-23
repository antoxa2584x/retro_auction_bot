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
        admin_contact TEXT,
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
        first_name TEXT,
        last_name TEXT,
        otp_code TEXT,
        otp_expires_at TEXT
    );

    CREATE TABLE IF NOT EXISTS settings
    (
        key TEXT PRIMARY KEY,
        value TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_otp_requests
    (
        user_id INTEGER,
        request_date TEXT,
        count INTEGER DEFAULT 0,
        PRIMARY KEY (user_id, request_date)
    );

    CREATE TABLE IF NOT EXISTS ai_training_data
    (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        image_hash TEXT,
        final_text TEXT,
        locale TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pending_auctions
    (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        title TEXT,
        full_text TEXT,
        photo_ids TEXT, -- Comma-separated file_ids
        min_bid INTEGER,
        step INTEGER,
        end_at TEXT,
        is_continuous INTEGER DEFAULT 0,
        continuous_minutes INTEGER DEFAULT 5,
        status TEXT DEFAULT 'pending', -- pending, approved, rejected
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS support_messages
    (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        user_name TEXT,
        message TEXT,
        admin_reply TEXT,
        status TEXT DEFAULT 'open', -- open, closed
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        replied_at DATETIME
    );

    CREATE TABLE IF NOT EXISTS notifications
    (
        chat_id INTEGER,
        message_id INTEGER,
        user_id INTEGER,
        hours INTEGER,
        PRIMARY KEY (chat_id, message_id, user_id)
    );

    -- Covering index for the hot bid-path queries (getLastBid, getNewLeader,
    -- checkBidExists, selectBidsForInfo, getBidders) which all filter by
    -- (chat_id, message_id) and often order by ts.
    CREATE INDEX IF NOT EXISTS idx_bids_auction ON bids (chat_id, message_id, ts);
    CREATE INDEX IF NOT EXISTS idx_notifications_auction ON notifications (chat_id, message_id);

    -- Auction-list queries filter on these columns and would otherwise full-scan
    -- the auctions table (selectActive/getAllActiveAuctions, getCreatedAuctions,
    -- getWonAuctions).
    CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions (status);
    CREATE INDEX IF NOT EXISTS idx_auctions_creator ON auctions (creator_id);
    CREATE INDEX IF NOT EXISTS idx_auctions_leader ON auctions (status, leader_id);
`);

// Migration: add missing columns to auctions table if they don't exist
const columns = db.prepare("PRAGMA table_info(auctions)").all();
const columnNames = columns.map(c => c.name);

const migrations = [
    { name: 'full_text', type: 'TEXT' },
    { name: 'photo_id', type: 'TEXT' },
    { name: 'participants_count', type: 'INTEGER DEFAULT 0' },
    { name: 'admin_contact', type: 'TEXT' },
    { name: 'is_continuous', type: 'INTEGER DEFAULT 0' },
    { name: 'continuous_minutes', type: 'INTEGER DEFAULT 5' },
    { name: 'creator_id', type: 'INTEGER' },
    // Guards against two admins restarting the same finished auction: acts as a
    // one-time claim flag so only the first approval/restart is processed.
    { name: 'restart_handled', type: 'INTEGER DEFAULT 0' },
    // Comma-separated file_ids of ALL photos (main + gallery). photo_id above is
    // just photoIds[0]; this preserves the additional photos so a restart can
    // repost the full gallery.
    { name: 'photo_ids', type: 'TEXT' },
    // Comma-separated message_ids of the posted additional-photo gallery, so a
    // restart can delete the old gallery alongside the old main post.
    { name: 'gallery_msg_ids', type: 'TEXT' }
];

const adminColumns = db.prepare("PRAGMA table_info(admins)").all();
const adminColumnNames = adminColumns.map(c => c.name);
const adminMigrations = [
    { name: 'first_name', type: 'TEXT' },
    { name: 'last_name', type: 'TEXT' }
];

for (const m of adminMigrations) {
    if (!adminColumnNames.includes(m.name)) {
        console.log(`Migrating: Adding column ${m.name} to admins table`);
        db.exec(`ALTER TABLE admins ADD COLUMN ${m.name} ${m.type}`);
    }
}

for (const m of migrations) {
    if (!columnNames.includes(m.name)) {
        console.log(`Migrating: Adding column ${m.name} to auctions table`);
        db.exec(`ALTER TABLE auctions ADD COLUMN ${m.name} ${m.type}`);
    }
}

// Migration: titles were historically derived by truncating raw HTML to 50
// chars, which could split an HTML tag in half (e.g. a dangling "<b>"). When
// such a title is later embedded into another HTML message it breaks Telegram's
// parser ("Can't find end tag"). Strip leftover tags from existing titles once.
// (kept inline rather than importing utils.js to avoid a circular import)
const stripTitleTags = (title) =>
    title.replace(/<\/?[a-z1-6]+[^>]*>/gi, '').replace(/\s+/g, ' ').trim();

for (const table of ['auctions', 'pending_auctions']) {
    const broken = db.prepare(`SELECT rowid, title FROM ${table} WHERE title LIKE '%<%'`).all();
    if (broken.length === 0) continue;
    const updateTitle = db.prepare(`UPDATE ${table} SET title=? WHERE rowid=?`);
    const fixAll = db.transaction((rows) => {
        for (const row of rows) updateTitle.run(stripTitleTags(row.title), row.rowid);
    });
    fixAll(broken);
    console.log(`Migrating: stripped HTML tags from ${broken.length} ${table} title(s)`);
}

//
// Helpers for undo-last-bid
//

// 1) last bid (the most recent by ts DESC)
const getLastBid = db.prepare(`
  SELECT rowid AS rid, chat_id, message_id, user_id, amount, ts
    FROM bids
   WHERE chat_id=? AND message_id=?
   ORDER BY ts DESC, rowid DESC
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
   ORDER BY b.ts DESC, b.rowid DESC
   LIMIT 1
`); // NEW

// 4) count unique participants
const countParticipants = db.prepare(`
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

/**
 * Database access object containing prepared statements for all auction operations.
 */
export const q = {
  /**
   * Inserts a new auction or replaces an existing one.
   * @type {import('better-sqlite3').Statement}
   */
  insertAuction: db.prepare(`
    INSERT OR REPLACE INTO auctions
      (chat_id, message_id, title, full_text, photo_id, photo_ids, min_bid, step, current_price, leader_id, leader_name, admin_contact, end_at, status, participants_count, is_continuous, continuous_minutes, creator_id)
    VALUES (@chat_id, @message_id, @title, @full_text, @photo_id, @photo_ids, @min_bid, @step, @current_price, NULL, NULL, @admin_contact, @end_at, 'active', 0, @is_continuous, @continuous_minutes, @creator_id)
  `),

  /**
   * Stores the message_ids of an auction's posted additional-photo gallery.
   * Called after the gallery is sent (its message_ids aren't known at insert time).
   * @type {import('better-sqlite3').Statement}
   */
  setGalleryMsgIds: db.prepare(`UPDATE auctions SET gallery_msg_ids=? WHERE chat_id=? AND message_id=?`),

  /**
   * Retrieves an auction by its chat ID and message ID.
   * @type {import('better-sqlite3').Statement}
   */
  getAuction: db.prepare(`SELECT * FROM auctions WHERE chat_id=? AND message_id=?`),

  /**
   * Updates the current state of an auction (price, leader, participants count).
   * @type {import('better-sqlite3').Statement}
   */
  updateState: db.prepare(`
    UPDATE auctions
       SET current_price=?, leader_id=?, leader_name=?, participants_count=?, end_at=?
     WHERE chat_id=? AND message_id=?
  `),

  /**
   * Marks an auction as finished.
   * @type {import('better-sqlite3').Statement}
   */
  finish: db.prepare(`UPDATE auctions SET status='finished' WHERE chat_id=? AND message_id=?`),

  /**
   * Atomically claims a finished auction for restart so that only the first
   * admin who approves/restarts it succeeds. Returns `changes === 1` for the
   * winning claim and `changes === 0` when another admin already handled it.
   * @type {import('better-sqlite3').Statement}
   */
  claimRestart: db.prepare(`UPDATE auctions SET restart_handled=1 WHERE chat_id=? AND message_id=? AND restart_handled=0`),

  /**
   * Releases a previously-claimed restart so it can be retried after a failure.
   * @type {import('better-sqlite3').Statement}
   */
  releaseRestart: db.prepare(`UPDATE auctions SET restart_handled=0 WHERE chat_id=? AND message_id=?`),

  /**
   * Deletes an auction record.
   * @type {import('better-sqlite3').Statement}
   */
  deleteAuction: db.prepare(`DELETE FROM auctions WHERE chat_id=? AND message_id=?`),

  /**
   * Inserts a new bid into the history.
   * @type {import('better-sqlite3').Statement}
   */
  insertBid: db.prepare(`INSERT INTO bids (chat_id, message_id, user_id, amount, ts) VALUES (?, ?, ?, ?, ?)`),

  /**
   * Updates or inserts a participant's information.
   * @type {import('better-sqlite3').Statement}
   */
  upsertParticipant: db.prepare(`
    INSERT INTO participants (chat_id, message_id, user_id, username, first_name, last_name)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(chat_id, message_id, user_id) DO UPDATE SET
      username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name
  `),

  /**
   * Retrieves bid history for an auction, including participant names.
   * @type {import('better-sqlite3').Statement}
   */
  selectBidsForInfo: db.prepare(`
    SELECT b.user_id, b.amount, b.ts, p.username, p.first_name, p.last_name
      FROM bids b
      LEFT JOIN participants p
        ON p.chat_id=b.chat_id AND p.message_id=b.message_id AND p.user_id=b.user_id
     WHERE b.chat_id=? AND b.message_id=?
     ORDER BY b.ts ASC
  `),

  /**
   * Retrieves all unique bidders for a specific auction.
   * @type {import('better-sqlite3').Statement}
   */
  getBidders: db.prepare(`SELECT DISTINCT user_id FROM bids WHERE chat_id=? AND message_id=?`),

  /**
   * Selects all currently active auctions.
   * @type {import('better-sqlite3').Statement}
   */
  selectActive: db.prepare(`SELECT chat_id, message_id, end_at FROM auctions WHERE status='active' ORDER BY message_id DESC`),

  /**
   * Inserts a new training example for AI.
   * @type {import('better-sqlite3').Statement}
   */
  insertAiTrainingData: db.prepare(`
    INSERT INTO ai_training_data (image_hash, final_text, locale)
    VALUES (?, ?, ?)
  `),

  /**
   * Retrieves the most recent training examples for a specific locale.
   * @type {import('better-sqlite3').Statement}
   */
  getRecentAiTrainingData: db.prepare(`
    SELECT final_text FROM ai_training_data
    WHERE locale=?
    ORDER BY created_at DESC
    LIMIT 5
  `),

  /**
   * Checks if a specific bid amount already exists for an auction.
   * @type {import('better-sqlite3').Statement}
   */
  checkBidExists: db.prepare(`SELECT 1 FROM bids WHERE chat_id=? AND message_id=? AND amount=? LIMIT 1`),

  /**
   * Retrieves active auctions that a specific user is participating in.
   * @type {import('better-sqlite3').Statement}
   */
  getParticipatingAuctions: db.prepare(`
    SELECT DISTINCT a.*
      FROM auctions a
      JOIN bids b ON a.chat_id=b.chat_id AND a.message_id=b.message_id
     WHERE b.user_id=? AND a.status='active'
     ORDER BY a.message_id DESC
  `),

  /**
   * Retrieves auctions won by a specific user.
   * @type {import('better-sqlite3').Statement}
   */
  getWonAuctions: db.prepare(`
    SELECT *
      FROM auctions
     WHERE status='finished' AND leader_id=?
     ORDER BY message_id DESC
     LIMIT 10
  `),

  /**
   * Retrieves active auctions that a specific user has notifications for.
   * @type {import('better-sqlite3').Statement}
   */
  getWatchlistAuctions: db.prepare(`
    SELECT DISTINCT a.*
      FROM auctions a
      JOIN notifications n ON a.chat_id=n.chat_id AND a.message_id=n.message_id
     WHERE n.user_id=? AND a.status='active'
     ORDER BY a.message_id DESC
  `),

  /**
   * Retrieves auctions created by a specific user.
   * @type {import('better-sqlite3').Statement}
   */
  getCreatedAuctions: db.prepare(`
    SELECT *
      FROM auctions
     WHERE creator_id=?
     ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END, message_id DESC
  `),

  // Admin related

  /**
   * Retrieves admin information by user ID.
   * @type {import('better-sqlite3').Statement}
   */
  getAdmin: db.prepare(`SELECT * FROM admins WHERE user_id=?`),

  /**
   * Stores or updates an OTP code for an admin.
   * @type {import('better-sqlite3').Statement}
   */
  upsertAdminOtp: db.prepare(`
    INSERT INTO admins (user_id, username, first_name, last_name, otp_code, otp_expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name, 
      otp_code=excluded.otp_code, otp_expires_at=excluded.otp_expires_at
  `),

  /**
   * Verifies an OTP code and clears it if valid.
   * @type {import('better-sqlite3').Statement}
   */
  verifyOtp: db.prepare(`
    UPDATE admins 
       SET otp_code=NULL, otp_expires_at=NULL 
     WHERE user_id=? AND otp_code=? AND otp_expires_at > ?
  `),

  /**
   * Grants admin rights to a user.
   * @type {import('better-sqlite3').Statement}
   */
  setAdmin: db.prepare(`
    INSERT INTO admins (user_id, username)
    VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET username=excluded.username
  `),

  /**
   * Retrieves all verified admins (pending-OTP admins are excluded).
   * @type {import('better-sqlite3').Statement}
   */
  getAllAdmins: db.prepare(`SELECT * FROM admins WHERE otp_code IS NULL`),

  /**
   * Deletes an admin record.
   * @type {import('better-sqlite3').Statement}
   */
  deleteAdmin: db.prepare(`DELETE FROM admins WHERE user_id=?`),

  /**
   * Retrieves OTP requests count for a user on a specific date.
   * @type {import('better-sqlite3').Statement}
   */
  getOtpRequestsCount: db.prepare(`SELECT count FROM admin_otp_requests WHERE user_id=? AND request_date=?`),

  /**
   * Increments the OTP requests count for a user on a specific date.
   * @type {import('better-sqlite3').Statement}
   */
  incrementOtpRequestsCount: db.prepare(`
    INSERT INTO admin_otp_requests (user_id, request_date, count)
    VALUES (?, ?, 1)
    ON CONFLICT(user_id, request_date) DO UPDATE SET count = count + 1
  `),

  /**
   * Retrieves all active auctions for the admin panel.
   * @type {import('better-sqlite3').Statement}
   */
  getAllActiveAuctions: db.prepare(`SELECT * FROM auctions WHERE status='active' ORDER BY message_id DESC`),

  /**
   * Retrieves active auctions with pagination.
   */
  getActiveAuctionsPaginated: db.prepare(`SELECT * FROM auctions WHERE status='active' ORDER BY message_id DESC LIMIT ? OFFSET ?`),

  /**
   * Counts all active auctions.
   */
  countActiveAuctions: db.prepare(`SELECT COUNT(*) as count FROM auctions WHERE status='active'`),
  countActiveAuctionsByUser: db.prepare(`SELECT COUNT(*) as count FROM auctions WHERE creator_id = ? AND status = 'active'`),

  /**
   * Retrieves recently finished auctions for the admin panel.
   * @type {import('better-sqlite3').Statement}
   */
  getRecentlyFinishedAuctions: db.prepare(`SELECT * FROM auctions WHERE status='finished' ORDER BY message_id DESC LIMIT 10`),

  /**
   * Retrieves finished auctions with pagination.
   */
  getFinishedAuctionsPaginated: db.prepare(`SELECT * FROM auctions WHERE status='finished' ORDER BY message_id DESC LIMIT ? OFFSET ?`),

  /**
   * Counts all finished auctions.
   */
  countFinishedAuctions: db.prepare(`SELECT COUNT(*) as count FROM auctions WHERE status='finished'`),

  /**
   * Restarts a finished auction.
   * @type {import('better-sqlite3').Statement}
   */
  restartAuction: db.prepare(`
    UPDATE auctions 
       SET status='active', end_at=?, current_price=min_bid, leader_id=NULL, leader_name=NULL, participants_count=0
     WHERE chat_id=? AND message_id=?
  `),

  // Settings related

  /**
   * Retrieves a global setting by its key.
   * @type {import('better-sqlite3').Statement}
   */
  getSetting: db.prepare(`SELECT value FROM settings WHERE key=?`),

  /**
   * Sets or updates a global setting.
   * @type {import('better-sqlite3').Statement}
   */
  setSetting: db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`),

  /**
   * Initializes default settings if they don't exist.
   */
  initDefaults: () => {
    const defaults = [
      { key: 'CONTINUOUS_MINUTES', value: '5' },
      { key: 'TZ', value: 'UTC' },
      { key: 'LOCALE', value: 'uk' },
      { key: 'CURRENCY', value: 'грн' },
      { key: 'CONTACT_NICKNAME', value: null }
    ];
    // Migrate legacy ADMIN_NICKNAME to CONTACT_NICKNAME
    const legacy = q.getSetting.get('ADMIN_NICKNAME');
    if (legacy) {
        q.setSetting.run('CONTACT_NICKNAME', legacy.value);
        db.prepare("DELETE FROM settings WHERE key='ADMIN_NICKNAME'").run();
    }
    for (const d of defaults) {
      const exists = q.getSetting.get(d.key);
      if (!exists) {
          q.setSetting.run(d.key, d.value);
      }
    }
  },

  /**
   * Retrieves the most recent bid for an auction.
   * @type {import('better-sqlite3').Statement}
   */
  getLastBid,

  /**
   * Deletes a bid by its internal rowid.
   * @type {import('better-sqlite3').Statement}
   */
  deleteBidByRowId,

  /**
   * Retrieves the new leader information after a bid is removed.
   * @type {import('better-sqlite3').Statement}
   */
  getNewLeader,

  /**
   * Counts the total number of unique participants for an auction.
   * @type {import('better-sqlite3').Statement}
   */
  countParticipants,

  /**
   * Resets an auction to its initial "no bids" state.
   * @type {import('better-sqlite3').Statement}
   */
  resetAuctionNoBids,

  /**
   * Retrieves all unique user IDs who have interacted with auctions.
   * @type {import('better-sqlite3').Statement}
   */
  getAllUsers: db.prepare(`SELECT DISTINCT user_id FROM participants`),

  /**
   * Counts unique users who have interacted with auctions.
   * @type {import('better-sqlite3').Statement}
   */
  countUsers: db.prepare(`SELECT COUNT(DISTINCT user_id) AS cnt FROM participants`),

  /**
   * Updates the stored post text of an auction (used after a continuous-mode extension).
   * @type {import('better-sqlite3').Statement}
   */
  updateAuctionFullText: db.prepare(`UPDATE auctions SET full_text=? WHERE chat_id=? AND message_id=?`),

  // Users
  getUserFromAnywhere: db.prepare(`
    SELECT COALESCE(
      (SELECT first_name || (CASE WHEN last_name IS NOT NULL THEN ' ' || last_name ELSE '' END) FROM admins WHERE user_id = ?),
      (SELECT first_name || (CASE WHEN last_name IS NOT NULL THEN ' ' || last_name ELSE '' END) FROM participants WHERE user_id = ? LIMIT 1),
      (SELECT '@' || username FROM admins WHERE user_id = ? AND username IS NOT NULL),
      (SELECT '@' || username FROM participants WHERE user_id = ? AND username IS NOT NULL LIMIT 1)
    ) as name
  `),

  // Pending Auctions
  getPendingAuctions: db.prepare("SELECT * FROM pending_auctions WHERE status = 'pending' ORDER BY created_at DESC"),
  getPendingAuction: db.prepare("SELECT * FROM pending_auctions WHERE id = ?"),
  countApprovedAuctionsByUser: db.prepare("SELECT COUNT(*) as count FROM pending_auctions WHERE user_id = ? AND status = 'approved'"),
  countPendingAuctionsByUser: db.prepare("SELECT COUNT(*) as count FROM pending_auctions WHERE user_id = ? AND status = 'pending'"),
  insertPendingAuction: db.prepare(`
    INSERT INTO pending_auctions (user_id, title, full_text, photo_ids, min_bid, step, end_at, is_continuous, continuous_minutes)
    VALUES (:user_id, :title, :full_text, :photo_ids, :min_bid, :step, :end_at, :is_continuous, :continuous_minutes)
  `),
  updatePendingAuctionStatus: db.prepare("UPDATE pending_auctions SET status = ? WHERE id = ?"),
  deletePendingAuction: db.prepare("DELETE FROM pending_auctions WHERE id = ?"),

  // Notifications
  getNotification: db.prepare(`SELECT hours FROM notifications WHERE chat_id = ? AND message_id = ? AND user_id = ?`),
  setNotification: db.prepare(`INSERT OR REPLACE INTO notifications (chat_id, message_id, user_id, hours) VALUES (?, ?, ?, ?)`),
  deleteNotification: db.prepare(`DELETE FROM notifications WHERE chat_id = ? AND message_id = ? AND user_id = ?`),
  getAuctionNotifications: db.prepare(`SELECT user_id, hours FROM notifications WHERE chat_id = ? AND message_id = ?`),
  getAllActiveNotifications: db.prepare(`
    SELECT n.chat_id, n.message_id, n.user_id, n.hours, a.end_at, a.title
    FROM notifications n
    JOIN auctions a ON n.chat_id = a.chat_id AND n.message_id = a.message_id
    WHERE a.status = 'active'
  `),

  // Support messages
  insertSupportMessage: db.prepare(`
    INSERT INTO support_messages (user_id, user_name, message)
    VALUES (?, ?, ?)
  `),
  getSupportMessage: db.prepare(`SELECT * FROM support_messages WHERE id = ?`),
  getAllSupportMessages: db.prepare(`SELECT * FROM support_messages ORDER BY created_at DESC LIMIT 50`),
  // Only closes a message that is still open, so two admins replying at the
  // same time can't both deliver a reply. `changes === 0` means another admin
  // already answered it.
  updateSupportReply: db.prepare(`
    UPDATE support_messages
    SET admin_reply = ?, status = 'closed', replied_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'open'
  `)
};

/**
 * Removes the last bid from an auction atomically and updates its state.
 * Returns { success: true, ... } or { success: false, reason: '...' }
 */
export const undoLastBidTransaction = db.transaction((chat_id, message_id) => {
    const auction = q.getAuction.get(chat_id, message_id);
    if (!auction) return { success: false, reason: 'not_found' };

    const lastBid = q.getLastBid.get(chat_id, message_id);
    if (!lastBid) return { success: false, reason: 'no_bids' };

    // 1. Delete the last bid
    q.deleteBidByRowId.run(lastBid.rid);

    // 2. Get the new last bid
    const newLeader = q.getNewLeader.get(chat_id, message_id);
    const partCount = q.countParticipants.get(chat_id, message_id);
    const finalParticipants = partCount?.cnt ?? 0;

    if (newLeader) {
        const leaderName = newLeader.first_name + (newLeader.last_name ? ` ${newLeader.last_name}` : '');
        q.updateState.run(
            newLeader.amount,
            newLeader.user_id,
            leaderName,
            finalParticipants,
            auction.end_at,
            chat_id, message_id
        );
        return {
            success: true,
            removedBidUserId: lastBid.user_id,
            newLeaderId: newLeader.user_id,
            newLeaderName: leaderName,
            newPrice: newLeader.amount,
            participantsCount: finalParticipants,
            auctionTitle: auction.title
        };
    } else {
        // No bids left
        q.resetAuctionNoBids.run(chat_id, message_id);
        return {
            success: true,
            removedBidUserId: lastBid.user_id,
            newLeaderId: null,
            newLeaderName: null,
            newPrice: auction.min_bid,
            participantsCount: 0,
            auctionTitle: auction.title
        };
    }
});

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

    if (price < expectedPrice) {
        return { success: false, reason: 'price_changed', expectedPrice };
    }

    // 4. Handle continuous auction extension
    let newEndAt = auction.end_at;
    let timeExtended = false;

    if (auction.is_continuous) {
        const remainingMs = end.getTime() - now.getTime();
        const extensionMs = auction.continuous_minutes * 60 * 1000;
        
        if (remainingMs <= extensionMs) {
            // Extend from the bid time (now), not the current end. This guarantees a
            // fresh full window after every last-minute bid, matching the documented
            // behavior ("every bid within the last N minutes extends it by N minutes").
            // Since remainingMs <= extensionMs, (now + extensionMs) is always >= end,
            // so the end time can never be shortened.
            const extendedDate = new Date(now.getTime() + extensionMs);
            newEndAt = extendedDate.toISOString();
            timeExtended = true;
        }
    }

    // 5. Upsert participant
    q.upsertParticipant.run(
        chat_id, message_id, user.id,
        user.username || null, user.first_name || null, user.last_name || null
    );

    // 6. Insert bid
    q.insertBid.run(chat_id, message_id, user.id, price, now.toISOString());

    // 7. Update auction state
    const partCount = q.countParticipants.get(chat_id, message_id);
    const finalParticipants = partCount?.cnt ?? 0;
    const leaderName = user.first_name + (user.last_name ? ` ${user.last_name}` : '');

    q.updateState.run(
        price,
        user.id,
        leaderName,
        finalParticipants,
        newEndAt,
        chat_id, message_id
    );

    return { 
        success: true, 
        previousLeaderId: auction.leader_id,
        auctionTitle: auction.title,
        auctionStep: auction.step,
        participantsCount: finalParticipants,
        timeExtended,
        newEndAt
    };
});
