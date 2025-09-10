// monitor.js — stealth + mutex + iframes support + endpoints debug + webhooks
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import puppeteerCore from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import express from 'express';
puppeteer.use(StealthPlugin());

// ===== ENV =====
const TRADER_URL          = process.env.TRADER_URL || '';
const DISCORD_WEBHOOK     = process.env.DISCORD_WEBHOOK || '';
const SCAN_EVERY_MS       = parseInt(process.env.SCAN_EVERY_MS || '7000', 10);
const RELOAD_EVERY_MS     = parseInt(process.env.RELOAD_EVERY_MS || '30000', 10);
const OPEN_CONFIRM_SCANS  = parseInt(process.env.OPEN_CONFIRM_SCANS || '1', 10);
const CLOSE_CONFIRM_SCANS = parseInt(process.env.CLOSE_CONFIRM_SCANS || '3', 10);
const STATE_FILE          = process.env.STATE_FILE || 'state.json';
const PORT                = parseInt(process.env.PORT || '3000', 10);

console.log('ENV seen:', { TRADER_URL: !!TRADER_URL, DISCORD_WEBHOOK: !!DISCORD_WEBHOOK, SCAN_EVERY_MS, RELOAD_EVERY_MS, PORT });
if (!TRADER_URL || !DISCORD_WEBHOOK) { console.error('⚠️  TRADER_URL et/ou DISCORD_WEBHOOK manquants.'); process.exit(1); }

// ===== STATE =====
function loadState(){ try { return JSON.parse(fs.readFileSync(STATE_FILE,'utf8')); } catch { return {}; } }
function saveState(s){ try { fs.writeFileSync(STATE_FILE, JSON.stringify(s,null,2)); } catch {} }
let state = loadState();

// ===== UTILS =====
const sideEmoji = s => /long/i.test(s) ? '🟢⬆️' : (/short/i.test(s) ? '🔴⬇️' : 'ℹ️');
async function notifyDiscord(content){
  try { await fetch(DISCORD_WEBHOOK,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content})}); }
  catch(e){ console.error('Discord error:', e.message); }
}

// ===== SELECTEURS (peuvent changer côté LBank) =====
const SEL = {
  row: 'tbody tr.ant-table-row, tr.ant-table-row.ant-table-row-level-0',
  orderIdCandidates: ['td:nth-child(9) .data','td:nth-child(9)','td .data'],
  firstCell: 'td:nth-child(1)',
  avgPrice:  'td:nth-child(4)',
  openTs:    'td:nth-child(8)'
};

// ===== Chrome path (Render) =====
function findChromeInCache() {
  const root = '/opt/render/.cache/puppeteer';
  let found = null;
  function walk(dir, depth=0){
    if (found || depth>7) return;
    let entries=[]; try{ entries=fs.readdirSync(dir,{withFileTypes:true}); } catch { return; }
    for(const e of entries){
      const p = path.join(dir,e.name);
      if (e.isDirectory()) walk(p, depth+1);
      else if (e.name==='chrome'){ found=p; return; }
    }
  }
  walk(root); return found;
}
function getExecutablePath(){
  try{ const p = puppeteerCore.executablePath(); if (p && fs.existsSync(p)) return p; }catch{}
  const c = findChromeInCache(); if (c && fs.existsSync(c)) return c;
  return null;
}

// ===== Helpers page =====
async function tryAcceptConsent(page){
  try{
    await page.waitForTimeout(500);
    const xs = [
      '//button[contains(., "Accepter") or contains(., "Tout accepter")]',
      '//button[contains(translate(., "ACEPT", "acept"), "accept")]',
      '//div[contains(@class,"cookie") or contains(@class,"consent")]//button'
    ];
    for(const xp of xs){
      const [btn] = await page.$x(xp);
      if (btn){ await btn.click({delay:20}); await page.waitForTimeout(300); break; }
    }
  }catch{}
}
async function safeEval(fn, timeoutMs=15000){
  return await Promise.race([
    fn(),
    new Promise((_,reject)=>setTimeout(()=>reject(new Error('eval timeout')), timeoutMs))
  ]);
}

// --- parse dans UN frame donné ---
async function parseOrdersInFrame(frame){
  return await safeEval(() => frame.evaluate((SEL)=>{
    const text=(el)=>el?(el.innerText||el.textContent||'').trim():'';
    const norm=(s)=>(s||'').replace(/\s+/g,' ').trim();
    const out=[];
    const rows = document.querySelectorAll(SEL.row);
    rows.forEach(tr=>{
      let id='';
      for (const sel of SEL.orderIdCandidates){
        const el = tr.querySelector(sel);
        const t  = (el?(el.innerText||el.textContent):'')||'';
        const c  = t.replace(/\s+/g,'').trim();
        if (c){ id=c; break; }
      }
      if(!id){
        const raw = norm(tr.innerText||'');
        if (!raw) return;
        id = 'row_'+raw.slice(0,50).replace(/[^A-Za-z0-9]/g,'_');
      }
      const c1=norm(text(tr.querySelector(SEL.firstCell)));
      const symbol=(c1.match(/[A-Z]{2,}USDT/)||[])[0]||'';
      const side=/Short/i.test(c1)?'Short':(/Long/i.test(c1)?'Long':'');
      const lev=(c1.match(/(\d+)\s*x/i)||[,''])[1]||'';
      const avgPrice=text(tr.querySelector(SEL.avgPrice))||'';
      const openTime=text(tr.querySelector(SEL.openTs))||'';
      out.push({ id, symbol, side, lev, avgPrice, openTime });
    });
    return out;
  }, SEL));
}

// --- parse dans n'importe quel frame (retourne {items, frameUrl}) ---
async function parseVisibleOrders(page){
  const frames = page.frames();
  for (const f of frames){
    try{
      const items = await parseOrdersInFrame(f);
      if (items && items.length){ return { items, frameUrl: f.url() }; }
    }catch{}
  }
  return { items: [], frameUrl: null };
}

// --- attendre la table dans n'importe quel frame ---
async function waitForTableAnyFrame(page, timeoutMs=90000){
  const start = Date.now();
  while(Date.now() - start < timeoutMs){
    const frames = page.frames();
    for (const f of frames){
      try{
        const ok = await f.waitForSelector(SEL.row, { timeout: 1000 });
        if (ok) return true;
      }catch{}
    }
    await page.waitForTimeout(500);
  }
  return false;
}

// ===== Main loop =====
let browser, page, lastReload=0, lastScanAt=0;
let isNavigating=false; // mutex

async function navigate(url){
  if(!page) return false;
  if(isNavigating) return false;
  isNavigating=true;
  try{
    await page.goto(url,{waitUntil:'domcontentloaded', timeout:120000});
    await tryAcceptConsent(page);
    try{ await page.waitForNetworkIdle({idleTime:800, timeout:10000}); }catch{}
    const ok = await waitForTableAnyFrame(page, 90000);
    lastReload = Date.now();
    console.log('Frames:', page.frames().length, '| table any frame:', ok);
    return ok;
  }catch(e){
    console.error('navigate error:', e.message);
    return false;
  }finally{
    isNavigating=false;
  }
}

async function ensureBrowser(){
  if (browser && page) return;
  const exePath = getExecutablePath();
  console.log('DEBUG exePath:', exePath);
  if (!exePath){ console.error('❌ Chrome introuvable.'); return; }

  console.log('➡️ Using browser at:', exePath);
  const baseArgs=[
    '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
    '--disable-gpu','--no-first-run','--no-default-browser-check',
    '--disable-background-networking','--disable-component-update',
    '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
    '--single-process','--no-zygote','--force-color-profile=srgb','--mute-audio'
  ];
  browser = await puppeteer.launch({ headless:true, executablePath:exePath, args:baseArgs, protocolTimeout:180000 });
  page = await browser.newPage();
  page.setDefaultNavigationTimeout(180000);
  page.setDefaultTimeout(180000);
  await page.setViewport({ width: 1280, height: 900 });
  await page.setExtraHTTPHeaders({ 'Accept-Language':'fr-FR,fr;q=0.9,en;q=0.8' });
  await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36');
  await page.setRequestInterception(true);
  page.on('request', req=>{ const t=req.resourceType(); if (t==='image'||t==='media'||t==='font') req.abort(); else req.continue(); });

  console.log('🌐 Ouverture', TRADER_URL);
  const ok = await navigate(TRADER_URL);
  if (ok) await notifyDiscord('🟢 LBank headless watcher démarré.');
}

async function reloadSoft(){
  const ok = await navigate(TRADER_URL);
  if (!ok) console.warn('reloadSoft: table non trouvée après navigation.');
}

async function scanCycle(){
  try{
    await ensureBrowser();
    if (!page) return;

    if (isNavigating) return;
    if (Date.now()-lastReload >= RELOAD_EVERY_MS){ await reloadSoft(); return; }

    const { items, frameUrl } = await parseVisibleOrders(page);
    console.log('Rows visibles:', items.length, '| frame:', frameUrl || 'none');

    lastScanAt = Date.now();
    const visible = new Set(items.map(o=>o.id));

    // maj state
    for(const d of items){
      if(!state[d.id]){
        state[d.id]={seen:1, missing:0, openedNotified:false, closedNotified:false,
          symbol:d.symbol, side:d.side, lev:d.lev, avgPrice:d.avgPrice, openTime:d.openTime};
      }else{
        const st=state[d.id];
        st.seen=Math.min((st.seen||0)+1, OPEN_CONFIRM_SCANS+3);
        st.missing=0;
        st.symbol=d.symbol||st.symbol; st.side=d.side||st.side; st.lev=d.lev||st.lev;
        st.avgPrice=d.avgPrice||st.avgPrice; st.openTime=d.openTime||st.openTime;
      }
    }

    // ouvertures
    for(const [id,st] of Object.entries(state)){
      if(!st.openedNotified && (st.seen||0)>=OPEN_CONFIRM_SCANS){
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

    // fermetures
    for(const [id,st] of Object.entries(state)){
      if (visible.has(id)) continue;
      if(!st.closedNotified && (st.seen||0)>=OPEN_CONFIRM_SCANS){
        st.missing=(st.missing||0)+1;
        if (st.missing>=CLOSE_CONFIRM_SCANS){
          const arrow=sideEmoji(st.side);
          const msg =
`✅ ${arrow} **Fermeture de position (${st.side||'N/A'})**
• OrderId: **${id}**
${st.symbol?`• Symbole: **${st.symbol}**\n`:''}${st.lev?`• Levier: **${st.lev}x**\n`:''}${st.avgPrice?`• Prix moyen (dernier): **${st.avgPrice}**\n`:''}${st.openTime?`• Ouvert: ${st.openTime}\n`:''}• Page: ${TRADER_URL}`;
          await notifyDiscord(msg);
          console.log('📣 Fermeture', id);
          st.closedNotified=true;
        }
      } else if ((st.seen||0)<OPEN_CONFIRM_SCANS){
        st.missing=(st.missing||0)+1;
        if (st.missing>=2) delete state[id];
      }
    }

    saveState(state);
  }catch(e){
    console.error('scan error:', e.message);
  }
}

// ===== HTTP (keep-alive + debug) =====
const app = express();
app.get('/', (_,res)=>res.send('OK'));
app.get('/health', (_,res)=>res.json({ ok:true, lastScanAt, lastReload, watching:TRADER_URL }));

app.get('/baseline', async (_,res)=>{
  try{
    if (isNavigating) return res.json({ ok:false, navigating:true });
    await ensureBrowser(); if (!page) return res.json({ ok:false, error:'browser not ready' });
    const { items } = await parseVisibleOrders(page);
    for(const d of items){
      state[d.id]={ seen: Math.max(state[d.id]?.seen||0, OPEN_CONFIRM_SCANS),
        missing:0, openedNotified:true, closedNotified:false,
        symbol:d.symbol, side:d.side, lev:d.lev, avgPrice:d.avgPrice, openTime:d.openTime };
    }
    saveState(state);
    res.json({ ok:true, baselineAdded: items.length });
  }catch(e){ res.status(500).json({ ok:false, error:e.message }); }
});

app.get('/count', async (_,res)=>{
  try{
    if (isNavigating) return res.json({ ok:false, navigating:true });
    await ensureBrowser(); if (!page) return res.json({ ok:false, error:'browser not ready' });
    const { items } = await parseVisibleOrders(page);
    res.json({ ok:true, rows: items.length });
  }catch(e){ res.json({ ok:false, error:e.message }); }
});

app.get('/html', async (_,res)=>{
  try{
    if (isNavigating) return res.status(409).send('navigating');
    await ensureBrowser(); if (!page) return res.status(503).send('browser not ready');
    const html = await page.content();
    res.type('text/plain').send(html.slice(0, 20000));
  }catch(e){ res.status(500).send(e.message); }
});

app.get('/shot', async (_,res)=>{
  try{
    if (isNavigating) return res.status(409).send('navigating');
    await ensureBrowser(); if (!page) return res.status(503).send('browser not ready');
    const buf = await page.screenshot({ fullPage:true });
    res.type('image/png').send(buf);
  }catch(e){ res.status(500).send(e.message); }
});

app.listen(PORT, ()=>console.log(`HTTP keep-alive prêt sur : http://localhost:${PORT}/health`));

// ===== START =====
(async () => { try { await scanCycle(); } catch (e) { console.error('first scan error:', e.message); } })();
setInterval(scanCycle, SCAN_EVERY_MS);
