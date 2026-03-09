# Telegram Auction Bot — README

A lightweight Telegram channel auction bot built with Node.js. It turns a normal channel post (with a specific text format) into a live auction with inline “Bid” and “Info” buttons, keeps track of participants and current price, and automatically closes the auction at the scheduled time with a winner banner.

Recently updated with **bid confirmation via bot** and **rich media support**.

---

## ✨ Features

* **Multi-language Support** — supports both **Ukrainian** and **English**, with easy switching via the admin panel.
* **Custom Currency** — admins can set any custom currency symbol or name (e.g., ₴, $, €, BTC) to be used across all auctions.
* **One-tap bidding with confirmation** — users are redirected from the channel to the bot's private chat to confirm their bid, preventing accidental clicks.
* **Rich Media Support** — the bot shows the auction's **photo** and **full original text** during the confirmation step.
* **Real-time notifications** — users receive private messages when they are outbid or when they win an auction.
* **User Portfolio** — `/my` command to see active bids and `/won` to see auction history.
* **Automatic Winner Contact** — winners are provided with the admin's contact info and a direct link back to the auction post.
* **Interactive Info Button** — reveals recent bidders in a safe, short alert, collapsing consecutive bids from the same user.
* **Robust scheduled closing** — uses `node-schedule` to close at the exact end time; restores jobs on restart; posts winner banner or “no bids” banner.
* **Smart Parsing** — extracts lot name, min bid, step, and end time from natural-language posts.
* **Advanced Admin Panel** — OTP-authenticated private panel to manage all auctions, with features like "Finish Immediately", "Restart", and dynamic configuration of Channel ID, Admin ID, Admin Nickname, Language, and Currency.

---

## 🧠 How it works (high level)

1. **Admin posts an auction to the channel** following the template. The bot listens to `channel_post`, parses details, saves the auction (including full text and photo), and attaches the "Bid" button.
2. **User taps “Bid” in the channel**: They are redirected to the bot with a deep link (`/start bid_CHATID_MSGID`).
3. **Confirmation in Bot**: The bot shows the item's photo/text and the required bid amount. The user clicks "Confirm".
4. **Processing**: The bot validates the price (handling changes if someone else bid in the meantime), updates the database, refreshes the channel keyboard, and notifies the previous leader.
5. **Auction End**: The scheduler (or an interaction after expiration) triggers the closing sequence, updating the channel post with the winner's name and notifying the winner privately.

---

## 🛠️ Admin Functions

The bot provides powerful administrative tools accessible via private messages and directly in the channel.

### 🔐 Admin Panel (Private Messages)
To access the admin panel:
1. Send `/admin` to the bot in a private chat.
2. Retrieve the **OTP code** and send it to the bot.
3. Use `/admin_panel` to open the management interface.

**Features:**
* **Active Auctions List**: View all currently running auctions.
* **Finished Auctions List**: View the most recent completed auctions.
* **Detailed View**: Check current price, leader, and end date for any auction.
* **🏁 Finish Immediately**: Instantly close any active auction.
* **🔄 Restart (4 days)**: Restart a finished auction for 4 more days (preserving the original time of day).
* **🌐 Language**: Switch between Ukrainian and English interfaces.
* **💰 Currency**: Set a custom currency symbol or name used globally.
* **⚙️ Dynamic Configuration**: Manage `Channel ID`, `Admin ID`, and `Admin Nickname` without restarting the bot.

---

## ⚙️ Configuration

Create a `.env` file with the following:

```env
BOT_TOKEN=your_bot_token
CHANNEL_ID=-100...       # Auction channel ID
ADMIN_ID=12345678        # Your Telegram user ID for OTP
ADMIN_NICKNAME=@admin    # Contact for the winner
BOT_USERNAME=YourBot     # Bot username (without @) for deep links
CHANNEL_USERNAME=Channel # (Optional) Public channel username for links
TZ=Europe/Kyiv           # Timezone
```

---

## 📝 Auction post format (Ukrainian)

Put this in the **channel post caption/text**:

```
🎮 Аукціон!
Назва лота (будь-який заголовок)

Мінімальна ставка: 1 000 грн
Крок ставки: 50 грн
Завершення аукціону: 21.10 о 22:00
```

The bot extracts the **Title** as the first non-empty line between `🎮 Аукціон!` and `Мінімальна ставка:`.

---

## 🔧 Requirements

* **Node.js 18+**
* **better-sqlite3** (SQLite database)
* **Telegraf** (Bot API framework)
* **node-schedule**

---

## 📁 Project layout

* `src/bot.js` — Main entry point, wires handlers and restores jobs.
* `src/config/env.js` — Environment variables and dynamic settings.
* `src/services/db.js` — Database schema and operations (SQLite).
* `src/services/i18n.js` — Internationalization service for UK/EN support.
* `src/services/scheduler.js` — Auction closing logic and scheduled notifications.
* `src/handlers/channelPost.js` — Processes new auctions from the channel.
* `src/handlers/callbacks.js` — Handles `/start` deep links, bid confirmations, and user commands (`/my`, `/won`).
* `src/handlers/admin.js` — Logic for OTP authentication and the admin panel.
* `src/locales/` — Translation files (`uk.json`, `en.json`).
* `src/utils/` — Shared utility functions and keyboards.

---

## 🗄️ Database & Migrations

The bot uses SQLite (`auction.sqlite3`). On startup, it automatically checks for and adds missing columns/tables if you are upgrading.

---

## ▶️ Running

```bash
npm install
node src/bot.js
```

---

## 📜 License

MIT
