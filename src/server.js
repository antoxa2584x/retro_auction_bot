import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
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
            "img-src": ["'self'", "data:", "https://via.placeholder.com"]
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
        
        res.json({
            participating,
            won,
            watchlist
        });
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export function startServer(port = 3000) {
    app.listen(port, () => {
        console.log(`Mini App server running on port ${port}`);
    });
}
