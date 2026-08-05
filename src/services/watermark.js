/**
 * Watermark service — settings-aware wrapper around the pure compositing
 * helpers in src/utils/watermarkImage.js.
 *
 * Admins upload a transparent PNG once via the settings panel; it is stored as
 * a BLOB in the `assets` table and composited onto the MAIN photo of auctions
 * posted through the admin wizard (src/handlers/admin/post.js).
 *
 * Deliberately NOT applied to user-submitted auctions approved by an admin,
 * nor to gallery photos beyond the first — only the admin post's main image.
 */
import { q } from './db.js';
import {
    clampPercent,
    composeWatermarkWith,
    DEFAULT_OPACITY,
    DEFAULT_POSITION,
    DEFAULT_SCALE,
    WATERMARK_POSITIONS
} from '../utils/watermarkImage.js';

export { WATERMARK_POSITIONS };

/** Key under which the watermark PNG lives in the `assets` table. */
export const WATERMARK_ASSET_KEY = 'watermark';

/** File metadata for uploading a watermarked buffer via sendPhoto. */
export const WATERMARK_FILE_OPTIONS = {
    filename: 'auction.jpg',
    contentType: 'image/jpeg'
};

/** @returns {{data: Buffer, mime: string}|null} The stored watermark, if any. */
export function getWatermarkAsset() {
    return q.getAsset.get(WATERMARK_ASSET_KEY) || null;
}

/** @returns {boolean} True if a watermark PNG has been uploaded. */
export function hasWatermark() {
    return !!getWatermarkAsset();
}

/** Removes the stored watermark. */
export function deleteWatermark() {
    q.deleteAsset.run(WATERMARK_ASSET_KEY);
}

/**
 * Stores (or replaces) the watermark PNG.
 *
 * @param {Buffer} buffer - Raw PNG bytes.
 */
export function saveWatermark(buffer) {
    q.setAsset.run(WATERMARK_ASSET_KEY, buffer, 'image/png');
}

/** @returns {boolean} Whether watermarking is switched on. */
export function isWatermarkEnabled() {
    return (q.getSetting.get('WATERMARK_ENABLED')?.value || 'true') === 'true';
}

/** @returns {string} The configured sharp gravity. */
export function getWatermarkPosition() {
    const val = q.getSetting.get('WATERMARK_POSITION')?.value;
    return WATERMARK_POSITIONS.includes(val) ? val : DEFAULT_POSITION;
}

/** @returns {number} Watermark width as a percentage of the base image width. */
export function getWatermarkScale() {
    return clampPercent(q.getSetting.get('WATERMARK_SCALE')?.value, DEFAULT_SCALE);
}

/** @returns {number} Watermark opacity percentage. */
export function getWatermarkOpacity() {
    return clampPercent(q.getSetting.get('WATERMARK_OPACITY')?.value, DEFAULT_OPACITY);
}

/**
 * Composites the stored watermark onto an image using the configured settings.
 *
 * @param {Buffer} baseBuffer - The base image bytes.
 * @returns {Promise<Buffer>} JPEG bytes of the watermarked image.
 * @throws If no watermark is stored, or the image is undecodable.
 */
export async function composeWatermark(baseBuffer) {
    const asset = getWatermarkAsset();
    if (!asset) throw new Error('No watermark uploaded');

    return await composeWatermarkWith(baseBuffer, asset.data, {
        position: getWatermarkPosition(),
        scale: getWatermarkScale(),
        opacity: getWatermarkOpacity()
    });
}

/**
 * Downloads a file from Telegram into a Buffer.
 *
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {string} fileId - file_id to fetch.
 * @returns {Promise<Buffer>}
 */
export async function downloadTelegramFile(bot, fileId) {
    const link = await bot.getFileLink(fileId);
    const res = await fetch(link);
    if (!res.ok) throw new Error(`Download failed with HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

/**
 * Downloads a Telegram photo, watermarks it, and returns it ready for upload.
 *
 * Fails soft: any problem (watermark off, none uploaded, download failure,
 * undecodable image) returns null so the caller falls back to posting the
 * original file_id. A watermark must never block a live auction from going out.
 *
 * @param {TelegramBot} bot - Telegram bot instance.
 * @param {string} fileId - file_id of the photo to watermark.
 * @returns {Promise<Buffer|null>} Watermarked JPEG bytes, or null to fall back.
 */
export async function buildWatermarkedPhoto(bot, fileId) {
    if (!fileId || !isWatermarkEnabled() || !hasWatermark()) return null;

    try {
        return await composeWatermark(await downloadTelegramFile(bot, fileId));
    } catch (e) {
        console.error('Watermark failed, posting original photo:', e.message);
        return null;
    }
}
