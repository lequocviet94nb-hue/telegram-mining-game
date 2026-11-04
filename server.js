const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// === 1. CHỐNG LƯU CACHE (Bắt Telegram luôn lấy bản mới nhất) ===
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// === MÃ PHIÊN BẢN TỰ ĐỘNG (Mỗi lần bạn commit, mã này tự đổi) ===
const SERVER_BUILD_ID = Date.now().toString();

// === CẤU HÌNH BIẾN MÔI TRƯỜNG ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONETAG_LINK = process.env.MONETAG_LINK;
const SECRET_KEY = process.env.SECRET_KEY || 'mysecret123';
const APP_URL = 'https://mayintien-tele.onrender.com';

const RATE_PER_SEC_VND = 0.01;
const MIN_WATCH_TIME_MS = 15000;

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

// 2. Tự động cài đặt Webhook và Menu Button cho Bot Telegram
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

// 3. API Kiểm tra phiên bản mới (Game sẽ liên tục hỏi server xem có bản mới chưa)
app.get('/api/version', (req, res) => {
  res.json({ version: SERVER_BUILD_ID });
});

// 4. Webhook Telegram phản hồi tin nhắn /start
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

// 5. Xác thực Telegram initData
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

// 6. Tính toán tiền in tự động
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

// 7. API: Đăng ký tài khoản
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

// 8. API: Lấy thông tin tài khoản
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

// 9. API: Bắt đầu Quảng Cáo 1/2
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
    reward_type: rewardType || 'CASH',
    step: 1,
    ad1_start: Date.now(),
    ad1_click_id: clickId1,
    status: 'WATCHING_1'
  };
  saveDB(db);

  const adUrl = `${MONETAG_LINK}?sub_id_1=${clickId1}&ymid=${clickId1}`;
  return res.json({ success: true, sessionId, adUrl });
});

// 10. API: Chuyển sang Quảng Cáo 2/2
app.post('/api/start-ad-2', (req, res) => {
  const { initData, sessionId } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const db = loadDB();
  const sess = db.sessions[sessionId];
  if (!sess) return res.status(404).json({ error: 'Phiên không tồn tại!' });

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

// 11. API: Nhận thưởng
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
      user.balance += 2.0;
      returnMsg = "🎉 Chúc mừng! Bạn đã nhận trực tiếp +2.00 VNĐ vào số dư!";
    } else {
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
  return res.json({ success: true, message: returnMsg, rewardType: sess.reward_type });
});

// 12. Postback Monetag
app.get('/api/postback', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy tại cổng: ${PORT}`));
