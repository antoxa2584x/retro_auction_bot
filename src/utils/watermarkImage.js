/**
 * Pure image-compositing helpers for the watermark feature.
 *
 * Deliberately free of any database or Telegram dependency so the placement
 * maths can be reasoned about (and exercised) in isolation. The settings-aware
 * wrapper lives in src/services/watermark.js.
 */
import sharp from 'sharp';

/** Gravities accepted by sharp, in 3x3 grid order. */
export const WATERMARK_POSITIONS = [
    'northwest', 'north', 'northeast',
    'west', 'center', 'east',
    'southwest', 'south', 'southeast'
];

export const DEFAULT_POSITION = 'southeast';
export const DEFAULT_SCALE = 25;    // % of the base image width
export const DEFAULT_OPACITY = 100; // %

// Inset from the edge for non-centered gravities, as a % of base width. Kept a
// constant rather than a setting: a watermark flush against the border looks
// like a rendering glitch, and no admin needs to tune this.
const EDGE_MARGIN_PCT = 2;

/**
 * Coerces a stored/user-supplied percentage into 1..100.
 *
 * @param {*} value - Raw value (string from settings, or a number).
 * @param {number} fallback - Used when the value is absent or out of range.
 * @returns {number}
 */
export function clampPercent(value, fallback) {
    const n = typeof value === 'number' ? value : parseInt(value, 10);
    return Number.isFinite(n) && n >= 1 && n <= 100 ? n : fallback;
}

/**
 * Composites a watermark onto an image.
 *
 * @param {Buffer} baseBuffer - The base image bytes (JPEG as delivered by Telegram).
 * @param {Buffer} watermarkBuffer - The watermark PNG bytes.
 * @param {{position?: string, scale?: number, opacity?: number}} [opts] - Placement options.
 * @returns {Promise<Buffer>} JPEG bytes of the watermarked image.
 * @throws If either image is undecodable.
 */
export async function composeWatermarkWith(baseBuffer, watermarkBuffer, opts = {}) {
    const base = sharp(baseBuffer).rotate(); // honour EXIF orientation before measuring
    const { width, height } = await base.metadata();
    if (!width || !height) throw new Error('Could not read base image dimensions');

    const position = WATERMARK_POSITIONS.includes(opts.position) ? opts.position : DEFAULT_POSITION;
    const margin = position === 'center'
        ? 0
        : Math.max(1, Math.round((width * EDGE_MARGIN_PCT) / 100));

    // Leave room for the inset on both sides so the mark never overflows.
    const maxWidth = Math.max(1, width - margin * 2);
    const maxHeight = Math.max(1, height - margin * 2);
    const scale = clampPercent(opts.scale, DEFAULT_SCALE);
    const targetWidth = Math.max(1, Math.min(
        Math.round((width * scale) / 100),
        maxWidth
    ));

    let overlay = sharp(watermarkBuffer)
        .ensureAlpha()
        .resize({
            width: targetWidth,
            height: maxHeight,
            fit: 'inside',            // preserve aspect ratio, never exceed the base
            withoutEnlargement: false
        });

    const opacity = clampPercent(opts.opacity, DEFAULT_OPACITY);
    if (opacity < 100) {
        // sharp has no opacity option on composite; multiplying the alpha
        // channel with a uniform tile via `dest-in` is the supported idiom.
        overlay = sharp(await overlay.png().toBuffer()).composite([{
            input: Buffer.from([255, 255, 255, Math.round((255 * opacity) / 100)]),
            raw: { width: 1, height: 1, channels: 4 },
            tile: true,
            blend: 'dest-in'
        }]);
    }

    let overlayBuffer = await overlay.png().toBuffer();

    if (margin > 0) {
        // Pad the overlay with transparency so gravity placement lands it a
        // consistent distance in from the edge.
        overlayBuffer = await sharp(overlayBuffer)
            .extend({
                top: margin, bottom: margin, left: margin, right: margin,
                background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .png()
            .toBuffer();
    }

    return await base
        .composite([{ input: overlayBuffer, gravity: position }])
        .jpeg({ quality: 90 })
        .toBuffer();
}

/**
 * Renders a neutral checkerboard used as the backdrop for watermark previews.
 *
 * A generated sample (rather than a real auction photo) keeps the preview
 * deterministic and always available, and the checker pattern makes the
 * watermark's transparency and edges obvious.
 *
 * @param {number} [width=1280] - Sample width in pixels.
 * @param {number} [height=960] - Sample height in pixels.
 * @returns {Promise<Buffer>} JPEG bytes of the sample image.
 */
export async function createPreviewBase(width = 1280, height = 960) {
    const cell = Math.round(width / 16);
    const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <pattern id="c" width="${cell * 2}" height="${cell * 2}" patternUnits="userSpaceOnUse">
                <rect width="${cell * 2}" height="${cell * 2}" fill="#d8d8d8"/>
                <rect width="${cell}" height="${cell}" fill="#b0b0b0"/>
                <rect x="${cell}" y="${cell}" width="${cell}" height="${cell}" fill="#b0b0b0"/>
            </pattern>
        </defs>
        <rect width="${width}" height="${height}" fill="url(#c)"/>
    </svg>`;

    return await sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

/**
 * Verifies that a buffer really is a PNG and reports its dimensions.
 *
 * Telegram only tells us the declared MIME type of an uploaded document, which
 * a client can get wrong; this checks the actual bytes.
 *
 * @param {Buffer} buffer - Candidate watermark bytes.
 * @returns {Promise<{width: number, height: number, hasAlpha: boolean}>}
 * @throws If the buffer is not a decodable PNG.
 */
export async function inspectWatermarkPng(buffer) {
    const meta = await sharp(buffer).metadata();
    if (meta.format !== 'png') {
        throw new Error(`Expected a PNG, got ${meta.format || 'unknown format'}`);
    }
    if (!meta.width || !meta.height) {
        throw new Error('Could not read watermark dimensions');
    }
    return { width: meta.width, height: meta.height, hasAlpha: !!meta.hasAlpha };
}
