const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'database.json');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Простая встроенная система хранения (JSON-БД)
let db = { chats: [{ id: 'global', name: '📢 Общий Канал', type: 'channel' }], messages: [], users: {} };

if (fs.existsSync(DB_FILE)) {
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Загрузка изображений
app.post('/api/upload', (req, res) => {
  const { image, filename } = req.body;
  if (!image) return res.status(400).json({ error: 'Нет файла' });

  const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
  const ext = filename ? path.extname(filename) : '.png';
  const newFileName = `${Date.now()}_${Math.random().toString(36).substr(2, 5)}${ext}`;
  const filePath = path.join(UPLOADS_DIR, newFileName);

  fs.writeFile(filePath, base64Data, 'base64', (err) => {
    if (err) return res.status(500).json({ error: 'Ошибка сохранения' });
    res.json({ url: `/uploads/${newFileName}` });
  });
});

const clients = new Map(); // ws -> { username, id }

wss.on('connection', (ws) => {
  let currentUser = null;

  ws.on('message', (raw) => {
    try {
      const { type, data } = JSON.parse(raw);

      if (type === 'auth') {
        currentUser = data.username.trim();
        db.users[currentUser] = { lastSeen: new Date().toISOString() };
        clients.set(ws, currentUser);
        saveDB();

        // Отправка истории
        ws.send(JSON.stringify({
          type: 'init',
          data: { chats: db.chats, messages: db.messages }
        }));
        broadcastUsers();
      }

      if (type === 'message' && currentUser) {
        const msg = {
          id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          chatId: data.chatId || 'global',
          sender: currentUser,
          text: data.text || '',
          media: data.media || null,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          date: new Date().toISOString()
        };

        db.messages.push(msg);
        saveDB();

        broadcast({ type: 'new_message', data: msg });
      }

      if (type === 'create_chat' && currentUser) {
        const newChat = {
          id: 'chat_' + Date.now(),
          name: data.name,
          type: 'group'
        };
        db.chats.push(newChat);
        saveDB();
        broadcast({ type: 'new_chat', data: newChat });
      }
    } catch (e) { console.error(e); }
  });

  ws.on('close', () => {
    if (currentUser) {
      clients.delete(ws);
      broadcastUsers();
    }
  });
});

function broadcast(payload) {
  const str = JSON.stringify(payload);
  for (const [ws] of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(str);
  }
}

function broadcastUsers() {
  const online = Array.from(clients.values());
  broadcast({ type: 'online_users', data: online });
}

server.listen(PORT, () => {
  console.log(`\n==================================================`);
  console.log(`🚀 Мессенджер запущен!`);
  console.log(`👉 Откройте браузер: http://localhost:${PORT}`);
  console.log(`==================================================\n`);
});