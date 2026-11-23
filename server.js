'use strict';
// Позор Squad: текстовые и голосовые каналы, роли, звонки.
// Realtime: Server-Sent Events (сервер -> клиент). Действия: обычные POST (клиент -> сервер).
// WebRTC: сервер только передаёт сигналы между участниками одного голосового канала.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;
const ACCESS_CODE = (process.env.ACCESS_CODE || '').trim();
const PUBLIC_DIR = path.join(__dirname, 'public');
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

const roles = [];          // { id, name, color }
const memberRoles = {};    // имя участника -> [id ролей]
const clients = new Map(); // id -> { id, name, res, timer, voiceCh }
const voice = new Map();   // id голосового канала -> Set(id клиентов)

function uid() { return crypto.randomUUID(); }
function cleanName(s, max) { return String(s || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max); }
function slug(s) { return cleanName(s, 24).replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-'); }
function findChannel(id) { return channels.find(c => c.id === id) || null; }

function send(res, event, data) {
  if (!res || res.writableEnded) return;
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}
function broadcast(event, data) {
  for (const c of clients.values()) send(c.res, event, data);
}

function roleList(name) {
  return (memberRoles[name] || []).map(id => roles.find(r => r.id === id)).filter(Boolean);
}
function memberView(c) { return { id: c.id, name: c.name, roles: roleList(c.name) }; }
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

function checkCode(url) {
  return !ACCESS_CODE || url.searchParams.get('code') === ACCESS_CODE;
}

function getClient(id) {
  const c = clients.get(id);
  return c && c.res ? c : null;
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

  if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

  if (p === '/' || p === '/index.html') {
    return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); return res.end('no index'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  }

  if (p === '/api/config' && req.method === 'GET') {
    return json(res, 200, { needsCode: !!ACCESS_CODE, reactions: REACTIONS });
  }

  // Всё ниже требует код доступа, если он задан.
  if (!checkCode(url)) return json(res, 403, { error: 'Неверный код доступа' });

  if (p === '/api/check' && req.method === 'GET') {
    return json(res, 200, { ok: true });
  }

  if (p === '/events' && req.method === 'GET') {
    const rawId = url.searchParams.get('id') || '';
    const id = /^[A-Za-z0-9-]{8,64}$/.test(rawId) ? rawId : uid();
    const name = cleanName(url.searchParams.get('name'), 20);
    if (!name) return json(res, 400, { error: 'Нужен ник' });

    let c = clients.get(id);
    if (c) {
      clearTimeout(c.timer);
      if (c.res && !c.res.writableEnded) c.res.end();   // старое соединение уступает новому
    } else {
      c = { id, name, res: null, timer: null, voiceCh: null };
      clients.set(id, c);
    }
    c.name = name;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    c.res = res;

    send(res, 'hello', {
      id,
      channels,
      roles,
      members: onlineMembers(),
      voice: voiceView(),
      myVoice: c.voiceCh,
    });
    broadcastPresence();

    req.on('close', () => {
      if (c.res !== res) return;   // соединение уже заменено новым
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
      if (msg.author !== me.name) return json(res, 403, { error: 'Можно удалять только свои' });
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
      const name = cleanName(body.name, 20);
      const color = /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : '#99aab5';
      if (!name) return json(res, 400, { error: 'Нужно название роли' });
      if (roles.length >= MAX_ROLES) return json(res, 400, { error: 'Слишком много ролей' });
      roles.push({ id: uid(), name, color });
      broadcastRoles();
      return json(res, 200, { ok: true });
    }

    if (p === '/api/role/delete') {
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
      const name = cleanName(body.member, 20);
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

    return json(res, 404, { error: 'Not found' });
  });
});

server.listen(PORT, () => {
  console.log('Позор Squad запущен на порту ' + PORT + (ACCESS_CODE ? ' (код доступа включён)' : ' (без кода доступа)'));
});
