// monitor.js — Render-ready + stealth + consent + navigation robuste
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import puppeteerCore from 'puppeteer';               // pour executablePath()
import puppeteer from 'puppeteer-extra';             // ★
import StealthPlugin from 'puppeteer-extra-plugin-stealth'; // ★
import express from 'express';

puppeteer.use(StealthPlugin()); // ★

// ... (vars d’env inchangées)

if (!TRADER_URL || !DISCORD_WEBHOOK) {
  console.error('⚠️  TRADER_URL et/ou DISCORD_WEBHOOK manquants.');
  process.exit(1);
}

// ---------- state / utils identiques ----------

// ---------- sélecteurs (à ajuster si LBank bouge) ----------
const SEL = {
  row: 'tr.ant-table-row.ant-table-row-level-0',
  orderId: 'td:nth-child(9) .data',
  firstCell: 'td:nth-child(1)',
  avgPrice: 'td:nth-child(4)',
  openTs: 'td:nth-child(8)'
};

// ---------- chrome path ----------
function findChromeInCache() { /* identique */ }
function getExecutablePath() {
  try {
    const p = puppeteerCore.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  const c = findChromeInCache();
  if (c && fs.existsSync(c)) return c;
  return null;
}

// ---------- helpers page ----------
async function tryAcceptConsent(page) {               // ★ bandeau cookies probable
  try {
    await page.waitForTimeout(500);
    // boutons fréquents (FR/EN)
    const candidates = [
      '//button[contains(., "Accepter") or contains(., "Tout accepter")]',
      '//button[contains(., "Accept") and contains(., "all")]',
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

async function waitForTable(page) {                   // ★ on attend le contenu utile
  try {
    await page.waitForSelector(SEL.row, { timeout: 90000 });
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- boucle Puppeteer ----------
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
    '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
    '--disable-gpu','--no-first-run','--no-default-browser-check',
    '--disable-background-networking','--disable-component-update',
    '--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process',
    '--single-process','--no-zygote'
  ];

  // Lancement (timeouts plus larges) ★
  browser = await puppeteer.launch({
    headless: true,
    executablePath: exePath,
    args: baseArgs,
    protocolTimeout: 120000
  });

  page = await browser.newPage();
  page.setDefaultNavigationTimeout(120000);          // ★
  page.setDefaultTimeout(120000);                    // ★

  // langue + UA ★
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' });
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36'
  );

  // N’intercepte que les images (on garde scripts) ★
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (req.resourceType() === 'image' || req.resourceType() === 'media' || req.resourceType() === 'font') req.abort();
    else req.continue();
  });

  console.log('🌐 Ouverture', TRADER_URL);
  try {
    // ⚠️ ne PAS attendre networkidle2 (bloque souvent) ★
    await page.goto(TRADER_URL, { waitUntil: 'domcontentloaded' });
    await tryAcceptConsent(page);                    // ★
    await waitForTable(page);                        // ★ on laisse la table apparaître
    lastReload = Date.now();
  } catch (e) {
    console.error('❌ page.goto error (domcontentloaded):', e.message);
  }

  await notifyDiscord('🟢 LBank watcher démarré.');
}

async function reloadSoft() {                         // ★ reload robuste
  try {
    await page.goto(TRADER_URL, { waitUntil: 'domcontentloaded' });
    await tryAcceptConsent(page);
    await waitForTable(page);
    lastReload = Date.now();
  } catch (e) {
    console.error('reload error:', e.message);
  }
}

async function parseVisibleOrders(page){
  return await page.evaluate((SEL)=>{
    const text=(el)=>el?(el.innerText||el.textContent||'').trim():'';
    const norm=(s)=>(s||'').replace(/\s+/g,' ').trim();
    const out=[];
    document.querySelectorAll(SEL.row).forEach(tr=>{
      const id=(text(tr.querySelector(SEL.orderId))||'').replace(/\s+/g,''); if(!id) return;
      const c1=norm(text(tr.querySelector(SEL.firstCell)));
      const symbol=(c1.match(/[A-Z]{2,}USDT/)||[])[0]||'';
      const side=/Short/i.test(c1)?'Short':(/Long/i.test(c1)?'Long':'');
      const lev=(c1.match(/(\d+)\s*x/i)||[,''])[1]||'';
      const avgPrice=text(tr.querySelector(SEL.avgPrice))||'';
      const openTime=text(tr.querySelector(SEL.openTs))||'';
      out.push({ id, symbol, side, lev, avgPrice, openTime });
    });
    return out;
  }, SEL);
}

async function scanCycle(){
  try{
    await ensureBrowser();
    if (!page) return;

    if (Date.now()-lastReload >= parseInt(RELOAD_EVERY_MS,10)) {
      await reloadSoft();                            // ★
    }

    // Si la table n’est pas visible, on tente un refresh ciblé ★
    const tableOk = await page.$(SEL.row);
    if (!tableOk) {
      await reloadSoft();
    }

    const items = await parseVisibleOrders(page);
    lastScanAt = Date.now();
    const visible = new Set(items.map(o=>o.id));

    // ---- logique state & notifications (inchangée) ----
    // ... (tout ton code d’origine ici, identique)
    // ---------------------------------------------------

    saveState(state);
  }catch(e){
    console.error('scan error:', e.message);
  }
}

// HTTP keep-alive identique (/, /health, /baseline) …
// Lancement & setInterval identiques …
