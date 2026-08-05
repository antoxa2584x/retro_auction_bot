import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Log files live next to the database rather than inside src/, and the path is
 * resolved from this module instead of the cwd so that `npm start` and a service
 * manager started from a different directory write to the same place.
 */
const LOG_DIR = path.join(__dirname, '..', '..', 'logs');

/** Files older than this are dropped by pruneOldLogs(), keeping ~a week on disk. */
export const LOG_RETENTION_DAYS = 7;

/** Only files this logger created are ever considered for deletion. */
const LOG_FILE_PATTERN = /^bot-(\d{4}-\d{2}-\d{2})\.log$/;

let dirReady = false;

function ensureDir() {
    if (dirReady) return;
    fs.mkdirSync(LOG_DIR, { recursive: true });
    dirReady = true;
}

/**
 * Errors don't survive JSON.stringify — `message` and `stack` are non-enumerable,
 * so an un-normalized Error is written as `{}`.
 */
function normalize(value) {
    if (value instanceof Error) return { message: value.message, stack: value.stack };
    return value;
}

/**
 * Appends one JSON line to today's log file. Never throws: a logging failure must
 * not take down the handler it was called from.
 *
 * @param {'info'|'warn'|'error'} level
 * @param {string} event - Stable machine-readable event name, e.g. 'auction_created'.
 * @param {Object} [data] - Extra fields merged into the entry.
 */
export function logEvent(level, event, data = {}) {
    const entry = { ts: new Date().toISOString(), level, event };
    for (const [key, value] of Object.entries(data)) entry[key] = normalize(value);

    let line;
    try {
        line = JSON.stringify(entry);
    } catch (e) {
        line = JSON.stringify({ ts: entry.ts, level, event, log_error: `unserializable payload: ${e.message}` });
    }

    if (level !== 'info') console.error(`[${event}]`, line);

    try {
        ensureDir();
        // Synchronous append: these entries are meant to explain crashes and
        // races, so they have to be on disk before the next statement runs.
        fs.appendFileSync(path.join(LOG_DIR, `bot-${entry.ts.slice(0, 10)}.log`), line + '\n');
    } catch (e) {
        console.error('[logger] cannot write log file:', e.message);
    }
}

/** @param {string} event @param {Object} [data] */
export const logInfo = (event, data) => logEvent('info', event, data);

/** @param {string} event @param {Object} [data] */
export const logWarn = (event, data) => logEvent('warn', event, data);

/** @param {string} event @param {Object} [data] */
export const logError = (event, data) => logEvent('error', event, data);

/**
 * Deletes log files older than the retention window. Dating is taken from the
 * file name rather than mtime, so copying or touching a file doesn't extend its
 * life, and anything that isn't a `bot-YYYY-MM-DD.log` written by this logger is
 * left alone.
 *
 * @param {number} [retentionDays] - Days of logs to keep, including today.
 * @returns {string[]} Names of the deleted files.
 */
export function pruneOldLogs(retentionDays = LOG_RETENTION_DAYS) {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const removed = [];

    let files;
    try {
        files = fs.readdirSync(LOG_DIR);
    } catch (e) {
        // Nothing logged yet — the directory is created on first write.
        if (e.code !== 'ENOENT') console.error('[logger] cannot list log dir:', e.message);
        return removed;
    }

    for (const file of files) {
        const match = LOG_FILE_PATTERN.exec(file);
        if (!match) continue;

        const day = Date.parse(`${match[1]}T00:00:00Z`);
        if (!Number.isFinite(day) || day >= cutoff) continue;

        try {
            fs.unlinkSync(path.join(LOG_DIR, file));
            removed.push(file);
        } catch (e) {
            console.error(`[logger] cannot delete ${file}:`, e.message);
        }
    }

    if (removed.length > 0) logInfo('logs_pruned', { removed, retention_days: retentionDays });
    return removed;
}
