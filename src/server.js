import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { q } from './services/db.js';
import { BOT_TOKEN } from './config/env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            ...helmet.contentSecurityPolicy.getDefaultDirectives(),
            "script-src": ["'self'", "https://telegram.org"],
            "img-src": ["'self'", "data:", "https://via.placeholder.com", "https://*.telegram.org"]
        }
    }
}));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

/**
 * Validates Telegram Mini App init data.
 * Includes data freshness check (max 24 hours).
 */
function validateInitData(initData) {
    if (!initData) return false;
    
    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    const authDate = parseInt(urlParams.get('auth_date'), 10);
    
    // Check data freshness (e.g., must be from within last 24 hours)
    const now = Math.floor(Date.now() / 1000);
    if (isNaN(authDate) || now - authDate > 86400) {
        return false;
    }
    
    urlParams.delete('hash');
    
    const dataCheckString = Array.from(urlParams.entries())
        .map(([key, value]) => `${key}=${value}`)
        .sort()
        .join('\n');
        
    const secretKey = crypto.createHmac('sha256', 'WebAppData')
        .update(BOT_TOKEN)
        .digest();
        
    const calculatedHash = crypto.createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');
        
    // Use timingSafeEqual to prevent timing attacks
    try {
        return crypto.timingSafeEqual(Buffer.from(calculatedHash, 'utf8'), Buffer.from(hash, 'utf8'));
    } catch (e) {
        return false;
    }
}

/**
 * Middleware to authenticate requests from Mini App.
 */
function authMiddleware(req, res, next) {
    const initData = req.headers['x-init-data'];
    if (!validateInitData(initData)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    const urlParams = new URLSearchParams(initData);
    const userStr = urlParams.get('user');
    if (userStr) {
        req.user = JSON.parse(userStr);
    }
    
    next();
}

// API Endpoints

app.get('/api/user/auctions', authMiddleware, (req, res) => {
    const userId = req.user.id;
    
    try {
        const participating = q.getParticipatingAuctions.all(userId);
        const won = q.getWonAuctions.all(userId);
        const watchlist = q.getWatchlistAuctions.all(userId);
        
        // Add channel_username and chat_id to each auction object
        const channelUsername = q.getSetting.get('CHANNEL_USERNAME')?.value || null;
        
        // For private channels, use t.me/c/ID/MSG_ID. 
        // Note: chat_id needs to be stripped of -100 prefix for t.me/c/ links
        const mapAuction = (a) => ({
            ...a,
            channel_username: channelUsername,
            chat_id: a.chat_id?.toString().replace('-100', ''),
            currency: q.getSetting.get('CURRENCY')?.value || '₴'
        });

        res.json({
            participating: participating.map(mapAuction),
            won: won.map(mapAuction),
            watchlist: watchlist.map(mapAuction)
        });
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.get('/api/photo/:fileId', async (req, res) => {
    const { fileId } = req.params;
    const bot = app.get('bot');

    if (!bot) {
        return res.status(500).send('Bot not initialized');
    }

    try {
        const fileLink = await bot.getFileLink(fileId);
        https.get(fileLink, (proxyRes) => {
            res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
            proxyRes.pipe(res);
        }).on('error', (e) => {
            console.error('Error fetching file from Telegram:', e);
            res.status(500).send('Error fetching image');
        });
    } catch (error) {
        console.error('Error getting file link:', error);
        res.status(404).send('Image not found');
    }
});

export function startServer(bot) {
    const port = process.env.PORT || 3000;
    app.set('bot', bot);

    if (bot) {
        app.post(`/bot${BOT_TOKEN}`, (req, res) => {
            bot.processUpdate(req.body);
            res.sendStatus(200);
        });
    }

    app.listen(port, () => {
        console.log(`Mini App server running on port ${port}`);
    });
}
