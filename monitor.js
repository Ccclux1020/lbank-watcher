// monitor.js — Render-ready: Chrome téléchargé au prestart, lancement robuste + alertes Discord
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import puppeteer from 'puppeteer';
import express from 'express';

/** Variables d'env à définir sur Render (Environment) :
 * TRADER_URL=https://www.lbank.com/fr/copy-trading/lead-trader/LBA8G34235
 * DISCORD_WEBHOOK=<ton webhook Discord>
 * SCAN_EVERY_MS=1500
 * RELOAD_EVERY_MS=15000
 * OPEN_CONFIRM_SCANS=1
 * CLOSE_CONFIRM_SCANS=3
 * STATE_FILE=state.json
 * PORT=10000
 */

const {
  TRADER_URL,
  DISCORD_WEBHOOK,
  SCAN_EVERY_MS = '1500',
  RELOAD_EVERY_MS = '15000',
  OPEN_CONFIRM_SCANS = '1',
  CLOSE_CONFIRM_SCANS = '3',
  STATE_FILE = 'state.json',
  PORT = process.env.PORT || '3000'
} = process.env;

if (!TRADER_URL || !DISCORD_WEBHOOK) {
  console.error('⚠️  TRADER_URL et/ou DISCORD_WEBHOOK manquants.');
  process.exit(1);
}

// --------- State ----------
function loadState(){ try { return JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); } catch { return {}; } }
function saveState(s){ try { fs.writeFileSync(STATE_FILE, JSON.stringify(s,null,2)); } catch {} }
// state[orderId] = { seen, missing, openedNotified, closedNotified, symbol, side, lev, avgPrice, openTime }
let state = loadState();

// --------- Utils ----------
const sideEmoji = (side)=> /long/i.test(side) ? '🟢⬆️' : (/short/i.test(side) ? '🔴⬇️' : 'ℹ️');
async function notifyDiscord(content){
  try { await fetch(DISCORD_WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content})}); }
  catch(e){ console.error('Discord error:', e.message); }
}

// --------- Sélecteurs (selon ton HTML) ----------
const SEL = {
  row: 'tr.ant-table-row.ant-table-row-level-0',
  orderId: 'td:nth-child(9) .data',
  firstCell: 'td:nth-child(1)',
  avgPrice: 'td:nth-child(4)',
  openTs: 'td:nth-child(8)'
};

async function parseVisibleOrders(page){
  return await page.evaluate((SEL)=>{
    const text=(el)=>el?(el.innerText||el.textContent||'').trim():'';
    const norm=(s)=>(s||'').replace(/\s+/g,' ').trim();
    const out=[];
    for(const tr of document.querySelectorAll(SEL.row)){
      const id=(text(tr.querySelector(SEL.orderId))||'').replace(/\s+/g,''); if(!id) continue;
      const c1=norm(text(tr.querySelector(SEL.firstCell)));
      const symbol=(c1.match(/[A-Z]{2,}USDT/)||[])[0]||'';
      const side=/Short/i.test(c1)?'Short':(/Long/i.test(c1)?'Long':'');
      const lev=(c1.match(/(\d+)\s*x/i)||[,''])[1]||'';
      const avgPrice=text(tr.querySelector(SEL.avgPrice))||'';
      const openTime=text(tr.querySelector(SEL.openTs))||'';
      out.push({ id, symbol, side, lev, avgPrice, openTime });
    }
    return out;
  }, SEL);
}

// --------- Fallback: chercher Chrome dans le cache Render ---------
function findChromeInCache() {
  const root = '/opt/render/.cache/puppeteer';
  let found = null;
  function walk(dir, depth = 0) {
    if (found || depth > 7) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name === 'chrome') { found = p; return; }
    }
  }
  walk(root);
  return found;
}

function getExecutablePath() {
  try {
    const p = puppeteer.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  const c = findChromeInCache();
  if (c && fs.existsSync(c)) return c;
  return null;
}

// --------- Puppeteer loop ----------
const OPEN_N  = parseInt(OPEN_CONFIRM_SCANS,10);
const CLOSE_N = parseInt(CLOSE_CONFIRM_SCANS,10);

let browser, page, lastReload=0, lastScanAt=0;

async function ensureBrowser() {
  if (browser && page) return;

  const exePath = getExecutablePath();
  if (!exePath) {
    console.error('❌ Aucun binaire Chrome/Chromium trouvé. Le prestart doit télécharger Chrome.');
    return;
  }
  console.log('➡️ Using browser at:', exePath);

  const baseArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-breakpad',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
    '--disable-hang-monitor',
    '--disable-ipc-flooding-protection',
    '--disable-renderer-backgrounding',
    '--force-color-profile=srgb',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-pings',
    '--single-process',
    '--no-zygote'
  ];

  // Essai 1
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: exePath,
      args: baseArgs,
      protocolTimeout: 60000,
      timeout: 60000
    });
  } catch (e) {
    console.error('⚠️  1er lancement échoué :', e.message);
    // Essai 2
    try {
      browser = await puppeteer.launch({
        headless: true,
        executablePath: exePath,
        args: baseArgs.concat(['--remote-debugging-port=0']),
        protocolTimeout: 90000,
        timeout: 90000
      });
    } catch (e2) {
      console.error('❌ 2e lancement échoué :', e2.message);
      return;
    }
  }

  page = await browser.newPage();

  // Économie de ressources
  try {
    await page.setRequestInterception(true);
    page.on('request', req => {
      const r = req.resourceType();
      if (r === 'image' || r === 'media' || r === 'font') req.abort();
      else req.continue();
    });
  } catch {}

  await page.setViewport({ width: 1200, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36');

  console.log('🌐 Ouverture', TRADER_URL);
  try {
    await page.goto(TRADER_URL, { waitUntil: 'networkidle2', timeout: 60000 });
    lastReload = Date.now();
    await notifyDiscord('🟢 LBank headless watcher démarré (keep-alive + reload périodique).');
  } catch (e) {
    console.error('❌ page.goto error:', e.message);
  }
}

async function scanCycle(){
  try{
    await ensureBrowser();
    if (!page) return;

    if (Date.now()-lastReload >= parseInt(RELOAD_EVERY_MS,10)) {
      await page.reload({ waitUntil:'networkidle2', timeout:60000 });
      lastReload = Date.now();
    }

    const items = await parseVisibleOrders(page);
    lastScanAt = Date.now();
    const visible = new Set(items.map(o=>o.id));

    // Enregistre/actualise les lignes visibles
    for(const d of items){
      if(!state[d.id]){
        state[d.id]={seen:1,missing:0,openedNotified:false,closedNotified:false,
          symbol:d.symbol,side:d.side,lev:d.lev,avgPrice:d.avgPrice,openTime:d.openTime};
      }else{
        const st=state[d.id];
        st.seen=Math.min((st.seen||0)+1, OPEN_N+3);
        st.missing=0;
        st.symbol=d.symbol||st.symbol; st.side=d.side||st.side; st.lev=d.lev||st.lev;
        st.avgPrice=d.avgPrice||st.avgPrice; st.openTime=d.openTime||st.openTime;
      }
    }

    // Ouvertures
    for(const [id,st] of Object.entries(state)){
      if(!st.openedNotified && (st.seen||0) >= OPEN_N){
        const arrow=sideEmoji(st.side);
        const msg =
`${arrow} **Ouverture de position (${st.side||'N/A'})**
• OrderId: **${id}**
${st.symbol?`• Symbole: **${st.symbol}**\n`:''}${st.lev?`• Levier: **${st.lev}x**\n`:''}${st.avgPrice?`• Prix moyen: **${st.avgPrice}**\n`:''}${st.openTime?`• Ouvert: ${st.openTime}\n`:''}• Page: ${TRADER_URL}`;
        await notifyDiscord(msg);
        console.log('📣 Ouverture', id);
        st.openedNotified=true;
      }
    }

    // Fermetures (disparition)
    for(const [id,st] of Object.entries(state)){
      if (visible.has(id)) continue;
      if(!st.closedNotified && (st.seen||0) >= OPEN_N){
        st.missing=(st.missing||0)+1;
        if (st.missing >= CLOSE_N){
          const arrow=sideEmoji(st.side);
          const msg =
`✅ ${arrow} **Fermeture de position (${st.side||'N/A'})**
• OrderId: **${id}**
${st.symbol?`• Symbole: **${st.symbol}**\n`:''}${st.lev?`• Levier: **${st.lev}x**\n`:''}${st.avgPrice?`• Prix moyen (dernier): **${st.avgPrice}**\n`:''}${st.openTime?`• Ouvert: ${st.openTime}\n`:''}• Page: ${TRADER_URL}`;
          await notifyDiscord(msg);
          console.log('📣 Fermeture', id);
          st.closedNotified=true;
        }
      } else if ((st.seen||0) < OPEN_N){
        st.missing=(st.missing||0)+1;
        if (st.missing >= 2) delete state[id];
      }
    }

    saveState(state);
  }catch(e){
    console.error('scan error:', e.message);
  }
}

// --------- HTTP (keep-alive + outils) ----------
const app = express();
app.get('/', (_,res)=>res.send('OK'));
app.get('/health', (_,res)=>res.json({ ok:true, lastScanAt, lastReload, watching:TRADER_URL }));
app.get('/baseline', async (_,res)=>{
  try{
    await ensureBrowser();
    if (!page) return res.json({ ok:false, error:'browser not ready' });
    const items = await parseVisibleOrders(page);
    for(const d of items){
      state[d.id]={seen:Math.max(state[d.id]?.seen||0,OPEN_N),missing:0,
        openedNotified:true,closedNotified:false,
        symbol:d.symbol,side:d.side,lev:d.lev,avgPrice:d.avgPrice,openTime:d.openTime};
    }
    saveState(state);
    res.json({ ok:true, baselineAdded: items.length });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});
app.listen(parseInt(PORT,10), ()=>console.log(`HTTP keep-alive prêt sur : http://localhost:${PORT}/health`));

// ▶️ scan immédiat + intervalle
(async () => { try { await scanCycle(); } catch (e) { console.error('first scan error:', e.message); } })();
setInterval(scanCycle, parseInt(SCAN_EVERY_MS,10));
