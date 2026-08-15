/**
 * Prints what MAX_USER_AUCTIONS counts for one user, so a "why can't I post?"
 * report can be answered without guessing.
 *
 * Usage, from the project root:  node scripts/check-user-limit.mjs <telegram_user_id>
 */
import Database from 'better-sqlite3';

const userId = Number(process.argv[2]);
if (!Number.isFinite(userId)) {
    console.error('Usage: node scripts/check-user-limit.mjs <telegram_user_id>');
    process.exit(1);
}

const db = new Database('auction.sqlite3', { readonly: true });

const max = Number(db.prepare("SELECT value FROM settings WHERE key='MAX_USER_AUCTIONS'").get()?.value ?? 3);
const active = db.prepare("SELECT COUNT(*) c FROM auctions WHERE creator_id=? AND status='active'").get(userId).c;
const pending = db.prepare("SELECT COUNT(*) c FROM pending_auctions WHERE user_id=? AND status='pending'").get(userId).c;

console.log(`\nMAX_USER_AUCTIONS = ${max}`);
console.log(`active  = ${active}`);
console.log(`pending = ${pending}`);
console.log(`total   = ${active + pending}  ->  ${active + pending >= max ? 'BLOCKED' : 'can post'}\n`);

console.log('Active auctions:');
for (const r of db.prepare("SELECT chat_id, message_id, title, end_at FROM auctions WHERE creator_id=? AND status='active' ORDER BY end_at").all(userId)) {
    console.log(`  ${r.chat_id}:${r.message_id}  ends ${r.end_at}  ${r.title}`);
}

console.log('\nQueue (every status, newest first):');
for (const r of db.prepare('SELECT id, status, title, created_at FROM pending_auctions WHERE user_id=? ORDER BY id DESC LIMIT 15').all(userId)) {
    console.log(`  #${r.id}  ${String(r.status).padEnd(9)} ${r.created_at}  ${r.title}`);
}

// An 'active' row whose end_at has passed means a close never completed; it
// keeps eating the allowance even though the lot is over.
const stale = db.prepare("SELECT chat_id, message_id, end_at, title FROM auctions WHERE creator_id=? AND status='active' AND end_at < datetime('now')").all(userId);
if (stale.length) {
    console.log(`\n⚠️  ${stale.length} active row(s) already past end_at — a close never finished, and these still count:`);
    for (const r of stale) console.log(`  ${r.chat_id}:${r.message_id}  ended ${r.end_at}  ${r.title}`);
}
console.log();
