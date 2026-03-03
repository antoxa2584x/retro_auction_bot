# Telegram Auction Bot — README

A lightweight Telegram channel auction bot built with Node.js. It turns a normal channel post (with a specific text format) into a live auction with inline “Bid” and “Info” buttons, keeps track of participants and current price, and automatically closes the auction at the scheduled time with a winner banner.

Recently updated with **bid confirmation via bot** and **rich media support**.

---

## ✨ Features

* **One-tap bidding with confirmation** — users are redirected from the channel to the bot's private chat to confirm their bid, preventing accidental clicks.
* **Rich Media Support** — the bot shows the auction's **photo** and **full original text** during the confirmation step.
* **Real-time notifications** — users receive private messages when they are overbidden or when they win an auction.
* **Automatic Winner Contact** — winners are provided with the admin's contact info and a direct link back to the auction post.
* **Interactive Info Button** — reveals recent bidders in a safe, short alert, collapsing consecutive bids from the same user.
* **Robust scheduled closing** — uses `node-schedule` to close at the exact end time; restores jobs on restart; posts winner banner or “no bids” banner.
* **Smart Parsing** — extracts lot name, min bid, step, and end time from natural-language Ukrainian posts.
* **Admin Tools** — includes an `/undo` command to cancel the last bid and restore the previous leader.

---

## 🧠 How it works (high level)

1. **Admin posts an auction to the channel** following the template. The bot listens to `channel_post`, parses details, saves the auction (including full text and photo), and attaches the "Bid" button.
2. **User taps “Bid” in the channel**: They are redirected to the bot with a deep link (`/start bid_CHATID_MSGID`).
3. **Confirmation in Bot**: The bot shows the item's photo/text and the required bid amount. The user clicks "Confirm".
4. **Processing**: The bot validates the price (handling changes if someone else bid in the meantime), updates the database, refreshes the channel keyboard, and notifies the previous leader.
5. **Auction End**: The scheduler (or an interaction after expiration) triggers the closing sequence, updating the channel post with the winner's name and notifying the winner privately.

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

## ⚙️ Configuration

Create a `.env` file with the following:

```env
BOT_TOKEN=your_bot_token
CHANNEL_ID=-100...       # Auction channel ID
COMMENTS_ID=-100...      # Linked discussion group ID
ADMIN_ID=12345678        # Your Telegram user ID for /undo command
ADMIN_NICKNAME=@admin    # Contact for the winner
BOT_USERNAME=YourBot     # Bot username (without @) for deep links
CHANNEL_USERNAME=Channel # (Optional) Public channel username for links
TZ=Europe/Kyiv           # Timezone
```

---

## 📁 Project layout

* `bot.js` — Main entry point, wires handlers and restores jobs.
* `db.js` — Database schema, migrations, and prepared statements.
* `handlers/channelPost.js` — Processes new auctions and `/undo` command.
* `handlers/callbacks.js` — Handles `/start` deep links and bid confirmations.
* `handlers/admin.js` — Logic for the `/undo` command.
* `scheduler.js` — Auction closing logic and notifications.
* `keyboards.js` — Inline keyboard templates.
* `parse.js` — Regex-based auction post parser.

---

## 🗄️ Database & Migrations

The bot uses SQLite (`auction.sqlite3`). On startup, it automatically checks for and adds missing columns to the `auctions` table if you are upgrading from an older version.

---

## ▶️ Running

```bash
npm install
node bot.js
```

---

## 📜 License

MIT
