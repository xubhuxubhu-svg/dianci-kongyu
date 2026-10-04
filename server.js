// 電磁空域 : 生死一線　連線對戰伺服器　遊戲製作：Eric Hu
// 負責：雲端存檔（帳號、過關進度）、房間號碼、玩家進出、開始對戰、即時位置轉送、勝負結算、文字訊息、語音連線轉送
// 雲端存檔需要在 Render 設定環境變數 DATABASE_URL（可以和其他遊戲共用同一個資料庫，資料表名稱以 dk_ 開頭，不會互相影響）
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const crypto = require('crypto');

function clean(t, n) { return String(t == null ? '' : t).replace(/[<>]/g, '').trim().slice(0, n); }

const app = express();
app.use(express.static(__dirname, { extensions: ['html'] }));
app.get('/health', (req, res) => res.send('ok'));
app.use(express.json({ limit: '200kb' }));

/* ================= 雲端存檔 ================= */
let pool = null;
if (process.env.DATABASE_URL) {
  const { Pool } = require('pg');
  const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false }, max: 5 });
  pool.query(`create table if not exists dk_players(
      id serial primary key, name text unique not null, salt text not null, hash text not null,
      data jsonb not null default '{}'::jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
    create table if not exists dk_sessions(
      token text primary key, player_id int references dk_players(id) on delete cascade, created_at timestamptz default now());`)
    .then(() => console.log('雲端存檔資料庫就緒'))
    .catch(e => console.error('資料庫連線失敗：', e.message));
} else {
  console.log('沒有設定 DATABASE_URL：雲端存檔關閉，進度只會存在玩家自己的瀏覽器');
}
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
function needDb(res) { if (!pool) { res.status(503).json({ err: '伺服器還沒設定資料庫，進度暫時只存在這台裝置' }); return true; } return false; }
async function newSession(pid) { const token = crypto.randomBytes(24).toString('hex'); await pool.query('insert into dk_sessions(token,player_id) values($1,$2)', [token, pid]); return token; }
async function who(req) {
  const t = String(req.headers['x-token'] || '').slice(0, 80); if (!t) return null;
  const r = await pool.query('select p.id,p.name,p.data from dk_sessions s join dk_players p on p.id=s.player_id where s.token=$1', [t]);
  return r.rows[0] || null;
}
function cleanData(d) { try { const j = JSON.stringify(d || {}); return j.length < 100000 ? JSON.parse(j) : {}; } catch (e) { return {}; } }
const tries = new Map(); // 簡單防止一直猜密碼
function tooMany(req) { const ip = req.headers['x-forwarded-for'] || req.ip; const now = Date.now(); const a = (tries.get(ip) || []).filter(t => now - t < 60000); a.push(now); tries.set(ip, a); return a.length > 20; }

app.post('/api/register', async (req, res) => {
  if (needDb(res)) return; if (tooMany(req)) return res.status(429).json({ err: '嘗試太多次，請一分鐘後再試' });
  const name = clean(req.body.name, 12), pw = String(req.body.pass || '');
  if (!name || pw.length < 4) return res.status(400).json({ err: '名字至少 1 個字，密碼至少 4 個字' });
  const salt = crypto.randomBytes(12).toString('hex'), data = cleanData(req.body.data);
  try {
    const r = await pool.query('insert into dk_players(name,salt,hash,data) values($1,$2,$3,$4) returning id', [name, salt, hashPw(pw, salt), data]);
    res.json({ token: await newSession(r.rows[0].id), name, data });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ err: '這個名字已經有人用了。如果是你的帳號，請改按「登入」' });
    console.error(e.message); res.status(500).json({ err: '註冊失敗，請稍後再試' });
  }
});
app.post('/api/login', async (req, res) => {
  if (needDb(res)) return; if (tooMany(req)) return res.status(429).json({ err: '嘗試太多次，請一分鐘後再試' });
  const name = clean(req.body.name, 12), pw = String(req.body.pass || '');
  try {
    const r = await pool.query('select id,salt,hash,data from dk_players where name=$1', [name]);
    const p = r.rows[0];
    if (!p || !crypto.timingSafeEqual(Buffer.from(hashPw(pw, p.salt), 'hex'), Buffer.from(p.hash, 'hex'))) return res.status(401).json({ err: '名字或密碼不對' });
    res.json({ token: await newSession(p.id), name, data: p.data });
  } catch (e) { console.error(e.message); res.status(500).json({ err: '登入失敗，請稍後再試' }); }
});
app.get('/api/me', async (req, res) => {
  if (needDb(res)) return;
  try { const p = await who(req); if (!p) return res.status(401).json({ err: '登入已過期，請重新登入' }); res.json({ name: p.name, data: p.data }); }
  catch (e) { res.status(500).json({ err: '讀取存檔失敗' }); }
});
app.post('/api/save', async (req, res) => {
  if (needDb(res)) return;
  try { const p = await who(req); if (!p) return res.status(401).json({ err: '登入已過期，請重新登入' });
    await pool.query('update dk_players set data=$1, updated_at=now() where id=$2', [cleanData(req.body.data), p.id]); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ err: '存檔失敗' }); }
});
// 排行榜：不帶關卡是總排行（星星總數→過關數→收集星星），帶 level 是該關最快通關時間
app.get('/api/rank', async (req, res) => {
  if (needDb(res)) return;
  try {
    const me = await who(req);
    const r = await pool.query('select name,data from dk_players order by updated_at desc limit 5000');
    const lv = parseInt(req.query.level, 10);
    let rows;
    if (lv >= 1 && lv <= 30) {
      rows = r.rows.map(x => { const b = x.data && x.data.best && x.data.best[lv]; return b && +b.t > 0 ? { name: x.name, t: +b.t, c: +b.c || 0, d: b.d || '', s: +((x.data.stars || {})[lv]) || 0 } : null; })
        .filter(Boolean).sort((a, b) => a.t - b.t);
    } else {
      rows = r.rows.map(x => {
        const st = (x.data && x.data.stars) || {}, bb = (x.data && x.data.best) || {}; let s = 0, n = 0, c = 0;
        for (const k in st) { const v = +st[k] || 0; if (v > 0) { s += v; n++; } }
        for (const k in bb) c += +bb[k].c || 0;
        return { name: x.name, s, n, c };
      }).filter(x => x.n > 0).sort((a, b) => b.s - a.s || b.n - a.n || b.c - a.c);
    }
    const i = me ? rows.findIndex(x => x.name === me.name) : -1;
    res.json({ rows: rows.slice(0, 50), me: i >= 0 ? Object.assign({ rank: i + 1 }, rows[i]) : null, total: rows.length });
  } catch (e) { console.error(e.message); res.status(500).json({ err: '讀取排行榜失敗' }); }
});

app.post('/api/logout', async (req, res) => {
  if (needDb(res)) return;
  try { await pool.query('delete from dk_sessions where token=$1', [String(req.headers['x-token'] || '')]); } catch (e) {}
  res.json({ ok: true });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 1e6 });

// ==ROOMHUB-BEGIN==
/* ===== 房間邏輯（伺服器與單機電腦對戰共用）===== */
function RoomHub(send){
  // send(玩家id, 事件, 資料, 可丟棄)
  const rooms=new Map(),where=new Map(),MAXP=4,END_WAIT=40000;
  const clean=(s,n)=>String(s==null?'':s).replace(/[<>]/g,'').trim().slice(0,n);
  const LVN={easy:'簡單',normal:'普通',hard:'困難'};
  const PL=['pink_cat','blue_cat','camo_bear','green_cat','yellow_dog'];
  const list=r=>[...r.players.values()];
  const humans=r=>list(r).filter(p=>!p.ai);
  const toRoom=(r,ev,d,except,vol)=>{for(const p of humans(r))if(p.id!==except)send(p.id,ev,d,vol)};
  function newCode(){for(let i=0;i<300;i++){const c=String(Math.floor(1000+Math.random()*9000));if(!rooms.has(c))return c}return String(Date.now()).slice(-6)}
  function view(r){return {code:r.code,host:r.host,level:r.level,diff:r.diff,state:r.state,
    players:list(r).map(p=>({id:p.id,name:p.name,plane:p.plane,lr:p.lr,voice:!!p.voice,ai:!!p.ai,lvl:p.lvl||''}))}}
  const sendRoom=r=>toRoom(r,'room',view(r));
  const sys=(r,text)=>toRoom(r,'chat',{name:'系統',text,sys:true,t:Date.now()});
  function rankAll(r){
    const a=list(r);
    a.sort((x,y)=>{const fx=x.res&&x.res.fin,fy=y.res&&y.res.fin;
      if(fx&&fy)return x.finOrder-y.finOrder;if(fx)return -1;if(fy)return 1;
      return ((y.res&&y.res.prog)||0)-((x.res&&x.res.prog)||0)||((x.res&&+x.res.touches)||0)-((y.res&&+y.res.touches)||0)});
    a.forEach((p,i)=>p.rank=i+1);return a;
  }
  function resView(r){const a=rankAll(r);
    return {reason:r.reason,winner:a[0]?a[0].id:null,players:a.map(p=>({id:p.id,name:p.name,plane:p.plane,ai:!!p.ai,res:p.res||null,rank:p.rank,rm:!!p.rm}))}}
  function closeMatch(r,reason){
    if(r.state!=='playing')return;
    clearTimeout(r.endT);r.state='result';r.reason=reason;r.pend=null;r.resultAt=Date.now();
    for(const p of list(r)){if(!p.res)p.res={fin:false,prog:p.lastProg||0,touches:'',coins:'',live:true};p.rm=!!p.ai}
    toRoom(r,'result',resView(r));
  }
  function checkEnd(r){
    const a=list(r),act=a.filter(p=>!p.res).length,fin=a.filter(p=>p.res&&p.res.fin).length;
    if(act===0)closeMatch(r,fin?'finish':'out');
  }
  const mkRes=d=>({fin:!!d.fin,prog:Math.max(0,Math.min(1,+d.prog||0)),touches:+d.touches||0,coins:+d.coins||0,time:+d.time||0});
  function done(r,p,d){
    if(r.state==='result'){ // 結算後才送到（幾乎同時抵達）：補上成績
      if(p.res&&p.res.live&&Date.now()-r.resultAt<15000){p.res=mkRes(d);if(p.res.fin)p.finOrder=++r.finN;toRoom(r,'result',resView(r))}
      return;
    }
    if(r.state!=='playing'||p.res)return;
    p.res=mkRes(d);
    if(p.res.fin){p.finOrder=++r.finN;toRoom(r,'rank',{id:p.id,rank:p.finOrder});
      if(r.finN===1&&list(r).some(x=>!x.res)){r.endT=setTimeout(()=>closeMatch(r,'finish'),END_WAIT);toRoom(r,'endIn',{ms:END_WAIT})}}
    else toRoom(r,'rank',{id:p.id,out:true,prog:p.res.prog});
    checkEnd(r);
  }
  function aiName(r,lvl){let n=1;const used=new Set(list(r).map(p=>p.name));while(used.has('電腦'+n+'・'+LVN[lvl]))n++;return '電腦'+n+'・'+LVN[lvl]}
  function aiPlane(r){const used=new Set(list(r).map(p=>p.plane));const free=PL.filter(x=>!used.has(x));const a=free.length?free:PL;return a[Math.floor(Math.random()*a.length)]}
  function leave(id){
    const code=where.get(id);if(!code)return;where.delete(id);
    const r=rooms.get(code);if(!r)return;
    const p=r.players.get(id);r.players.delete(id);
    if(!humans(r).length){clearTimeout(r.endT);rooms.delete(code);return}
    const wasHost=r.host===id;if(wasHost)r.host=humans(r)[0].id;
    toRoom(r,'left',{id,name:p?p.name:''});
    if(p)sys(r,p.name+' 離開了房間');
    if(r.state==='playing'){
      if(wasHost)for(const x of list(r))if(x.ai&&!x.res){x.res={fin:false,prog:x.lastProg||0,touches:'',coins:''};toRoom(r,'rank',{id:x.id,out:true,prog:x.res.prog})}
      checkEnd(r);
    }else if(r.state==='starting'){
      r.state='lobby';for(const x of humans(r)){x.lr=false;x.ready=false}
      toRoom(r,'abort',{name:p?p.name:''});
    }else if(r.state==='result'){toRoom(r,'rematchState',{ids:humans(r).filter(x=>x.rm).map(x=>x.id),pend:r.pend})}
    if(r.state==='lobby')for(const x of humans(r))x.lr=false;
    sendRoom(r);
  }
  function startMatch(r,again){
    r.state='starting';r.finN=0;clearTimeout(r.endT);
    for(const x of list(r)){x.ready=!!x.ai;x.res=null;x.rm=false;x.finOrder=0;x.lastProg=0;x.rank=0}
    toRoom(r,'start',{level:r.level,diff:r.diff,again:!!again,ids:list(r).map(p=>p.id)});
    sendRoom(r);
  }
  function handle(id,ev,d){
    d=d&&typeof d==='object'?d:{};
    const r=rooms.get(where.get(id)),p=r&&r.players.get(id);
    switch(ev){
    case 'create':{
      leave(id);const code=newCode();
      const nr={code,host:id,level:1,diff:'normal',state:'lobby',players:new Map(),finN:0};rooms.set(code,nr);
      nr.players.set(id,{id,name:clean(d.name,12)||'玩家',plane:clean(d.plane,20),lr:false,ready:false,voice:false,res:null});
      where.set(id,code);sendRoom(nr);sys(nr,d.local?'電腦對戰房間已建立，可以加入 1～3 位電腦玩家':'房間已建立，房號 '+code);return}
    case 'join':{
      const code=clean(d.code,6),jr=rooms.get(code);
      if(!jr)return send(id,'err','找不到房號 '+code+'，請確認號碼');
      if(jr.players.size>=MAXP)return send(id,'err','這個房間已經滿了（最多 4 人）');
      if(jr.state!=='lobby')return send(id,'err','這個房間正在對戰中，請稍後再加入');
      leave(id);const name=clean(d.name,12)||'玩家';
      jr.players.set(id,{id,name,plane:clean(d.plane,20),lr:false,ready:false,voice:false,res:null});
      where.set(id,code);sendRoom(jr);sys(jr,name+' 加入了房間');return}
    case 'leave':return leave(id);
    }
    if(!r||!p)return;
    switch(ev){
    case 'cfg':{
      if(r.host!==id||r.state!=='lobby')return;
      r.level=Math.max(1,Math.min(30,parseInt(d.level,10)||1));
      r.diff=['normal','medium','hard','hell'].includes(d.diff)?d.diff:'normal';sendRoom(r);return}
    case 'addAi':{
      if(r.host!==id||r.state!=='lobby')return;
      if(r.players.size>=MAXP)return send(id,'err','房間已經滿了（最多 4 人）');
      const lvl=LVN[d.lvl]?d.lvl:'normal',aid='ai'+Math.random().toString(36).slice(2,8);
      r.players.set(aid,{id:aid,ai:true,lvl,name:aiName(r,lvl),plane:aiPlane(r),lr:true,ready:true,res:null});
      sendRoom(r);return}
    case 'delAi':{
      if(r.host!==id||r.state!=='lobby')return;const a=r.players.get(d.id);if(a&&a.ai)r.players.delete(d.id);sendRoom(r);return}
    case 'me':
      if(d.plane!=null)p.plane=clean(d.plane,20);if(d.lr!=null)p.lr=!!d.lr;if(d.voice!=null)p.voice=!!d.voice;sendRoom(r);return;
    case 'chat':{const text=clean(d.text,80);if(text)toRoom(r,'chat',{id,name:p.name,text,t:Date.now()});return}
    case 'start':
      if(r.host!==id||r.state!=='lobby')return;
      if(r.players.size<2)return send(id,'err','至少要 2 位玩家（可以加入電腦玩家）');
      if(humans(r).some(x=>!x.lr))return send(id,'err','還有玩家沒按「我準備好了」');
      return startMatch(r,false);
    case 'ready':
      if(r.state!=='starting')return;p.ready=true;
      if(list(r).every(x=>x.ready)){r.state='playing';toRoom(r,'go',{t:Date.now()})}else toRoom(r,'waiting',{id});return;
    case 'st':{
      let who=p;if(d.ai){const a=r.players.get(d.ai);if(!a||!a.ai||r.host!==id)return;who=a}
      const s=d.s||d;if(s&&+s.len>0)who.lastProg=Math.max(0,Math.min(1,(+s.c||0)/+s.len));
      toRoom(r,'st',{id:who.id,s},id,true);return}
    case 'done':{
      let who=p;if(d.ai){const a=r.players.get(d.ai);if(!a||!a.ai||r.host!==id)return;who=a}
      return done(r,who,d)}
    case 'rematch':{  // 再來一局（同一關）或下一關：大家都同意同一個選擇就開始
      if(r.state!=='result')return;
      const want=d.next&&r.level<30?'next':'same';
      if(r.pend!==want){r.pend=want;for(const x of humans(r))x.rm=false}
      p.rm=true;
      if(list(r).length>=2&&list(r).every(x=>x.rm)){if(r.pend==='next')r.level=Math.min(30,r.level+1);r.pend=null;startMatch(r,true)}
      else toRoom(r,'rematchState',{ids:humans(r).filter(x=>x.rm).map(x=>x.id),pend:r.pend,by:p.name});
      return}
    case 'back':
      if(r.state==='result'){r.state='lobby';for(const x of humans(r)){x.lr=false;x.ready=false;x.res=null;x.rm=false}}
      sendRoom(r);return;
    case 'rtc':if(d.to&&r.players.has(d.to))send(d.to,'rtc',{from:id,data:d.data});return;
    case 'rtc-renew':toRoom(r,'rtc-renew',{from:id},id);return;
    }
  }
  return {handle,leave,rooms};
}
// ==ROOMHUB-END==
const hub = RoomHub((id, ev, data, vol) => (vol ? io.volatile : io).to(id).emit(ev, data));
const EVENTS = new Set(['create','join','leave','cfg','addAi','delAi','me','chat','start','ready','st','done','rematch','back','rtc','rtc-renew']);
io.on('connection', (sock) => {
  sock.onAny((ev, d) => { if (EVENTS.has(ev)) { try { hub.handle(sock.id, ev, d); } catch (e) { console.error('房間錯誤', e.message); } } });
  sock.on('disconnect', () => hub.leave(sock.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('電磁空域伺服器啟動，連接埠 ' + PORT));
