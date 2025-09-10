// monitor.js — Render-ready: stealth + mutex nav + reload/scan robustes + webhooks Discord
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';

// puppeteer-core pour executablePath(); puppeteer-extra pour stealth
import puppeteerCore from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

import express from 'express';
puppeteer.use(StealthPlugin());

// -------------------- ENV --------------------
const TRADER_URL          = process.env.TRADER_URL || '';
const DISCORD_WEBHOOK     = process.env.DISCORD_WEBHOOK || '';
const SCAN_EVERY_MS       = process.env.SCAN_EVERY_MS || '7000';   // scan toutes les 7s
const RELOAD_EVERY_MS     = process.env.RELOAD_EVERY_MS || '30000';// reload toutes les 30s
const OPEN_CONFIRM_SCANS  = process.env.OPEN_CONFIRM_SCANS || '1';
const CLOSE_CONFIRM_SCANS = process.env.CLOSE_CONFIRM_SCANS || '3';
const STATE_FILE          = process.env.STATE_FILE || 'state.json';
const PORT                = process.env.PORT || '3000';

console.log('ENV seen:', {
  TRADER_URL: !!TRADER_URL,
  DISCORD_WEBHOOK: !!DISCORD_WEBHOOK,
  SCAN_EVERY_MS,
  RELOAD_EVERY_MS,
  PORT
});

if (!TRADER_URL || !DISCORD_WEBHOOK) {
  console.error('⚠️  TRADER_URL et/ou DISCORD_WEBHOOK manquants. Arrêt.');
  process.exit(1);
}

// -------------------- STATE --------------------
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } }
function saveState(s) { try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} }
// state[orderId] = { seen, missing, openedNotified, closedNotified, symbol, side, lev, avgPrice, openTime }
let state = loadState();

// -------------------- UTILS --------------------
const sideEmoji = (side)=> /long/i.test(side) ? '🟢⬆️' : (/short/i.test(side) ? '🔴⬇️' : 'ℹ️');
async function notifyDiscord(content){
  try {
    await fetch(DISCORD_WEBHOOK, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ content })
    });
  } catch(e){ console.error('Discord error:', e.message); }
}

// -------------------- SELECTEURS (adapter si LBank change) --------------------
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
      const id=(text(tr.querySelector(SEL.orderId))||'').replace(/\s+/g,'');
      if(!id) continue;
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

// -------------------- CHROME PATH --------------------
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
    const p = puppeteerCore.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  const c = findChromeInCache();
  if (c && fs.existsSync(c)) return c;
  return null;
}

// -------------------- HELPERS PAGE --------------------
async function tryAcceptConsent(page) {
  try {
    await page.waitForTimeout(500);
    const candidates = [
      '//button[contains(., "Accepter") or contains(., "Tout accepter")]',
      '//button[contains(translate(., "ACEPT", "acept"), "accept")]',
      '//div[contains(@class,"cookie") or contains(@class,"consent")]//button'
    ];
    for (const xp of candidates) {
      const [btn] = await page.$x(xp);
      if (btn) {
        await btn.click({ delay: 20 });
        await page.waitForTimeout(300);
        break;
      }
    }
  } catch {}
}

async function waitForTable(page) {
  try {
    await page.waitForSelector(SEL.row, { timeout: 90000 });
    return true;
  } catch {
    return false;
  }
}

// -------------------- PUPPETEER MAIN LOOP --------------------
const OPEN_N  = parseInt(OPEN_CONFIRM_SCANS,10);
const CLOSE_N = parseInt(CLOSE_CONFIRM_SCANS,10);

let browser, page, lastReload = 0, lastScanAt = 0;

// --- Mutex de navigation pour éviter collisions scan <-> goto ---
let isNavigating = false;
async function navigate(url) {
  if (!page) return false;
  if (isNavigating) return false;
  isNavigating = true;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await tryAcceptConsent(page);
    try { await page.waitForNetworkIdle({ idleTime: 800, timeout: 10000 }); } catch {}
    const ok = await waitForTable(page);
    lastReload = Date.now();
    return ok;
  } catch (e) {
    console.error('navigate error:', e.message);
    return false;
  } finally {
    isNavigating = false;
  }
}

async function ensureBrowser() {
  if (browser && page) return;

  const exePath = getExecutablePath();
  console.log('DEBUG exePath:', exePath);
  if (!exePath) {
    console.error('❌ Aucun binaire Chrome/Chromium trouvé. postinstall/prestart doivent télécharger Chrome.');
    return;
  }
  console.log('➡️ Using browser at:', exePath);

  const baseArgs = [
    '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
    '--disable-gpu','--no-first-run','--no-default-browser-check',
    '--disable-background-networking','--disable-component-update',
    '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
    '--single-process','--no-zygote','--force-color-profile=srgb','--mute-audio'
  ];

  browser = await puppeteer.launch({
    headless: true,
    executablePath: exePath,
    args: baseArgs,
    protocolTimeout: 120000
  });

  page = await browser.newPage();
  page.setDefaultNavigationTimeout(120000);
  page.setDefaultTimeout(120000);

  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36');

  await page.setRequestInterception(true);
  page.on('request', req => {
    const t = req.resourceType();
    if (t === 'image' || t === 'media' || t === 'font') req.abort();
    else req.continue();
  });

  console.log('🌐 Ouverture', TRADER_URL);
  try {
    const ok = await navigate(TRADER_URL);
    if (ok) await notifyDiscord('🟢 LBank headless watcher démarré.');
  } catch (e) {
    console.error('❌ page.goto error:', e.message);
  }
}

async function reloadSoft() {
  const ok = await navigate(TRADER_URL);
  if (!ok) console.warn('reloadSoft: table non trouvée après navigation.');
}

async function scanCycle(){
  try{
    await ensureBrowser();
    if (!page) return;

    // si nav en cours, on saute ce tour
    if (isNavigating) return;

    // reload périodique
    if (Date.now() - lastReload >= parseInt(RELOAD_EVERY_MS, 10)) {
      await reloadSoft();
      return; // ne scanne pas sur le même tick que le reload
    }

    // si la table a disparu, on recharge
    const tableOk = await page.$(SEL.row);
    if (!tableOk) {
      await reloadSoft();
      return;
    }

    const items = await parseVisibleOrders(page);
    lastScanAt = Date.now();
    const visible = new Set(items.map(o=>o.id));

    // enregistre/actualise les lignes visibles
    for (const d of items) {
      if (!state[d.id]) {
        state[d.id] = {
          seen: 1, missing: 0, openedNotified: false, closedNotified: false,
          symbol: d.symbol, side: d.side, lev: d.lev, avgPrice: d.avgPrice, openTime: d.openTime
        };
      } else {
        const st = state[d.id];
        st.seen = Math.min((st.seen||0)+1, OPEN_N+3);
        st.missing = 0;
        st.symbol = d.symbol || st.symbol;
        st.side = d.side || st.side;
        st.lev = d.lev || st.lev;
        st.avgPrice = d.avgPrice || st.avgPrice;
        st.openTime = d.openTime || st.openTime;
      }
    }

    // notifications d'ouverture
    for (const [id, st] of Object.entries(state)) {
      if (!st.openedNotified && (st.seen||0) >= OPEN_N) {
        const arrow = sideEmoji(st.side);
        const msg =
`${arrow} **Ouverture de position (${st.side||'N/A'})**
• OrderId: **${id}**
${st.symbol?`• Symbole: **${st.symbol}**\n`:''}${st.lev?`• Levier: **${st.lev}x**\n`:''}${st.avgPrice?`• Prix moyen: **${st.avgPrice}**\n`:''}${st.openTime?`• Ouvert: ${st.openTime}\n`:''}• Page: ${TRADER_URL}`;
        await notifyDiscord(msg);
        console.log('📣 Ouverture', id);
        st.openedNotified = true;
      }
    }

    // notifications de fermeture (disparition)
    for (const [id, st] of Object.entries(state)) {
      if (visible.has(id)) continue;
      if (!st.closedNotified && (st.seen||0) >= OPEN_N) {
        st.missing = (st.missing||0) + 1;
        if (st.missing >= parseInt(CLOSE_CONFIRM_SCANS,10)) {
          const arrow = sideEmoji(st.side);
          const msg =
`✅ ${arrow} **Fermeture de position (${st.side||'N/A'})**
• OrderId: **${id}**
${st.symbol?`• Symbole: **${st.symbol}**\n`:''}${st.lev?`• Levier: **${st.lev}x**\n`:''}${st.avgPrice?`• Prix moyen (dernier): **${st.avgPrice}**\n`:''}${st.openTime?`• Ouvert: ${st.openTime}\n`:''}• Page: ${TRADER_URL}`;
          await notifyDiscord(msg);
          console.log('📣 Fermeture', id);
          st.closedNotified = true;
        }
      } else if ((st.seen||0) < OPEN_N) {
        st.missing = (st.missing||0) + 1;
        if (st.missing >= 2) delete state[id];
      }
    }

    saveState(state);
  }catch(e){
    console.error('scan error:', e.message);
  }
}

// -------------------- HTTP (keep-alive + outils) --------------------
const app = express();
app.get('/', (_,res)=>res.send('OK'));
app.get('/health', (_,res)=>res.json({ ok:true, lastScanAt, lastReload, watching:TRADER_URL }));
app.get('/baseline', async (_,res)=>{
  try{
    await ensureBrowser();
    if (!page) return res.json({ ok:false, error:'browser not ready' });
    const items = await parseVisibleOrders(page);
    for(const d of items){
      state[d.id] = {
        seen: Math.max(state[d.id]?.seen||0, parseInt(OPEN_CONFIRM_SCANS,10)),
        missing: 0, openedNotified: true, closedNotified: false,
        symbol:d.symbol, side:d.side, lev:d.lev, avgPrice:d.avgPrice, openTime:d.openTime
      };
    }
    saveState(state);
    res.json({ ok:true, baselineAdded: items.length });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});
app.listen(parseInt(PORT,10), ()=>console.log(`HTTP keep-alive prêt sur : http://localhost:${PORT}/health`));

// -------------------- DEMARRAGE --------------------
(async () => { try { await scanCycle(); } catch (e) { console.error('first scan error:', e.message); } })();
setInterval(scanCycle, parseInt(SCAN_EVERY_MS,10));
