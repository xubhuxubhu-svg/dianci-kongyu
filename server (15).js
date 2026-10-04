// 電磁空域 : 生死一線　連線對戰伺服器　遊戲製作：Eric Hu
// 負責：房間號碼、玩家進出、開始對戰、即時位置轉送、勝負結算、文字訊息、語音連線轉送
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(__dirname, { extensions: ['html'] }));
app.get('/health', (req, res) => res.send('ok'));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e6 });

const MAX_PLAYERS = 2;
const rooms = new Map(); // 房號 -> 房間

function newCode() {
  for (let i = 0; i < 200; i++) {
    const c = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  return String(Date.now()).slice(-6);
}
function clean(t, n) { return String(t == null ? '' : t).replace(/[<>]/g, '').trim().slice(0, n); }
function roomView(r) {
  return {
    code: r.code, host: r.host, level: r.level, diff: r.diff, state: r.state,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, plane: p.plane, lr: p.lr, voice: p.voice }))
  };
}
function sendRoom(r) { io.to(r.code).emit('room', roomView(r)); }
function sysMsg(r, text) { io.to(r.code).emit('chat', { name: '系統', text, sys: true, t: Date.now() }); }

function leaveRoom(sock) {
  const code = sock.data.room;
  if (!code) return;
  const r = rooms.get(code);
  sock.leave(code);
  sock.data.room = null;
  if (!r) return;
  const p = r.players.get(sock.id);
  r.players.delete(sock.id);
  if (r.players.size === 0) { rooms.delete(code); return; }
  if (r.host === sock.id) r.host = [...r.players.keys()][0];
  io.to(code).emit('left', { id: sock.id, name: p ? p.name : '' });
  if (r.state !== 'lobby') {
    // 對戰中有人離開：剩下的人直接獲勝
    const winner = [...r.players.keys()][0];
    io.to(code).emit('result', { winner, reason: 'left', players: [...r.players.values()].map(x => ({ id: x.id, name: x.name, res: x.res || null })) });
    r.state = 'lobby';
  }
  for (const x of r.players.values()) { x.lr = false; x.ready = false; x.res = null; }
  if (p) sysMsg(r, p.name + ' 離開了房間');
  sendRoom(r);
}

function finishMatch(r, winner, reason) {
  if (r.state !== 'playing' && r.state !== 'starting') return;
  r.state = 'result';
  io.to(r.code).emit('result', {
    winner, reason,
    players: [...r.players.values()].map(x => ({ id: x.id, name: x.name, plane: x.plane, res: x.res || null }))
  });
}

io.on('connection', (sock) => {
  sock.data.room = null;

  sock.on('create', (d = {}) => {
    leaveRoom(sock);
    const code = newCode();
    const r = { code, host: sock.id, level: 1, diff: 'normal', state: 'lobby', players: new Map() };
    rooms.set(code, r);
    r.players.set(sock.id, { id: sock.id, name: clean(d.name, 12) || '玩家', plane: clean(d.plane, 20), lr: false, ready: false, voice: false, res: null });
    sock.join(code); sock.data.room = code;
    sendRoom(r);
    sysMsg(r, '房間已建立，房號 ' + code);
  });

  sock.on('join', (d = {}) => {
    const code = clean(d.code, 6);
    const r = rooms.get(code);
    if (!r) return sock.emit('err', '找不到房號 ' + code + '，請確認號碼');
    if (r.players.size >= MAX_PLAYERS) return sock.emit('err', '這個房間已經滿了');
    if (r.state !== 'lobby') return sock.emit('err', '這個房間正在對戰中，請稍後再加入');
    leaveRoom(sock);
    const name = clean(d.name, 12) || '玩家';
    r.players.set(sock.id, { id: sock.id, name, plane: clean(d.plane, 20), lr: false, ready: false, voice: false, res: null });
    sock.join(code); sock.data.room = code;
    sendRoom(r);
    sysMsg(r, name + ' 加入了房間');
  });

  sock.on('leave', () => leaveRoom(sock));

  sock.on('cfg', (d = {}) => {
    const r = rooms.get(sock.data.room);
    if (!r || r.host !== sock.id || r.state !== 'lobby') return;
    const lv = Math.max(1, Math.min(30, parseInt(d.level, 10) || 1));
    const df = ['normal', 'medium', 'hard', 'hell'].includes(d.diff) ? d.diff : 'normal';
    r.level = lv; r.diff = df;
    sendRoom(r);
  });

  sock.on('me', (d = {}) => {
    const r = rooms.get(sock.data.room); if (!r) return;
    const p = r.players.get(sock.id); if (!p) return;
    if (d.plane != null) p.plane = clean(d.plane, 20);
    if (d.lr != null) p.lr = !!d.lr;
    if (d.voice != null) p.voice = !!d.voice;
    sendRoom(r);
  });

  sock.on('chat', (d = {}) => {
    const r = rooms.get(sock.data.room); if (!r) return;
    const p = r.players.get(sock.id); if (!p) return;
    const text = clean(d.text, 80); if (!text) return;
    io.to(r.code).emit('chat', { id: sock.id, name: p.name, text, t: Date.now() });
  });

  sock.on('start', () => {
    const r = rooms.get(sock.data.room);
    if (!r || r.host !== sock.id || r.state !== 'lobby') return;
    if (r.players.size < 2) return sock.emit('err', '要等對手加入才能開始');
    if ([...r.players.values()].some(p => !p.lr)) return sock.emit('err', '還有玩家沒按「我準備好了」');
    r.state = 'starting';
    for (const p of r.players.values()) { p.ready = false; p.res = null; }
    io.to(r.code).emit('start', { level: r.level, diff: r.diff });
    sendRoom(r);
  });

  // 校準完成，按下「開始」
  sock.on('ready', () => {
    const r = rooms.get(sock.data.room); if (!r || r.state !== 'starting') return;
    const p = r.players.get(sock.id); if (!p) return;
    p.ready = true;
    if ([...r.players.values()].every(x => x.ready)) {
      r.state = 'playing';
      io.to(r.code).emit('go', { t: Date.now() });
    } else {
      io.to(r.code).emit('waiting', { id: sock.id });
    }
  });

  // 即時位置（每秒十幾次，只轉給對手）
  sock.on('st', (d) => {
    const code = sock.data.room; if (!code) return;
    sock.volatile.to(code).emit('st', { id: sock.id, s: d });
  });

  // 一局結束：抵達終點或出局
  sock.on('done', (d = {}) => {
    const r = rooms.get(sock.data.room); if (!r || r.state !== 'playing') return;
    const p = r.players.get(sock.id); if (!p) return;
    p.res = { fin: !!d.fin, prog: Math.max(0, Math.min(1, +d.prog || 0)), touches: +d.touches || 0, coins: +d.coins || 0, time: +d.time || 0 };
    if (p.res.fin) return finishMatch(r, sock.id, 'finish');      // 先抵達終點的人獲勝
    const all = [...r.players.values()];
    if (all.every(x => x.res)) {                                    // 全部出局：飛得遠的人獲勝
      const best = all.slice().sort((a, b) => b.res.prog - a.res.prog || a.res.touches - b.res.touches);
      const winner = best.length > 1 && Math.abs(best[0].res.prog - best[1].res.prog) < 0.002 ? null : best[0].id;
      finishMatch(r, winner, 'out');
    } else {
      sock.to(r.code).emit('oppOut', { id: sock.id });
    }
  });

  sock.on('back', () => {
    const r = rooms.get(sock.data.room); if (!r) return;
    if (r.state === 'result') { r.state = 'lobby'; for (const p of r.players.values()) { p.lr = false; p.ready = false; p.res = null; } }
    sendRoom(r);
  });

  // 語音：轉送 WebRTC 連線資料
  sock.on('rtc', (d = {}) => {
    if (!d.to) return;
    const r = rooms.get(sock.data.room); if (!r || !r.players.has(d.to)) return;
    io.to(d.to).emit('rtc', { from: sock.id, data: d.data });
  });
  sock.on('rtc-renew', () => { const code = sock.data.room; if (code) sock.to(code).emit('rtc-renew', { from: sock.id }); });

  sock.on('disconnect', () => leaveRoom(sock));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('電磁空域伺服器啟動，連接埠 ' + PORT));
