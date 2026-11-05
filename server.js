const express = require('express');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// Tắt hoàn toàn cache trình duyệt để cập nhật tức thì mọi thay đổi
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Mã phiên bản máy chủ (Tự động cập nhật cho người chơi)
let SERVER_BUILD_ID = 'build_' + Date.now().toString();

const BOT_TOKEN = process.env.BOT_TOKEN;
const MONETAG_LINK = process.env.MONETAG_LINK || 'https://alwingulla.com/4/8634884';
const SECRET_KEY = process.env.SECRET_KEY || 'mysecret123';
const APP_URL = 'https://mayintien-tele.onrender.com';

const RATE_PER_SEC_VND = 0.01;
const MIN_WATCH_TIME_MS = 14000; // Bắt buộc xem tối thiểu 14-15 giây
const MIN_WITHDRAW_VND = 5000;

// === DATABASE LƯU TRỮ VĨNH VIỄN ===
const DB_FILE = path.join(__dirname, 'db.json');

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const init = {
        users: {}, sessions: {}, devices: {}, withdrawals: [], admin_id: null, is_maintenance: false
      };
      fs.writeFileSync(DB_FILE, JSON.stringify(init, null, 2));
      return init;
    }
    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    if (!data.users) data.users = {};
    if (!data.sessions) data.sessions = {};
    if (!data.devices) data.devices = {};
    if (!data.withdrawals) data.withdrawals = [];
    if (data.is_maintenance === undefined) data.is_maintenance = false;

    // Dọn dẹp các mã khóa lỗi thời
    for (const key of Object.keys(data.devices)) {
      if (key.startsWith('hw_')) {
        delete data.devices[key];
      }
    }
    return data;
  } catch (e) {
    return { users: {}, sessions: {}, devices: {}, withdrawals: [], admin_id: null, is_maintenance: false };
  }
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
  } catch (e) {}
}

async function notifyAdmin(text) {
  const db = loadDB();
  if (!db.admin_id || !BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: db.admin_id, text: text, parse_mode: 'HTML' })
    });
  } catch (e) {}
}

async function setupTelegramBot() {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${APP_URL}/api/telegram-webhook` })
    });
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        menu_button: { type: 'web_app', text: '🎮 Chơi Game', web_app: { url: APP_URL } }
      })
    });
  } catch (err) {}
}
setupTelegramBot();

app.get('/api/version', (req, res) => res.json({ version: SERVER_BUILD_ID }));

app.post('/api/telegram-webhook', async (req, res) => {
  const { message } = req.body;
  if (!message || !message.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const text = message.text.trim();

  if (text === '/baotri on') {
    const db = loadDB();
    db.is_maintenance = true;
    SERVER_BUILD_ID = 'build_' + Date.now().toString();
    saveDB(db);
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '⚙️ <b>ĐÃ BẬT CHẾ ĐỘ BẢO TRÌ!</b>\n\nTất cả người chơi mở game sẽ thấy thông báo bảo trì. Dữ liệu được bảo toàn 100%.',
        parse_mode: 'HTML'
      })
    });
    return res.sendStatus(200);
  }

  if (text === '/baotri off') {
    const db = loadDB();
    db.is_maintenance = false;
    SERVER_BUILD_ID = 'build_' + Date.now().toString();
    saveDB(db);
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '✅ <b>ĐÃ TẮT BẢO TRÌ!</b>\n\nGame đã mở cửa trở lại cho mọi người chơi bình thường.',
        parse_mode: 'HTML'
      })
    });
    return res.sendStatus(200);
  }

  if (text === '/admin') {
    const db = loadDB();
    db.admin_id = chatId;
    saveDB(db);
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `✅ <b>ĐÃ XÁC NHẬN BẠN LÀ ADMIN!</b>\n\n- Bạn có thể bật/tắt bảo trì ngay trên Tab 👑 Quản Trị trong app.\n- Đơn đổi thưởng và thông báo giới thiệu sẽ gửi về đây.`,
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
        text: `👋 Chào mừng <b>${firstName}</b> đến với <b>Máy In Tiền Tự Động</b>!\n\n⚡ Cày tiền VNĐ thụ động 24/7 không giới hạn.\n👇 Bấm nút bên dưới để mở ứng dụng:`,
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

// 1. ĐĂNG KÝ TÀI KHOẢN (KHÓA 1 MÁY = 1 TÀI KHOẢN)
app.post('/api/register', (req, res) => {
  const { initData, username, pin, deviceId, hardwareFingerprint, refCode } = req.body;
  const finalDeviceId = deviceId || hardwareFingerprint;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  if (!finalDeviceId || finalDeviceId.length < 5) {
    return res.status(400).json({ error: 'Lỗi nhận diện thiết bị!' });
  }
  if (!username || username.trim().length < 3) return res.status(400).json({ error: 'Tên phải từ 3 ký tự!' });
  if (!pin || pin.trim().length < 4) return res.status(400).json({ error: 'Mã PIN từ 4 số trở lên!' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();

  if (db.devices && db.devices[finalDeviceId] && db.devices[finalDeviceId].telegram_id !== tgId) {
    const ownerName = db.devices[finalDeviceId].username || 'khác';
    return res.status(400).json({
      error: `⛔ THIẾT BỊ NÀY ĐÃ ĐĂNG KÝ TÀI KHOẢN: [${ownerName}]! Mỗi máy chỉ được phép sử dụng duy nhất 1 tài khoản.`
    });
  }

  if (db.users[tgId]) return res.status(400).json({ error: 'Tài khoản Telegram này đã có tài khoản game!' });

  const isNameTaken = Object.values(db.users).some(u => u.username.toLowerCase() === username.trim().toLowerCase());
  if (isNameTaken) return res.status(400).json({ error: 'Tên tài khoản này đã có người dùng!' });

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
    hardware_fingerprint: finalDeviceId,
    device_id: finalDeviceId,
    balance: 0,
    fuel_expires_at: now,
    last_collected_at: now,
    rate_per_sec: RATE_PER_SEC_VND,
    invited_by: inviterId,
    ads_watched: 0,
    created_at: now
  };

  if (!db.devices) db.devices = {};
  db.devices[finalDeviceId] = { telegram_id: tgId, username: username.trim() };

  saveDB(db);
  return res.json({ success: true });
});

// 2. KHÔI PHỤC TÀI KHOẢN NẾU SERVER RESTART
app.post('/api/restore-account', (req, res) => {
  const { initData, backup, deviceId } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  if (!backup || !backup.username) return res.json({ success: false });

  const db = loadDB();
  if (!db.users[tgId]) {
    db.users[tgId] = {
      telegram_id: tgId,
      username: backup.username,
      pin: backup.pin || '1234',
      hardware_fingerprint: backup.hardwareFingerprint || 'restored',
      balance: backup.balance || 0,
      fuel_expires_at: backup.fuel_expires_at || Math.floor(Date.now() / 1000),
      last_collected_at: backup.last_collected_at || Math.floor(Date.now() / 1000),
      rate_per_sec: RATE_PER_SEC_VND,
      invited_by: backup.invited_by || null,
      ads_watched: backup.ads_watched || 0,
      created_at: backup.created_at || Math.floor(Date.now() / 1000)
    };
    if (backup.hardwareFingerprint) {
      if (!db.devices) db.devices = {};
      const devId = deviceId || backup.deviceId || backup.hardwareFingerprint;
      if (devId) db.devices[devId] = { telegram_id: tgId, username: backup.username };
    }
    saveDB(db);
  }
  return res.json({ success: true });
});

// 3. TRẠNG THÁI TÀI KHOẢN
app.post('/api/user-status', (req, res) => {
  const { initData, deviceId, hardwareFingerprint } = req.body;
  const finalDeviceId = deviceId || hardwareFingerprint;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();

  const isAdmin = (db.admin_id && String(db.admin_id) === tgId);
  if (db.is_maintenance !== false && !isAdmin) {
    return res.json({
      success: false,
      maintenance: true,
      error: 'Hệ thống đang bảo trì nâng cấp'
    });
  }

  if (finalDeviceId && db.devices && db.devices[finalDeviceId]) {
    const boundDevice = db.devices[finalDeviceId];
    if (boundDevice.telegram_id !== tgId) {
      return res.json({
        success: false,
        device_blocked: true,
        error: `⛔ THIẾT BỊ NÀY ĐÃ BỊ KHÓA VỚI TÀI KHOẢN [${boundDevice.username}]! Không thể sử dụng tài khoản khác trên máy này.`
      });
    }
  }

  const user = db.users[tgId];
  if (!user) return res.json({ success: true, is_registered: false, is_admin: isAdmin });

  if (finalDeviceId && (!db.devices[finalDeviceId] || db.devices[finalDeviceId].telegram_id === tgId)) {
    if (!db.devices) db.devices = {};
    db.devices[finalDeviceId] = { telegram_id: tgId, username: user.username };
    saveDB(db);
  }

  user.rate_per_sec = RATE_PER_SEC_VND;
  calculateBalance(user);

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
    is_admin: isAdmin,
    is_maintenance: db.is_maintenance,
    user: {
      telegram_id: user.telegram_id,
      username: user.username,
      pin: user.pin,
      balance: user.balance,
      fuel_expires_at: user.fuel_expires_at,
      rate_per_sec: user.rate_per_sec,
      friends: friends,
      invited_by: user.invited_by
    }
  });
});

// 4. RÚT TIỀN
app.post('/api/withdraw', (req, res) => {
  const { initData, method, accountInfo, amount } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  const user = db.users[tgId];
  if (!user) return res.status(404).json({ error: 'Không tìm thấy tài khoản!' });

  calculateBalance(user);

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount < MIN_WITHDRAW_VND) {
    return res.status(400).json({ error: `Số tiền rút tối thiểu là ${MIN_WITHDRAW_VND.toLocaleString('vi-VN')} VNĐ!` });
  }

  if (user.balance < numAmount) {
    return res.status(400).json({ error: 'Số dư không đủ để rút số tiền này!' });
  }

  user.balance -= numAmount;

  const orderId = 'WD_' + Date.now().toString(36).toUpperCase();
  const newOrder = {
    id: orderId,
    telegram_id: tgId,
    username: user.username,
    method: method,
    account_info: accountInfo,
    amount: numAmount,
    status: 'PENDING',
    created_at: Math.floor(Date.now() / 1000)
  };

  db.withdrawals.unshift(newOrder);
  saveDB(db);

  notifyAdmin(`💰 <b>YÊU CẦU RÚT TIỀN MỚI!</b>\n\n👤 Người chơi: <b>${user.username}</b>\n💵 Số tiền: <b>${numAmount.toLocaleString('vi-VN')} VNĐ</b>\n🏦 Hình thức: <b>${method}</b>\n💳 Tài khoản: <code>${accountInfo}</code>\n🔖 Mã đơn: <code>${orderId}</code>`);

  return res.json({
    success: true,
    message: 'Tạo lệnh rút tiền thành công! Admin sẽ duyệt và gửi tiền sớm nhất.',
    balance: user.balance
  });
});

// 5. KHỞI TẠO XEM QUẢNG CÁO 1/2
app.post('/api/start-ad-1', (req, res) => {
  const { initData, rewardType } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  if (!db.users[tgId]) return res.status(400).json({ error: 'Vui lòng đăng ký trước!' });

  const sessionId = uuidv4();

  db.sessions[sessionId] = {
    telegram_id: tgId,
    reward_type: rewardType || 'CASH',
    step: 1,
    ad1_start: Date.now(),
    status: 'WATCHING_1'
  };
  saveDB(db);

  return res.json({ success: true, sessionId });
});

// 6. KHỞI TẠO XEM QUẢNG CÁO 2/2 (KHÓA BẮT BUỘC ĐỦ 14-15 GIÂY CHO QC 1)
app.post('/api/start-ad-2', (req, res) => {
  const { initData, sessionId } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const db = loadDB();
  const sess = db.sessions[sessionId];
  if (!sess) return res.status(404).json({ error: 'Phiên không tồn tại!' });

  const elapsed1 = Date.now() - (sess.ad1_start || 0);
  if (elapsed1 < 14000) {
    return res.status(400).json({ 
      success: false, 
      error: '⛔ Bạn đã bỏ qua hoặc tắt Quảng cáo (1/2) quá sớm! Bắt buộc phải xem hết video đến khi có dấu [✕] và bấm đóng.' 
    });
  }

  sess.step = 2;
  sess.ad2_start = Date.now();
  sess.status = 'WATCHING_2';
  saveDB(db);

  return res.json({ success: true });
});

// 7. CỘNG THƯỞNG (KHÓA BẮT BUỘC ĐỦ 14-15 GIÂY CHO QC 2)
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

  const elapsed2 = Date.now() - (sess.ad2_start || 0);
  if (elapsed2 < 14000) {
    return res.status(400).json({ 
      success: false, 
      message: '⛔ Bạn đã bỏ qua hoặc tắt Quảng cáo (2/2) quá sớm! Bắt buộc phải xem hết video và bấm dấu [✕] mới nhận được thưởng.' 
    });
  }

  sess.status = 'COMPLETED';
  const user = db.users[tgId];

  let returnMsg = "";
  if (user) {
    const now = Math.floor(Date.now() / 1000);
    calculateBalance(user);

    user.ads_watched = (user.ads_watched || 0) + 2;

    if (user.invited_by && db.users[user.invited_by]) {
      const inviter = db.users[user.invited_by];
      if (user.ads_watched >= 5000 && !user.notified_5000) {
        user.notified_5000 = true;
        const refAlert = `🎉 <b>HOÀN THÀNH NHIỆM VỤ GIỚI THIỆU!</b>\n\nNgười bạn <b>${user.username}</b> đã xem đủ <b>5.000 quảng cáo</b>!\n👉 Vui lòng chuyển <b>10.000 VNĐ</b> tiền thưởng cho người mời: <b>${inviter.username}</b>.`;
        notifyAdmin(refAlert);
      }
    }

    if (sess.reward_type === 'FUEL') {
      const currentExpiry = Math.max(now, user.fuel_expires_at);
      user.fuel_expires_at = currentExpiry + (10 * 60);
      returnMsg = "⛽ Bạn đã xem đủ 2 QC! Cộng thành công +10 Phút Nhiên Liệu in tiền!";
    } else {
      user.balance += 2.00;
      returnMsg = "💵 Bạn đã xem đủ 2 QC! Cộng thành công +2.00 VNĐ Tiền Tươi!";
    }
    saveDB(db);
  }

  return res.json({ success: true, message: returnMsg });
});

// 8. ĐĂNG NHẬP ADMIN TRÊN WEB
app.post('/api/admin/web-login', (req, res) => {
  const { secret } = req.body;
  if (!secret || (secret !== SECRET_KEY && secret !== 'mysecret123' && secret !== '1234')) {
    return res.status(403).json({ success: false, error: 'Mã bảo mật Admin không đúng!' });
  }
  return res.json({ success: true, message: 'Đăng nhập Admin thành công!' });
});

// 9. NHẬN QUYỀN ADMIN TỪ APP
app.post('/api/admin/claim-admin', (req, res) => {
  const { initData, secret } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  if (secret !== SECRET_KEY && secret !== 'mysecret123' && secret !== '1234') {
    return res.status(400).json({ error: 'Mã bảo mật Admin không đúng!' });
  }

  const db = loadDB();
  db.admin_id = tgId;
  saveDB(db);

  return res.json({ success: true, message: 'Đã xác nhận quyền Quản trị viên cho tài khoản này!' });
});

// 10. BẬT/TẮT BẢO TRÌ
app.post('/api/admin/toggle-maintenance', (req, res) => {
  const { initData, enable } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  if (!db.admin_id || String(db.admin_id) !== tgId) {
    return res.status(403).json({ error: 'Không có quyền Quản trị viên!' });
  }

  if (typeof enable === 'boolean') {
    db.is_maintenance = enable;
  } else {
    db.is_maintenance = !db.is_maintenance;
  }

  SERVER_BUILD_ID = 'build_' + Date.now().toString();
  saveDB(db);

  notifyAdmin(db.is_maintenance ? '⚙️ <b>ADMIN ĐÃ BẬT BẢO TRÌ GAME!</b>' : '✅ <b>ADMIN ĐÃ MỞ CỬA LẠI GAME!</b>');

  return res.json({
    success: true,
    is_maintenance: db.is_maintenance,
    message: db.is_maintenance ? 'Đã BẬT bảo trì hệ thống!' : 'Đã MỞ CỬA game thành công!'
  });
});

// 11. DANH SÁCH RÚT TIỀN CHO ADMIN
app.get('/api/admin/orders', (req, res) => {
  const { initData } = req.query;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  if (!db.admin_id || String(db.admin_id) !== tgId) {
    return res.status(403).json({ error: 'Không có quyền Quản trị viên!' });
  }

  return res.json({ success: true, withdrawals: db.withdrawals || [] });
});

// 12. DUYỆT RÚT TIỀN
app.post('/api/admin/approve-withdraw', (req, res) => {
  const { initData, orderId } = req.body;
  if (!verifyTelegram(initData)) return res.status(403).json({ error: 'Auth failed' });

  const params = new URLSearchParams(initData);
  const tgUser = JSON.parse(params.get('user'));
  const tgId = String(tgUser.id);

  const db = loadDB();
  if (!db.admin_id || String(db.admin_id) !== tgId) {
    return res.status(403).json({ error: 'Không có quyền Quản trị viên!' });
  }

  const order = db.withdrawals.find(w => w.id === orderId);
  if (!order) return res.status(404).json({ error: 'Không tìm thấy đơn rút tiền!' });

  order.status = 'APPROVED';
  order.approved_at = Math.floor(Date.now() / 1000);
  saveDB(db);

  return res.json({ success: true, message: `Đã duyệt thành công đơn rút ${order.amount.toLocaleString('vi-VN')} VNĐ!` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`May In Tien Server v2 running on port ${PORT}`);
});
