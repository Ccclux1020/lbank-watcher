// monitor.js
import 'dotenv/config';
import fs from 'fs';
import fetch from 'node-fetch';
import puppeteer from 'puppeteer';
import express from 'express';

/**
 * ============ CONFIG via variables d'environnement ============
 * (tu les définiras dans Render → Environment → Environment Variables)
 *
 * TRADER_URL          : URL publique du trader (onglet "Ordres principaux")
 * DISCORD_WEBHOOK     : URL de ton webhook Discord (secret)
 * SCAN_EVERY_MS       : fréquence de scan DOM (ms), ex. "1500"
 * RELOAD_EVERY_MS     : reload périodique de la page (ms), ex. "15000"
 * OPEN_CONFIRM_SCANS  : # de scans pour confirmer une ouverture, ex. "1"
 * CLOSE_CONFIRM_SCANS : # de scans manquants pour confirmer une fermeture, ex. "3"
 * STATE_FILE          : fichier d'état (utile en local; éphémère sur Render), ex. "state.json"
 * PORT                : port HTTP (Render le fournit dans $PORT)
 */

const {
  TRADER_URL,
  DISCORD_WEBHOOK,
  SCAN_EVERY_MS = '1500',
  RELOAD_EVERY_MS = '15000',
  OPEN_CONFIRM_SCANS = '1',
  CLOSE_CONFIRM_SCANS = '3',
  STATE_FILE = 'state.json',
  PORT = '3000'
} = process.env;

if (!TRADER_URL || !DISCORD_WEBHOOK) {
  console.error('⚠️  TRADER_URL et/ou DISCORD_WEBHOOK manquants. Renseigne-les dans les variables d’environnement.');
  process.exit(1);
}

// ----------- State (persistant en local, éphémère sur Render) -----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {}
}
// state = { [orderId]: { seen, missing, openedNotified, closedNotified, symbol, side, lev, avgPrice, openTime } }
let state = loadState();

// ----------- Utilitaires -----------
const sideEmoji = (side) => /long/i.test(side) ? '🟢⬆️' : (/short/i.test(side) ? '🔴⬇️' : 'ℹ️');
async function notifyDiscord(content) {
  try {
    await fetch(DISCORD_WEBHOOK, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ content })
    });
  } catch (e) {
    console.error('Discord error:', e);
  }
}

// Sélecteurs DOM (basés sur l'HTML que tu as fourni)
const SEL = {
  row: 'tr.ant-table-row.ant-table-row-level-0', // chaque ordre
  orderId: 'td:nth-child(9) .data',              // cellule contenant le numéro d'ordre
  firstCell: 'td:nth-child(1)',                  // "SOLUSDT ... Short/Long ... 25x"
  avgPrice: 'td:nth-child(4)',                   // prix moyen (si présent)
  openTs: 'td:nth-child(8)'                      // date/heure d'ouverture (si présent)
};

// Exécuté DANS la page pour récupérer les ordres visibles
async function parseVisibleOrders(page) {
  return await page.evaluate((SEL) => {
    const text = (el) => (el ? (el.innerText || el.textContent || '').trim() : '');
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const rows = Array.from(document.querySelectorAll(SEL.row));
    const out = [];
    for (const tr of rows) {
      const idEl = tr.querySelector(SEL.orderId);
      const id = text(idEl).replace(/\s+/g, '');
      if (!id) continue;

      const c1t = norm(text(tr.querySelector(SEL.firstCell)));
      const symbol = (c1t.match(/[A-Z]{2,}USDT/) || [])[0] || '';
      const side   = /Short/i.test(c1t) ? 'Short' : (/Long/i.test(c1t) ? 'Long' : '');
      const lev    = (c1t.match(/(\d+)\s*x/i) || [,''])[1] || '';

      const avgPrice = text(tr.querySelector(SEL.avgPrice)) || '';
      const openTime = text(tr.querySelector(SEL.openTs)) || '';

      out.push({ id, symbol, side, lev, avgPrice, openTime });
    }
    return out;
  }, SEL);
}

// ----------- Boucle principale Puppeteer -----------
const OPEN_N  = parseInt(OPEN_CONFIRM_SCANS, 10);   // ex. 1
const CLOSE_N = parseInt(CLOSE_CONFIRM_SCANS, 10);  // ex. 3

let browser, page, lastReload = 0, lastScanAt = 0;

async function ensureBrowser() {
  if (browser && page) return;
  browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--lang=fr-FR,fr'
    ]
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 768 });
  await page.setUserAgent(
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36'
  );

  console.log('🌐 Ouverture', TRADER_URL);
  await page.goto(TRADER_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  lastReload = Date.now();
  await notifyDiscord('🟢 LBank headless watcher démarré (keep-alive + reload périodique).');
}

async function scanCycle() {
  try {
    await ensureBrowser();

    // Reload périodique : certaines pages LBank ne “poussent” pas les mises à jour
    if (Date.now() - lastReload >= parseInt(RELOAD_EVERY_MS, 10)) {
      await page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
      lastReload = Date.now();
    }

    const items = await parseVisibleOrders(page);
    lastScanAt = Date.now();

    const visible = new Set(items.map(o => o.id));

    // Mettre à jour l'état pour chaque ligne visible
    for (const d of items) {
      if (!state[d.id]) {
        state[d.id] = {
          seen: 1, missing: 0,
          openedNotified: false, closedNotified: false,
          symbol: d.symbol, side: d.side, lev: d.lev, avgPrice: d.avgPrice, openTime: d.openTime
        };
      } else {
        const st = state[d.id];
        st.seen = Math.min((st.seen || 0) + 1, OPEN_N + 3);
        st.missing = 0;
        st.symbol = d.symbol || st.symbol;
        st.side   = d.side   || st.side;
        st.lev    = d.lev    || st.lev;
        st.avgPrice = d.avgPrice || st.avgPrice;
        st.openTime = d.openTime || st.openTime;
      }
    }

    // ✅ OUVERTURES : une ligne visible confirmée => alerte
    for (const [id, st] of Object.entries(state)) {
      if (!st.openedNotified && (st.seen || 0) >= OPEN_N) {
        const arrow = sideEmoji(st.side);
        const msg =
          `${arrow} **Ouverture de position (${st.side || 'N/A'})**\n` +
          `• OrderId: **${id}**\n` +
          (st.symbol   ? `• Symbole: **${st.symbol}**\n`     : '') +
          (st.lev      ? `• Levier: **${st.lev}x**\n`        : '') +
          (st.avgPrice ? `• Prix moyen: **${st.avgPrice}**\n`: '') +
          (st.openTime ? `• Ouvert: ${st.openTime}\n`        : '') +
          `• Page: ${TRADER_URL}`;
        await notifyDiscord(msg);
        console.log('📣 Ouverture', id);
        st.openedNotified = true;
      }
    }

    // ✅ FERMETURES : ligne confirmée qui disparaît assez longtemps => alerte
    for (const [id, st] of Object.entries(state)) {
      if (visible.has(id)) continue;
      if (!st.closedNotified && (st.seen || 0) >= OPEN_N) {
        st.missing = (st.missing || 0) + 1;
        if (st.missing >= CLOSE_N) {
          const arrow = sideEmoji(st.side);
          const msg =
            `✅ ${arrow} **Fermeture de position (${st.side || 'N/A'})**\n` +
            `• OrderId: **${id}**\n` +
            (st.symbol   ? `• Symbole: **${st.symbol}**\n`     : '') +
            (st.lev      ? `• Levier: **${st.lev}x**\n`        : '') +
            (st.avgPrice ? `• Prix moyen (dernier): **${st.avgPrice}**\n` : '') +
            (st.openTime ? `• Ouvert: ${st.openTime}\n`        : '') +
            `• Page: ${TRADER_URL}`;
          await notifyDiscord(msg);
          console.log('📣 Fermeture', id);
          st.closedNotified = true;
        }
      } else if ((st.seen || 0) < OPEN_N) {
        // jamais confirmé -> on nettoie
        st.missing = (st.missing || 0) + 1;
        if (st.missing >= 2) delete state[id];
      }
    }

    saveState(state);
  } catch (e) {
    console.error('scan error:', e.message);
  }
}

// ----------- Petit serveur HTTP (keep-alive + outils) -----------
const app = express();

// Indique que l'app tourne (UptimeRobot pointera ici)
app.get('/health', (_, res) => {
  res.json({ ok: true, lastScanAt, lastReload, watching: TRADER_URL });
});

// Marque toutes les lignes visibles comme "déjà vues" (évite un flood initial)
app.get('/baseline', async (_, res) => {
  try {
    await ensureBrowser();
    const items = await parseVisibleOrders(page);
    for (const d of items) {
      state[d.id] = {
        seen: Math.max(state[d.id]?.seen || 0, OPEN_N),
        missing: 0,
        openedNotified: true,
        closedNotified: false,
        symbol: d.symbol, side: d.side, lev: d.lev, avgPrice: d.avgPrice, openTime: d.openTime
      };
    }
    saveState(state);
    res.json({ ok: true, baselineAdded: items.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Render impose d'écouter sur process.env.PORT
app.listen(parseInt(PORT, 10), () => {
  console.log(`HTTP keep-alive prêt sur : http://localhost:${PORT}/health`);
});

// ----------- Lancement de la boucle de scan -----------
setInterval(scanCycle, parseInt(SCAN_EVERY_MS, 10));
