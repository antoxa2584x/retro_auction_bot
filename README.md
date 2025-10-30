# Telegram Auction Bot — README

A lightweight Telegram channel auction bot built with Node.js. It turns a normal channel post (with a specific text format) into a live auction with inline “Bid” and “Info” buttons, keeps track of participants and current price, and automatically closes the auction at the scheduled time with a winner banner. 

---

## ✨ Features

* **One-tap bidding via inline keyboard** — shows current price and participant count; “Info” reveals recent bidders in a safe, short alert. 
* **Robust callback handling** — validates auction state, increments price by step, upserts participant, persists bid, updates keyboard; gracefully handles finished auctions. 
* **Scheduled closing** — uses `node-schedule` to close at the exact end time; restores jobs on restart; posts winner banner or “no bids” banner. 
* **Human-friendly parsing** — extracts min bid, step, and end time from a natural-language post (Ukrainian), accounting for timezone and year rollover. 
* **Channel → Discussion flow** — listens only to a specified channel, attaches the keyboard to the media/caption, and links discussion thread for bids. 

---

## 🧠 How it works (high level)

1. **Admin posts an auction to the channel** following a simple template (see below). The bot listens to `channel_post`, parses min bid, step, and end time, saves an `auction` row, renders inline buttons, and schedules auto-close.
2. **Users tap “Bid” in the discussion**: the bot validates auction status/time, computes new price (`minBid` on first bid, then `+ step`), upserts the participant, inserts a bid, and updates inline markup with fresh price & participants. 
3. **Users tap “Info”**: the bot shows a compact alert with the latest coalesced bidder series (avoids spamming repeated bids from the same person). 
4. **Scheduler fires at end time**: edits markup to winner banner (deep link to winner) or “no bids” banner; also restores pending jobs after bot restarts. 

---

## 📝 Auction post format (Ukrainian)

Put this in the **channel post caption/text**:

```
Назва лота (будь-який заголовок)

Мінімальна ставка: 1 000 грн
Крок ставки: 50 грн
Завершення аукціону: 21.10 о 22:00
```

The parser reads:

* `Мінімальна ставка: <number> грн`
* `Крок ставки: <number> грн`
* `Завершення аукціону: dd.mm о HH:MM` — timezone is applied; if the date/time is in the past, it rolls to next year. 

---

## 🔧 Requirements

* **Node.js 18+**
* **Telegraf** (Bot API framework) and **node-schedule**
* A **Telegram Channel** linked to a **Discussion Group** (the group’s ID is used to host the inline keyboard & bidding).
* A persistent database (SQLite/your DB) implementing the `q.*` queries referenced in the code (see “Database” below).

---

## 📁 Project layout (key files)

* `channelPost.js` — handles channel posts, parses auction, saves row, attaches keyboard, schedules close. 
* `callbacks.js` — processes `callback_query` for **Bid** and **Info**. 
* `keyboards.js` — renders inline keyboards (live price, participants; winner banner; empty finish). 
* `parse.js` — regex + date-fns/date-fns-tz parser for min/step/end with TZ handling. 
* `scheduler.js` — schedule, close, restore jobs; edits messages to winner/no-bids on finish. 

> You’ll also need a small bootstrap file that creates a Telegraf `bot`, wires these handlers, and calls `restoreJobs(bot.telegram)` on startup. The code references `db.js` and `env.js` modules for storage and configuration.

---

## ⚙️ Configuration

Create an `.env` (or `env.js`) with:

* `BOT_TOKEN` — Telegram bot token
* `CHANNEL_ID` — the numeric ID of your auction **channel** (the bot will only react to this channel’s posts) 
* `COMMENTS_ID` — the numeric ID of the linked **discussion group** where users tap the buttons (required) 
* `TZ` — IANA timezone string (e.g., `Europe/Kyiv`) used for parsing the end time.

Example `env.js`:

```js
export const BOT_TOKEN   = process.env.BOT_TOKEN;
export const CHANNEL_ID  = Number(process.env.CHANNEL_ID);
export const COMMENTS_ID = Number(process.env.COMMENTS_ID);
export const TZ          = process.env.TZ || 'Europe/Kyiv';
```

*(Do not put secrets in VCS.)*

---

## 🗄️ Database

The code expects a `db.js` module that provides prepared statements in `q`, such as:

* `q.insertAuction`, `q.getAuction`, `q.finish`, `q.selectActive`
* `q.upsertParticipant`, `q.insertBid`, `q.updateState`, `q.selectBidsForInfo`

You can implement these with SQLite (e.g., `better-sqlite3`) or your DB of choice. The schema typically includes `auctions`, `participants`, and `bids` tables keyed by `(chat_id, message_id)` for a specific channel post. The handlers read/write these queries exactly where noted in code.

---

## ▶️ Running locally

```bash
# 1) install deps
npm install

# 2) export env (or use a .env loader)
export BOT_TOKEN=123:ABC
export CHANNEL_ID=-1001234567890
export COMMENTS_ID=-1009876543210
export TZ=Europe/Kyiv

# 3) start the bot
node index.js
```

On startup, ensure you call `restoreJobs(...)` so future finish times are re-scheduled or overdue auctions are closed promptly. 

---

## 🧩 Keyboard & UX details

* **Live button (left):** shows a green dot when there are participants, yellow when none, with current price “`🟢 1 050 грн`”. Tapping places a bid. 
* **Info button (right):** shows “👥 Ставки (N)”. Tapping opens an alert listing the latest distinct bidder series (collapsing consecutive bids from the same user), capped for Telegram alert size. 
* **Finish banners:**

  * Winner: inline button with `tg://user?id=<winnerId>` and final price. 
  * No bids: a red “Фініш! Ставок не було.” banner.

---

## 🔒 Safety & edge cases

* **Out-of-time bids** are rejected once the end time passes; the scheduled job will finalize the auction shortly after.
* **Already finished auctions** respond with a finished message and trigger `closeAuction` to sync UI. 
* **Large info lists** are truncated to fit Telegram alert limits, with `…та ще N` tail. 

---

## 🛠️ Development tips

* Keep your post captions consistent with the regexes (`Мінімальна ставка`, `Крок ставки`, `Завершення аукціону`) or extend the parser. 
* If you change keyboard text/structure, do it in one place (`keyboards.js`). 
* When you deploy, **persist your DB file** and enable **process restarts** (PM2/systemd/Docker). On boot, `restoreJobs` will reschedule active auctions or close overdue ones. 

---

## 🧪 Manual test checklist

1. Post a properly formatted auction in the channel. Confirm keyboard appears under the post. 
2. Click **Info** (no bids yet) → “Ще немає ставок.” alert. 
3. Place first **Bid** → price equals `minBid`, participants = 1. 
4. Place next **Bid** from another account → price increments by `step`, participants grows, keyboard updates. 
5. Wait past end time → winner/empty finish banner replaces buttons. 

---

## 📜 License

MIT — see `LICENSE`.

---

## 🙋 FAQ

**Q: Can I change the language/text?**
Yes — adjust button labels in `keyboards.js` and parsing regex in `parse.js`.

**Q: Where do bids “live”?**
They’re stored by your `db.js` implementation via the `q.*` prepared statements used by the handlers.

**Q: How is the end time computed?**
The bot parses `dd.mm о HH:MM` in your configured timezone; if the computed datetime is already in the past, it shifts to next year. 

---

Happy auctions! 🧡
