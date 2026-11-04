const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// === CẤU HÌNH BIẾN MÔI TRƯỜNG ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONETAG_LINK = process.env.MONETAG_LINK;
const SECRET_KEY = process.env.SECRET_KEY || 'mysecret123';
const APP_URL = 'https://mayintien-tele.onrender.com';

const RATE_PER_SEC_VND = 0.01;
const MIN_WATCH_TIME_MS = 15000; // Tối thiểu 15 giây mỗi video

// === DATABASE LƯU TRỮ VĨNH VIỄN ===
const DB_FILE = path.join(__dirname, 'database.json');

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: {}, sessions: {} }, null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    return { users: {}, sessions: {} };
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// 1. Tự động cài đặt Webhook và Menu Button cho Bot Telegram
async function setupTelegramBot() {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook?url=${APP_URL}/api/telegram-webhook`);
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        menu_button: {
          type: 'web_app',
          text: '🎮 Chơi Game',
          web_app: { url: APP_URL }
        }
      })
    });
    console.log('[Telegram Bot] Kích hoạt Bot thành công!');
  } catch (err) {
    console.error('[Telegram Bot Error]', err);
  }
}
setupTelegramBot();

// 2. Webhook Telegram trả lời khi chat /start
app.post('/api/telegram-webhook', async (req, res) => {
  const { message } = req.body;
  if (message && message.text && message.text.startsWith('/start')) {
    const chatId = message.chat.id;
    const firstName = message.from ? message.from.first_name : 'bạn';

    try {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `👋 Chào mừng **${firstName}** đến với **Máy In Tiền Tự Động**!\n\n⚡ Cày tiền VNĐ thụ động 24/7 không giới hạn.\n👇 Bấm nút bên dưới để mở game chơi ngay:`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: "⚡ MỞ MÁY IN TIỀN NGAY ⚡", web_app: { url: APP_URL } }]
            ]
          }
        })
      });
    } catch (e) {
      console.error(e);
    }
  }
  res.sendStatus(200);
});

// 3. Xác thực Telegram initData
function verifyTelegram(initDataStr) {
  if (!initDataStr) return false;
  try {
    const params = new URLSearchParams(initDataStr);
    const hash = params.get('hash');
    params.delete('hash');

    const arr = [];
    for (const [k, v] of params.entries()) arr.push(`${k}=${v}`);
    arr.sort();
    const dataCheckStr = arr.join('\n');

    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calculatedHash = crypto.createHmac('sha256', secret).update(dataCheckStr).digest('hex');

    return calculatedHash === hash;
  } catch (e) {
    return false;
  }
}

// 4. Tính toán tiền in tự động
function calculateBalance(user) {
  const now = Math.floor(Date.now() / 1000);
  const effectiveEnd = Math.min(now, user.fuel_expires_at);
  const runningSecs = Math.max(0, effectiveEnd - user.last_collected_at);

  if (runningSecs > 0) {
    user.balance += runningSecs * user.rate_per_sec;
    user.last_collected_at = effectiveEnd;
  }
  return user;
}

// 5. API: Đăng ký tài khoản
app.post('/api/register', (req, res) => {
  const { initData, username, pin } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  if (!username || username.trim().length < 3) return res.status(400).json({ error: 'Tên phải từ 3 ký tự!' });
  if (!pin || pin.trim().length < 4) return res.status(400).json({ error: 'Mã PIN từ 4 số trở lên!' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  if (db.users[tgId]) return res.status(400).json({ error: 'Đã đăng ký rồi!' });

  const isNameTaken = Object.values(db.users).some(u => u.username.toLowerCase() === username.trim().toLowerCase());
  if (isNameTaken) return res.status(400).json({ error: 'Tên tài khoản này đã có người dùng!' });

  const now = Math.floor(Date.now() / 1000);
  db.users[tgId] = {
    telegram_id: tgId,
    username: username.trim(),
    pin: pin.trim(),
    balance: 0,
    fuel_expires_at: now,
    last_collected_at: now,
    rate_per_sec: RATE_PER_SEC_VND,
    created_at: now
  };

  saveDB(db);
  return res.json({ success: true });
});

// 6. API: Lấy thông tin tài khoản
app.post('/api/user-status', (req, res) => {
  const { initData } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  const user = db.users[tgId];

  if (!user) return res.json({ success: true, is_registered: false });

  user.rate_per_sec = RATE_PER_SEC_VND;
  calculateBalance(user);
  saveDB(db);

  return res.json({
    success: true,
    is_registered: true,
    username: user.username,
    balance: user.balance,
    fuel_expires_at: user.fuel_expires_at,
    rate_per_sec: user.rate_per_sec
  });
});

// 7. API: Bắt đầu Quảng Cáo 1/2 (Nhận loại thưởng: 'CASH' (+2 VNĐ) hoặc 'FUEL' (+10 phút))
app.post('/api/start-ad-1', (req, res) => {
  const { initData, rewardType } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  if (!db.users[tgId]) return res.status(400).json({ error: 'Vui lòng đăng ký trước!' });

  const sessionId = uuidv4();
  const clickId1 = uuidv4();

  db.sessions[sessionId] = {
    telegram_id: tgId,
    reward_type: rewardType || 'CASH', // 'CASH' = +2 VNĐ | 'FUEL' = +10 phút
    step: 1,
    ad1_start: Date.now(),
    ad1_click_id: clickId1,
    status: 'WATCHING_1'
  };
  saveDB(db);

  const adUrl = `${MONETAG_LINK}?sub_id_1=${clickId1}&ymid=${clickId1}`;
  return res.json({ success: true, sessionId, adUrl });
});

// 8. API: Chuyển sang Quảng Cáo 2/2
app.post('/api/start-ad-2', (req, res) => {
  const { initData, sessionId } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const db = loadDB();
  const sess = db.sessions[sessionId];
  if (!sess) return res.status(404).json({ error: 'Phiên không tồn tại!' });

  // Kiểm tra thời gian video 1: Bắt buộc >= 15s
  const elapsed1 = Date.now() - sess.ad1_start;
  if (elapsed1 < MIN_WATCH_TIME_MS) {
    return res.status(400).json({ error: 'Bạn chưa xem đủ 15 giây quảng cáo 1!' });
  }

  const clickId2 = uuidv4();
  sess.step = 2;
  sess.ad2_start = Date.now();
  sess.ad2_click_id = clickId2;
  sess.status = 'WATCHING_2';
  saveDB(db);

  const adUrl = `${MONETAG_LINK}?sub_id_1=${clickId2}&ymid=${clickId2}`;
  return res.json({ success: true, adUrl });
});

// 9. API: Nhận thưởng sau khi xem xong CẢ 2 QUẢNG CÁO
app.post('/api/claim-reward-double', (req, res) => {
  const { initData, sessionId } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  const sess = db.sessions[sessionId];

  if (!sess || sess.telegram_id !== tgId) return res.status(404).json({ success: false, message: 'Phiên không hợp lệ!' });
  if (sess.status === 'COMPLETED') return res.status(400).json({ success: false, message: 'Đã nhận thưởng rồi!' });
  if (sess.step !== 2) return res.status(400).json({ success: false, message: 'Chưa xem xong quảng cáo thứ 2!' });

  // Kiểm tra thời gian video 2: Bắt buộc >= 15s
  const elapsed2 = Date.now() - sess.ad2_start;
  if (elapsed2 < MIN_WATCH_TIME_MS) {
    return res.status(400).json({ success: false, message: 'Bạn chưa xem đủ 15 giây quảng cáo 2!' });
  }

  sess.status = 'COMPLETED';
  const user = db.users[tgId];

  let returnMsg = "";
  if (user) {
    const now = Math.floor(Date.now() / 1000);
    calculateBalance(user);

    if (sess.reward_type === 'CASH') {
      // CỘNG THẲNG 2 VNĐ TIỀN MẶT
      user.balance += 2.0;
      returnMsg = "🎉 Chúc mừng! Bạn đã nhận trực tiếp +2.00 VNĐ vào số dư!";
    } else {
      // CỘNG 10 PHÚT NHIÊN LIỆU (600 GIÂY)
      if (user.fuel_expires_at > now) {
        user.fuel_expires_at += 600;
      } else {
        user.fuel_expires_at = now + 600;
        user.last_collected_at = now;
      }
      returnMsg = "🎉 Đã cộng +10 phút nhiên liệu in tiền!";
    }
  }

  saveDB(db);
  console.log(`[THƯỞNG] User ${tgId} nhận [${sess.reward_type}] thành công!`);
  return res.json({ success: true, message: returnMsg, rewardType: sess.reward_type });
});

// 10. API Postback Monetag
app.get('/api/postback', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy tại cổng: ${PORT}`));
