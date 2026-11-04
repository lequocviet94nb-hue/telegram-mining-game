const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

const SERVER_BUILD_ID = Date.now().toString();

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
    fs.writeFileSync(DB_FILE, JSON.stringify({
      users: {}, sessions: {}, devices: {}, withdrawals: [], admin_id: null
    }, null, 2));
  }
  try {
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!data.withdrawals) data.withdrawals = [];
    return data;
  } catch (e) {
    return { users: {}, sessions: {}, devices: {}, withdrawals: [], admin_id: null };
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// 1. Gửi thông báo đến Admin qua Bot Telegram
async function notifyAdmin(text) {
  const db = loadDB();
  if (!db.admin_id || !BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: db.admin_id,
        text: text,
        parse_mode: 'HTML'
      })
    });
  } catch (err) {
    console.error('[Notify Admin Error]', err);
  }
}

// 2. Tự động thiết lập Bot Telegram
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
  } catch (err) {}
}
setupTelegramBot();

app.get('/api/version', (req, res) => res.json({ version: SERVER_BUILD_ID }));

// 3. Webhook Bot Telegram (Hỗ trợ lệnh /admin để bạn đăng ký nhận thông báo)
app.post('/api/telegram-webhook', async (req, res) => {
  const { message } = req.body;
  if (!message || !message.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text.trim();

  // Khi BẠN nhắn /admin -> Bot tự động lưu bạn làm Admin nhận thông báo
  if (text === '/admin') {
    const db = loadDB();
    db.admin_id = chatId;
    saveDB(db);
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `✅ <b>KÍCH HOẠT QUYỀN ADMIN THÀNH CÔNG!</b>\n\nTừ nay mọi thông báo:\n• Người chơi rút tiền\n• Người chơi mời bạn bè xem đủ 5.000 quảng cáo\nSẽ được gửi trực tiếp vào đây cho bạn xử lý!`,
        parse_mode: 'HTML'
      })
    });
    return res.sendStatus(200);
  }

  if (text.startsWith('/start')) {
    const firstName = message.from ? message.from.first_name : 'bạn';
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `👋 Chào mừng <b>${firstName}</b> đến với <b>Máy In Tiền Tự Động</b>!\n\n⚡ Cày tiền VNĐ thụ động 24/7 không giới hạn.\n👇 Bấm nút bên dưới để mở game chơi ngay:`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: "⚡ MỞ MÁY IN TIỀN NGAY ⚡", web_app: { url: APP_URL } }]
          ]
        }
      })
    });
  }
  res.sendStatus(200);
});

// 4. Xác thực Telegram
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

// 5. Tính toán số dư in tiền
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

// 6. API Đăng ký (Có gắn mã Giới Thiệu Bạn Bè)
app.post('/api/register', (req, res) => {
  const { initData, username, pin, deviceId, refCode } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  if (!deviceId) return res.status(400).json({ error: 'Thiết bị không xác định!' });
  if (!username || username.trim().length < 3) return res.status(400).json({ error: 'Tên phải từ 3 ký tự!' });
  if (!pin || pin.trim().length < 4) return res.status(400).json({ error: 'Mã PIN từ 4 số trở lên!' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();

  // Khóa 1 thiết bị = 1 tài khoản
  if (db.devices && db.devices[deviceId] && db.devices[deviceId] !== tgId) {
    return res.status(400).json({ error: '⛔ Thiết bị này đã đăng ký tài khoản khác rồi!' });
  }

  if (db.users[tgId]) return res.status(400).json({ error: 'Tài khoản này đã tồn tại!' });

  const isNameTaken = Object.values(db.users).some(u => u.username.toLowerCase() === username.trim().toLowerCase());
  if (isNameTaken) return res.status(400).json({ error: 'Tên tài khoản này đã có người dùng!' });

  // Kiểm tra mã giới thiệu
  let inviterId = null;
  if (refCode && refCode.startsWith('ref_')) {
    const rawInviterId = refCode.replace('ref_', '').trim();
    if (rawInviterId !== tgId && db.users[rawInviterId]) {
      inviterId = rawInviterId;
    }
  }

  const now = Math.floor(Date.now() / 1000);
  db.users[tgId] = {
    telegram_id: tgId,
    username: username.trim(),
    pin: pin.trim(),
    device_id: deviceId,
    balance: 0,
    fuel_expires_at: now,
    last_collected_at: now,
    rate_per_sec: RATE_PER_SEC_VND,
    invited_by: inviterId,
    ads_watched: 0,
    created_at: now
  };

  if (!db.devices) db.devices = {};
  db.devices[deviceId] = tgId;

  saveDB(db);
  return res.json({ success: true });
});

// 7. API Lấy thông tin tài khoản & Danh sách bạn bè
app.post('/api/user-status', (req, res) => {
  const { initData, deviceId } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();

  if (deviceId && db.devices && db.devices[deviceId] && db.devices[deviceId] !== tgId) {
    return res.json({
      success: false,
      device_blocked: true,
      error: '⛔ THIẾT BỊ NÀY ĐÃ ĐĂNG NHẬP TÀI KHOẢN KHÁC!'
    });
  }

  const user = db.users[tgId];
  if (!user) return res.json({ success: true, is_registered: false });

  user.rate_per_sec = RATE_PER_SEC_VND;
  calculateBalance(user);

  // Lấy danh sách những người mình đã giới thiệu
  const friends = [];
  for (const [fId, fUser] of Object.entries(db.users)) {
    if (fUser.invited_by === tgId) {
      friends.push({
        username: fUser.username,
        ads_watched: fUser.ads_watched || 0,
        is_completed: (fUser.ads_watched || 0) >= 5000
      });
    }
  }

  saveDB(db);

  return res.json({
    success: true,
    is_registered: true,
    user: {
      telegram_id: user.telegram_id,
      username: user.username,
      pin: user.pin,
      balance: user.balance,
      fuel_expires_at: user.fuel_expires_at,
      last_collected_at: user.last_collected_at,
      rate_per_sec: user.rate_per_sec,
      deviceId: user.device_id,
      friends: friends
    }
  });
});

// 8. API RÚT TIỀN (TRỪ SỐ DƯ NGAY LẬP TỨC 100% & THÔNG BÁO CHO ADMIN)
app.post('/api/withdraw', async (req, res) => {
  const { initData, amount, pin, method, bankName, accountNumber, accountName } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  const user = db.users[tgId];

  if (!user) return res.status(404).json({ error: 'Tài khoản không tồn tại!' });

  // Kiểm tra mã PIN bảo mật
  if (user.pin !== pin.trim()) {
    return res.status(400).json({ error: 'Mã PIN bảo mật không chính xác!' });
  }

  // Cập nhật số dư mới nhất
  calculateBalance(user);

  const withdrawAmount = parseFloat(amount);
  if (isNaN(withdrawAmount) || withdrawAmount < 1000) {
    return res.status(400).json({ error: 'Số tiền rút tối thiểu là 1.000 VNĐ!' });
  }

  if (user.balance < withdrawAmount) {
    return res.status(400).json({ error: 'Số dư khả dụng không đủ để rút!' });
  }

  // === TRỪ TIỀN NGAY LẬP TỨC KHÔNG ĐỂ CHẬM TRỄ ===
  user.balance -= withdrawAmount;
  user.last_collected_at = Math.floor(Date.now() / 1000); // Khóa mốc thời gian chống tính bù

  // Lưu lịch sử rút tiền
  const withdrawId = uuidv4().substring(0, 8).toUpperCase();
  const withdrawRecord = {
    id: withdrawId,
    telegram_id: tgId,
    username: user.username,
    amount: withdrawAmount,
    method: method,
    bankName: bankName || '',
    accountNumber: accountNumber.trim(),
    accountName: accountName.trim().toUpperCase(),
    created_at: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
  };

  db.withdrawals.push(withdrawRecord);
  saveDB(db);

  // BẮN THÔNG BÁO TỨC THÌ ĐẾN BOT CHO BẠN (ADMIN)
  const notifyText = `🚨 <b>YÊU CẦU RÚT TIỀN MỚI [#${withdrawId}]</b>\n\n` +
    `👤 <b>Người chơi:</b> ${user.username} (ID: <code>${tgId}</code>)\n` +
    `💰 <b>Số tiền rút:</b> <b>${withdrawAmount.toLocaleString('vi-VN')} VNĐ</b>\n` +
    `🏦 <b>Phương thức:</b> ${method} ${bankName ? '(' + bankName + ')' : ''}\n` +
    `🔢 <b>Số tài khoản / SĐT:</b> <code>${accountNumber.trim()}</code>\n` +
    `📝 <b>Tên chủ tài khoản:</b> <b>${accountName.trim().toUpperCase()}</b>\n` +
    `⏰ <b>Thời gian:</b> ${withdrawRecord.created_at}\n\n` +
    `👉 <i>Vui lòng mở App Ngân hàng / MoMo / ZaloPay chuyển khoản cho người chơi!</i>`;

  notifyAdmin(notifyText);

  console.log(`[RÚT TIỀN] User ${user.username} rút ${withdrawAmount} VNĐ thành công!`);

  // LUÔN BÁO THÀNH CÔNG CHO NGƯỜI CHƠI
  return res.json({
    success: true,
    message: `🎉 Yêu cầu rút ${withdrawAmount.toLocaleString('vi-VN')} VNĐ thành công! Tiền đã được trừ khỏi số dư và sẽ chuyển về tài khoản của bạn.`
  });
});

// 9. API Bắt đầu xem quảng cáo 1/2
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

// 10. API Chuyển sang quảng cáo 2/2
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

// 11. API Nhận thưởng (TỰ ĐỘNG ĐẾM TIẾN ĐỘ 5.000 ADS CHO NGƯỜI GIỚI THIỆU)
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

    // Tăng số ads đã xem của người này (+2 ads)
    user.ads_watched = (user.ads_watched || 0) + 2;

    // KIỂM TRA ĐIỀU KIỆN 5.000 ADS ĐỂ BÁO CHO ADMIN THƯỞNG 10.000 VNĐ
    if (user.invited_by && db.users[user.invited_by]) {
      const inviter = db.users[user.invited_by];
      if (user.ads_watched >= 5000 && !user.notified_5000) {
        user.notified_5000 = true;
        const refAlert = `🎁 <b>THƯỞNG GIỚI THIỆU BẠN BÈ (5.000 ADS)</b>\n\n` +
          `👤 <b>Người mời:</b> ${inviter.username} (ID: <code>${inviter.telegram_id}</code>)\n` +
          `👥 <b>Người được mời:</b> ${user.username} (ID: <code>${tgId}</code>)\n` +
          `🎯 <b>Tiến độ:</b> ĐÃ HOÀN THÀNH 5.000 QUẢNG CÁO!\n\n` +
          `💵 <b>PHẦN THƯỞNG: 10.000 VNĐ</b>\n` +
          `👉 <i>Hãy liên hệ và chuyển khoản 10.000 VNĐ cho người mời: ${inviter.username}!</i>`;
        notifyAdmin(refAlert);
      }
    }

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

app.get('/api/postback', (req, res) => res.send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server chạy tại cổng: ${PORT}`));
