'use strict';
// Позор Squad: текстовые и голосовые каналы, роли, звонки, личные коды и панель.
// Realtime: Server-Sent Events (сервер -> клиент). Действия: обычные POST (клиент -> сервер).
// WebRTC: сервер только передаёт сигналы между участниками одного голосового канала.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;
const PUBLIC_DIR = path.join(__dirname, 'public');
// Коды, созданные в панели, хранятся здесь. На бесплатном хостинге файл стирается
// при пересборке сервиса, поэтому важные коды лучше задавать в ADMIN_CODES / ACCESS_CODES.
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'codes.json');
const SHARED = (process.env.ACCESS_CODE || '').trim();   // старый общий код, необязательно
const HISTORY_LIMIT = 300;
const MAX_CHANNELS = 40;
const MAX_ROLES = 30;
const GRACE_MS = 15000;
const REACTIONS = ['🔥', '😂', '💀', '🤡'];

const channels = [
  { id: 'general', name: 'общий', type: 'text' },
  { id: 'memes', name: 'мемы', type: 'text' },
  { id: 'plans', name: 'планы', type: 'text' },
  { id: 'shame', name: 'позор-дня', type: 'text' },
  { id: 'voice-main', name: 'Основной', type: 'voice' },
];
const messages = {};
channels.forEach(c => { if (c.type === 'text') messages[c.id] = []; });

const roles = [];          // { id, name, color } — роли для раскраски ников
const memberRoles = {};    // ник в нижнем регистре -> [id ролей]
const clients = new Map(); // id -> { id, name, role, res, timer, voiceCh }
const voice = new Map();   // id голосового канала -> Set(id клиентов)

// ----- Коды доступа и роли (admin / mod / member) -----
// codes: Map код -> { name (нижний регистр), display, role }
const codes = new Map();

function uid() { return crypto.randomUUID(); }
function cleanName(s, max) { return String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max); }
function slug(s) { return cleanName(s, 24).replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-'); }
function findChannel(id) { return channels.find(c => c.id === id) || null; }

function parsePairs(s) {
  return String(s || '').split(',').map(p => {
    const i = p.indexOf(':');
    if (i < 0) return null;
    const name = cleanName(p.slice(0, i), 20);
    const code = p.slice(i + 1).trim();
    return name && code ? { name, code } : null;
  }).filter(Boolean);
}

function putCode(code, display, role) {
  codes.set(code, { name: display.toLowerCase(), display, role });
}

function loadCodes() {
  // Коды из переменных окружения: ADMIN_CODES="Ник:код" и ACCESS_CODES="Ник:код,..."
  parsePairs(process.env.ADMIN_CODES).forEach(p => putCode(p.code, p.name, 'admin'));
  parsePairs(process.env.ACCESS_CODES).forEach(p => putCode(p.code, p.name, 'member'));
  // Коды, созданные через панель
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    (saved.codes || []).forEach(r => {
      if (r && r.code && r.name && ['admin', 'mod', 'member'].includes(r.role) && !codes.has(r.code)) {
        putCode(r.code, r.name, r.role);
      }
    });
  } catch (_) { /* файла нет или он пустой — это нормально */ }
}

function saveCodes() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const list = [...codes.entries()].map(([code, r]) => ({ code, name: r.display, role: r.role }));
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ codes: list }, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('Не удалось сохранить коды:', e.message);
  }
}

function codeRequired() { return codes.size > 0 || !!SHARED; }

// Запись кода, если он подходит именно этому нику.
function recordFor(code, name) {
  const lower = String(name || '').toLowerCase();
  if (SHARED && code === SHARED) return { name: lower, display: name, role: 'member' };
  const r = codes.get(code);
  return r && r.name === lower ? r : null;
}
function codeOk(code, name) { return !codeRequired() || !!recordFor(code, name); }
function codeKnown(code) { return !codeRequired() || codes.has(code) || (!!SHARED && code === SHARED); }
function roleFor(code, name) { if (!codeRequired()) return 'member'; const r = recordFor(code, name); return r ? r.role : 'member'; }
function isStaff(role) { return role === 'admin' || role === 'mod'; }

// ----- Рассылка -----

function send(res, event, data) {
  if (!res || res.writableEnded) return;
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}
function broadcast(event, data) {
  for (const c of clients.values()) send(c.res, event, data);
}

function roleList(name) {
  return (memberRoles[name.toLowerCase()] || []).map(id => roles.find(r => r.id === id)).filter(Boolean);
}
function memberView(c) { return { id: c.id, name: c.name, role: c.role, roles: roleList(c.name) }; }
function onlineMembers() { return [...clients.values()].filter(c => c.res).map(memberView); }

function voiceView() {
  const out = {};
  channels.filter(c => c.type === 'voice').forEach(c => { out[c.id] = []; });
  for (const [chId, set] of voice) {
    out[chId] = [...set].map(id => clients.get(id)).filter(Boolean).map(c => ({ id: c.id, name: c.name }));
  }
  return out;
}

function broadcastPresence() { broadcast('presence', { members: onlineMembers() }); }
function broadcastVoice() { broadcast('voice', { voice: voiceView() }); }
function broadcastRoles() { broadcast('roles', { roles }); broadcastPresence(); }

function leaveVoice(c) {
  if (!c || !c.voiceCh) return;
  const set = voice.get(c.voiceCh);
  if (set) { set.delete(c.id); if (!set.size) voice.delete(c.voiceCh); }
  c.voiceCh = null;
}

function getClient(id) {
  const c = clients.get(id);
  return c && c.res ? c : null;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, cb) {
  let size = 0;
  const chunks = [];
  req.on('data', chunk => {
    size += chunk.length;
    if (size > 100 * 1024) { req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => {
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
    catch (e) { cb(e); }
  });
}

function findMessage(channelId, messageId) {
  const list = messages[channelId];
  if (!list) return null;
  return list.find(m => m.id === messageId) || null;
}

// Пинг, чтобы соединения не рвались на прокси.
setInterval(() => {
  for (const c of clients.values()) {
    if (c.res && !c.res.writableEnded) c.res.write(': ping\n\n');
  }
}, 20000).unref();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const reqCode = url.searchParams.get('code') || '';

  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

  if (p === '/' || p === '/index.html') {
    return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end('no index'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  if (p === '/api/config' && req.method === 'GET') {
    return json(res, 200, { needsCode: codeRequired(), reactions: REACTIONS });
  }

  if (p === '/api/check' && req.method === 'GET') {
    const name = cleanName(url.searchParams.get('name'), 20);
    return codeOk(reqCode, name) ? json(res, 200, { ok: true }) : json(res, 403, { error: 'Неверный код или ник' });
  }

  // Всё ниже требует код доступа, если коды заданы.
  if (!codeKnown(reqCode)) return json(res, 403, { error: 'Неверный код или ник' });

  if (p === '/events' && req.method === 'GET') {
    const rawId = url.searchParams.get('id') || '';
    const id = /^[A-Za-z0-9-]{8,64}$/.test(rawId) ? rawId : uid();
    const name = cleanName(url.searchParams.get('name'), 20);
    if (!name) return json(res, 400, { error: 'Нужен ник' });
    if (!codeOk(reqCode, name)) return json(res, 403, { error: 'Неверный код или ник' });

    let c = clients.get(id);
    if (c) {
      clearTimeout(c.timer);
      if (c.res && !c.res.writableEnded) c.res.end();   // старое соединение уступает новому
    } else {
      c = { id, name, role: 'member', res: null, timer: null, voiceCh: null };
      clients.set(id, c);
    }
    c.name = name;
    c.role = roleFor(reqCode, name);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    c.res = res;

    send(res, 'hello', {
      id,
      role: c.role,
      channels,
      roles,
      members: onlineMembers(),
      voice: voiceView(),
      myVoice: c.voiceCh,
    });
    broadcastPresence();

    req.on('close', () => {
      if (c.res !== res) return;   // соединение уже заменено новым или выгнано
      c.res = null;
      c.timer = setTimeout(() => {
        leaveVoice(c);
        clients.delete(id);
        broadcastPresence();
        broadcastVoice();
      }, GRACE_MS);
    });
    return;
  }

  if (p === '/api/messages' && req.method === 'GET') {
    const ch = url.searchParams.get('channel');
    if (!messages[ch]) return json(res, 404, { error: 'Нет такого текстового канала' });
    return json(res, 200, { messages: messages[ch] });
  }

  if (req.method !== 'POST') return json(res, 404, { error: 'Not found' });

  readBody(req, (err, body) => {
    if (err) return json(res, 400, { error: 'Плохой JSON' });
    const me = getClient(body.id);
    if (!me) return json(res, 401, { error: 'Сначала зайди в чат' });
    if (!codeOk(reqCode, me.name)) return json(res, 403, { error: 'Неверный код или ник' });

    if (p === '/api/message') {
      const text = String(body.text || '').trim().slice(0, 2000);
      if (!text) return json(res, 400, { error: 'Пустое сообщение' });
      if (!messages[body.channel]) return json(res, 404, { error: 'Нет такого текстового канала' });
      const msg = { id: uid(), author: me.name, text, ts: Date.now(), reactions: {} };
      const list = messages[body.channel];
      list.push(msg);
      if (list.length > HISTORY_LIMIT) list.splice(0, list.length - HISTORY_LIMIT);
      broadcast('message', { channel: body.channel, msg });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/react') {
      const msg = findMessage(body.channel, body.messageId);
      const emoji = String(body.emoji || '');
      if (!msg || !REACTIONS.includes(emoji)) return json(res, 400, { error: 'Нельзя так' });
      const arr = (msg.reactions[emoji] = msg.reactions[emoji] || []);
      const i = arr.indexOf(me.name);
      if (i >= 0) arr.splice(i, 1); else arr.push(me.name);
      if (!arr.length) delete msg.reactions[emoji];
      broadcast('message-update', { channel: body.channel, msg });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/delete') {
      const msg = findMessage(body.channel, body.messageId);
      if (!msg) return json(res, 404, { error: 'Нет сообщения' });
      if (msg.author !== me.name && !isStaff(me.role)) return json(res, 403, { error: 'Можно удалять только свои' });
      messages[body.channel] = messages[body.channel].filter(m => m.id !== msg.id);
      broadcast('message-delete', { channel: body.channel, messageId: msg.id });
      return json(res, 200, { ok: true });
    }

    if (p === '/api/channel') {
      const name = slug(body.name);
      if (!name) return json(res, 400, { error: 'Нужно название' });
      if (channels.length >= MAX_CHANNELS) return json(res, 400, { error: 'Слишком много каналов' });
      const type = body.type === 'voice' ? 'voice' : 'text';
      const ch = { id: 'c' + uid().slice(0, 8), name, type };
      channels.push(ch);
      if (type === 'text') messages[ch.id] = [];
      broadcast('channels', { channels });
      broadcastVoice();
      return json(res, 200, { channel: ch });
    }

    if (p === '/api/voice') {
      if (body.join) {
        const ch = findChannel(body.channel);
        if (!ch || ch.type !== 'voice') return json(res, 400, { error: 'Это не голосовой канал' });
        if (me.voiceCh !== ch.id) leaveVoice(me);
        if (!voice.has(ch.id)) voice.set(ch.id, new Set());
        voice.get(ch.id).add(me.id);
        me.voiceCh = ch.id;
      } else if (me.voiceCh === body.channel) {
        leaveVoice(me);
      }
      broadcastVoice();
      return json(res, 200, { voice: voiceView(), myVoice: me.voiceCh });
    }

    if (p === '/api/signal') {
      // Сигналы уходят только участнику того же голосового канала.
      const target = getClient(body.to);
      if (target && me.voiceCh && target.voiceCh === me.voiceCh) {
        send(target.res, 'signal', { from: me.id, data: body.data });
      }
      return json(res, 200, { ok: true });
    }

    if (p === '/api/role') {
      if (!isStaff(me.role)) return json(res, 403, { error: 'Нет прав' });
      const name = cleanName(body.name, 20);
      const color = /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : '#99aab5';
      if (!name) return json(res, 400, { error: 'Нужно название роли' });
      if (roles.length >= MAX_ROLES) return json(res, 400, { error: 'Слишком много ролей' });
      roles.push({ id: uid(), name, color });
      broadcastRoles();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/role/delete') {
      if (!isStaff(me.role)) return json(res, 403, { error: 'Нет прав' });
      const i = roles.findIndex(r => r.id === body.roleId);
      if (i < 0) return json(res, 404, { error: 'Нет такой роли' });
      roles.splice(i, 1);
      Object.keys(memberRoles).forEach(name => {
        memberRoles[name] = memberRoles[name].filter(id => id !== body.roleId);
        if (!memberRoles[name].length) delete memberRoles[name];
      });
      broadcastRoles();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/member-role') {
      if (!isStaff(me.role)) return json(res, 403, { error: 'Нет прав' });
      const name = cleanName(body.member, 20).toLowerCase();
      const role = roles.find(r => r.id === body.roleId);
      if (!name || !role) return json(res, 400, { error: 'Нет такой роли или участника' });
      const list = (memberRoles[name] = memberRoles[name] || []);
      const i = list.indexOf(role.id);
      if (body.on && i < 0) list.push(role.id);
      if (!body.on && i >= 0) list.splice(i, 1);
      if (!list.length) delete memberRoles[name];
      broadcastRoles();
      return json(res, 200, { ok: true });
    }

    // ----- Панель: коды доступа -----

    if (p === '/api/codes/list') {
      if (!isStaff(me.role)) return json(res, 403, { error: 'Нет прав' });
      const order = { admin: 0, mod: 1, member: 2 };
      const list = [...codes.entries()]
        .map(([code, r]) => ({ code, name: r.display, role: r.role }))
        .sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name, 'ru'));
      return json(res, 200, { codes: list });
    }

    if (p === '/api/codes/create') {
      if (!isStaff(me.role)) return json(res, 403, { error: 'Нет прав' });
      const name = cleanName(body.name, 20);
      const role = body.role === 'mod' ? 'mod' : 'member';
      if (!name) return json(res, 400, { error: 'Введи ник' });
      if (role === 'mod' && me.role !== 'admin') return json(res, 403, { error: 'Модер может создавать только обычные коды' });
      const lower = name.toLowerCase();
      if ([...codes.values()].some(r => r.name === lower)) return json(res, 400, { error: 'Такой ник уже занят' });
      let code;
      do { code = crypto.randomBytes(4).toString('hex'); } while (codes.has(code));
      putCode(code, name, role);
      saveCodes();
      return json(res, 200, { code, name, role });
    }

    if (p === '/api/codes/delete') {
      if (!isStaff(me.role)) return json(res, 403, { error: 'Нет прав' });
      const rec = codes.get(body.code);
      if (!rec) return json(res, 404, { error: 'Нет такого кода' });
      if (rec.role === 'admin') return json(res, 403, { error: 'Код админа из панели не удаляется' });
      if (rec.role === 'mod' && me.role !== 'admin') return json(res, 403, { error: 'Модера может удалить только админ' });
      if (rec.name === me.name.toLowerCase()) return json(res, 400, { error: 'Свой код не удаляется' });
      codes.delete(body.code);
      saveCodes();
      // Выбиваем человека из чата, если он сейчас подключён.
      for (const [id, c] of clients) {
        if (c.name.toLowerCase() !== rec.name) continue;
        leaveVoice(c);
        const res2 = c.res;
        c.res = null;
        clearTimeout(c.timer);
        clients.delete(id);
        if (res2 && !res2.writableEnded) res2.end();
      }
      broadcastPresence();
      broadcastVoice();
      return json(res, 200, { ok: true });
    }

    return json(res, 404, { error: 'Not found' });
  });
});

loadCodes();

server.listen(PORT, () => {
  const mode = codes.size ? 'кодов: ' + codes.size : (SHARED ? 'общий код' : 'без кода доступа');
  console.log('Позор Squad запущен на порту ' + PORT + ' (' + mode + ')');
  if (!codes.size && !SHARED) console.log('Внимание: без кодов панель недоступна. Задайте ADMIN_CODES.');
});
