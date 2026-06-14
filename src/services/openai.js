import OpenAI from 'openai';
import {q} from './db.js';
import fs from 'fs';
import crypto from 'crypto';

export function calculateImageHash(photoPath) {
    const fileBuffer = fs.readFileSync(photoPath);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(fileBuffer);
    return hashSum.digest('hex');
}

export async function generateAuctionDetails(photoPath, locale = 'uk') {
    const apiKey = q.getSetting.get('OPENAI_API_KEY')?.value || process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error('OPENAI_API_KEY_NOT_SET');
    }

    const openai = new OpenAI({
        apiKey: apiKey,
    });

    const base64Image = fs.readFileSync(photoPath, {encoding: 'base64'});

    const examples = q.getRecentAiTrainingData.all(locale);
    let examplesText = '';
    if (examples.length > 0) {
        examplesText = "\nHere are some examples of previous high-quality listings you've created that the user liked and confirmed:\n\n" + 
            examples.map(ex => `Example:\n${ex.final_text}`).join('\n\n') + "\n\nFollow the style and level of detail from these examples.";
    }

    const prompt = `You are creating a short auction listing description for a used gaming console or electronic device based on a photo.

Analyze the image and generate a listing in this exact format:

Line 1: Full device name (brand + model + color if visible + region if known)
(blank line)
Line 2–3: Short condition description (cosmetic condition, visible wear, screen state including yellowing, scratches, etc.)
Line 4: What is included in the sale.

Rules:
- Maximum 350 characters total.
- Use simple clear ${locale === 'uk' ? 'Ukrainian' : 'English'} language.
- Do NOT invent accessories.
- Assume region by language or age rating sticker
- Only include items clearly visible in the photo.
- If only the device is visible, write: "Only console, no accessories".
- Mention visible defects (scratches, yellowing, wear).
- If screens look clean, say: "screens look good".
- Do not add extra lines or commentary.${examplesText}
`;


    const response = await openai.chat.completions.create({
        model: "gpt-4.1-mini", messages: [{
            role: "user",
            content: [{type: "text", text: prompt},
                {
                    type: "image_url",
                    image_url: {
                        "url": `data:image/jpeg;base64,${base64Image}`,
                    }
                },
            ],
        },],
    });

    return response.choices[0].message.content;
}
