// backtest.js — compare patterns d entree timeframe sur vrais tokens Pump.fun
// Usage : node backtest.js           (telecharge + simule)
//         node backtest.js --cached  (reutilise le cache)
if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const fs = require('fs');

const SOL_PRICE    = parseFloat(process.env.SOL_PRICE || '170');
const TOTAL_SUPPLY = 1_000_000_000;
const MISE_USD     = 300;
const CACHE_FILE   = './backtest_cache.json';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Origin': 'https://pump.fun',
  'Referer': 'https://pump.fun/',
};

// ─── CONFIGS A COMPARER ───────────────────────────────────────────────────────
// pattern : direct | pullback | hammer | breakout | trend_up
//           higher_low | consolidation | ema_cross | support_bounce  (swing)
const CONFIGS = [
  // ── SCALPING : Zone $9k-$11k ──
  {
    id: 'A_DIRECT',    label: '$9k-$11k   entree directe (baseline)',
    entry: 9000,  maxE: 11000,  tpLevels: [20, 50, 100],  sl: 20, maxMin: 15,
    pattern: 'direct',
  },
  {
    id: 'B_PULLBACK',  label: '$9k-$11k   pullback -5% + rebond    ',
    entry: 9000,  maxE: 11000,  tpLevels: [20, 50, 100],  sl: 20, maxMin: 15,
    pattern: 'pullback', pullbackPct: 5,
  },
  {
    id: 'C_HAMMER',    label: '$9k-$11k   bougie hammer             ',
    entry: 9000,  maxE: 11000,  tpLevels: [20, 50, 100],  sl: 20, maxMin: 15,
    pattern: 'hammer',
  },
  {
    id: 'D_BREAKOUT',  label: '$9k-$11k   breakout 3 bougies        ',
    entry: 9000,  maxE: 11000,  tpLevels: [20, 50, 100],  sl: 20, maxMin: 15,
    pattern: 'breakout',
  },
  {
    id: 'E_TREND',     label: '$9k-$11k   2 bougies vertes           ',
    entry: 9000,  maxE: 11000,  tpLevels: [20, 50, 100],  sl: 20, maxMin: 15,
    pattern: 'trend_up',
  },
  // ── SCALPING : Zone mature $15k-$60k ──
  {
    id: 'F_MAT_DIR',   label: '$15k-$60k  entree directe             ',
    entry: 15000, maxE: 60000,  tpLevels: [30, 60, 120],  sl: 15, maxMin: 20,
    pattern: 'direct',
  },
  {
    id: 'G_MAT_PULL',  label: '$15k-$60k  pullback -8% + rebond      ',
    entry: 15000, maxE: 60000,  tpLevels: [30, 60, 120],  sl: 15, maxMin: 20,
    pattern: 'pullback', pullbackPct: 8,
  },
  {
    id: 'H_MAT_BRK',   label: '$15k-$60k  breakout 3 bougies         ',
    entry: 15000, maxE: 60000,  tpLevels: [30, 60, 120],  sl: 15, maxMin: 20,
    pattern: 'breakout',
  },
  // ── SWING TRADING : hold 30-60 min, TP larges ──
  {
    id: 'I_SW_HIGHERLOW', label: 'SWING   higher lows consecutifs    ',
    entry: 9000,  maxE: 60000,  tpLevels: [50, 100, 200], sl: 20, maxMin: 60,
    pattern: 'higher_low',
  },
  {
    id: 'J_SW_CONSOL',    label: 'SWING   consolidation breakout      ',
    entry: 9000,  maxE: 60000,  tpLevels: [50, 100, 200], sl: 20, maxMin: 60,
    pattern: 'consolidation',
  },
  {
    id: 'K_SW_EMA',       label: 'SWING   EMA3 > EMA8 (crossover)    ',
    entry: 9000,  maxE: 60000,  tpLevels: [50, 100, 200], sl: 20, maxMin: 60,
    pattern: 'ema_cross',
  },
  {
    id: 'L_SW_SUPPORT',   label: 'SWING   rebond sur support          ',
    entry: 9000,  maxE: 60000,  tpLevels: [50, 100, 200], sl: 20, maxMin: 60,
    pattern: 'support_bounce',
  },
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchWithRetry(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { headers: HEADERS });
      if (r.ok) return await r.json();
    } catch (e) {}
    await sleep(800);
  }
  return null;
}

async function getTokenList(count = 500) {
  const tokens = [];
  const seen   = new Set();
  const sorts  = ['created_timestamp', 'last_trade_unix_time', 'market_cap'];
  for (const complete of [true, false]) {
    for (const sort of sorts) {
      for (let offset = 0; offset < 300; offset += 50) {
        process.stdout.write(`\r[FETCH] Tokens : ${tokens.length}/${count} (complete=${complete})  `);
        const data = await fetchWithRetry(
          `https://frontend-api-v3.pump.fun/coins?sort=${sort}&order=DESC&offset=${offset}&limit=50&includeNsfw=true`
          + (complete ? '&complete=true' : '')
        );
        const list = Array.isArray(data) ? data : (data?.coins || data?.data || []);
        for (const c of list) {
          if (c.mint && !seen.has(c.mint)) {
            seen.add(c.mint);
            tokens.push({ mint: c.mint, symbol: c.symbol || c.name || c.mint.slice(0, 8), mc: Math.round(c.usd_market_cap || 0), complete: !!c.complete });
          }
        }
        await sleep(400);
        if (tokens.length >= count) return tokens.slice(0, count);
      }
    }
  }
  return tokens.slice(0, count);
}

async function getPairAddress(mint) {
  const data  = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  const pairs = data?.pairs;
  if (!pairs?.length) return null;
  const pair  = pairs.find(p => p.dexId === 'pumpfun') || pairs[0];
  return pair?.pairAddress || null;
}

async function getCandles(mint) {
  const pairAddress = await getPairAddress(mint);
  if (!pairAddress) return null;
  await sleep(200);
  const data = await fetchWithRetry(
    `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}/ohlcv/minute?aggregate=1&limit=500`
  );
  const list = data?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(list) || list.length < 5) return null;
  return list
    .sort((a, b) => a[0] - b[0])
    .map(c => ({
      t:     c[0],
      open:  c[1] * TOTAL_SUPPLY,
      high:  c[2] * TOTAL_SUPPLY,
      low:   c[3] * TOTAL_SUPPLY,
      close: c[4] * TOTAL_SUPPLY,
    }));
}

// ─── PATTERNS D ENTREE ────────────────────────────────────────────────────────
function findEntry(candles, cfg) {
  const { entry, maxE, pattern } = cfg;

  if (pattern === 'direct') {
    // Premier chandelier qui touche la zone
    for (let i = 0; i < candles.length - 2; i++) {
      const c = candles[i];
      if (c.high >= entry && c.low <= maxE) {
        return { idx: i, price: entry };
      }
    }
    return null;
  }

  if (pattern === 'pullback') {
    // Token entre dans la zone, dip X%, puis rebond → entrer sur le rebond
    let inZone  = false;
    let zoneLow = Infinity;
    for (let i = 0; i < candles.length - 2; i++) {
      const c = candles[i];
      if (!inZone && c.high >= entry && c.close <= maxE) { inZone = true; }
      if (!inZone) continue;
      if (c.low < zoneLow) zoneLow = c.low;
      const reboundNeeded = zoneLow * (1 + (cfg.pullbackPct || 5) / 100);
      if (c.close >= reboundNeeded && c.close >= entry) {
        return { idx: i, price: c.close };
      }
    }
    return null;
  }

  if (pattern === 'hammer') {
    // Chandelier hammer dans la zone : meche basse >= 2x le corps ET clot dans la zone
    for (let i = 1; i < candles.length - 2; i++) {
      const c = candles[i];
      if (c.close < entry || c.close > maxE) continue;
      const body      = Math.abs(c.close - c.open);
      const lowerWick = Math.min(c.open, c.close) - c.low;
      const upperWick = c.high - Math.max(c.open, c.close);
      if (body > 0 && lowerWick >= 2 * body && lowerWick > upperWick) {
        return { idx: i, price: c.close };
      }
    }
    return null;
  }

  if (pattern === 'breakout') {
    // Close au-dessus du high des 3 dernieres bougies, dans la zone
    let inZone = false;
    for (let i = 3; i < candles.length - 2; i++) {
      const c = candles[i];
      if (!inZone && c.close >= entry) inZone = true;
      if (!inZone) continue;
      const prev3High = Math.max(candles[i-1].high, candles[i-2].high, candles[i-3].high);
      if (c.close > prev3High && c.close >= entry && c.close <= maxE * 1.5) {
        return { idx: i, price: c.close };
      }
    }
    return null;
  }

  if (pattern === 'trend_up') {
    // 2 bougies vertes consecutives dans la zone
    let inZone = false;
    for (let i = 1; i < candles.length - 2; i++) {
      const c    = candles[i];
      const prev = candles[i - 1];
      if (!inZone && c.close >= entry) inZone = true;
      if (!inZone) continue;
      if (prev.close > prev.open && c.close > c.open && c.close >= entry && c.close <= maxE * 1.5) {
        return { idx: i, price: c.close };
      }
    }
    return null;
  }

  // ── SWING PATTERNS ────────────────────────────────────────────────────────

  if (pattern === 'higher_low') {
    // Structure : bas1 < bas2 < bas3 (series de bas croissants = uptrend)
    // Entrer quand le 3eme higher low est confirme et le prix remonte
    let inZone = false;
    for (let i = 4; i < candles.length - 2; i++) {
      const c = candles[i];
      if (!inZone && c.close >= entry) inZone = true;
      if (!inZone) continue;
      const low1 = candles[i - 4].low;
      const low2 = candles[i - 2].low;
      const low3 = candles[i].low;
      // Chaque bas plus haut que le precedent
      if (low2 > low1 && low3 > low2 && c.close > c.open && c.close >= entry) {
        return { idx: i, price: c.close };
      }
    }
    return null;
  }

  if (pattern === 'consolidation') {
    // 4 bougies dans un range etroit (< 6% de variation), puis breakout au-dessus
    let inZone = false;
    for (let i = 4; i < candles.length - 2; i++) {
      const c = candles[i];
      if (!inZone && c.close >= entry) inZone = true;
      if (!inZone) continue;
      const window    = candles.slice(i - 3, i);
      const rangeHigh = Math.max(...window.map(x => x.high));
      const rangeLow  = Math.min(...window.map(x => x.low));
      const rangeRatio = (rangeHigh - rangeLow) / rangeLow;
      // Range < 6% = consolidation, puis breakout au-dessus
      if (rangeRatio < 0.06 && c.close > rangeHigh && c.close >= entry) {
        return { idx: i, price: c.close };
      }
    }
    return null;
  }

  if (pattern === 'ema_cross') {
    // EMA3 croise au-dessus de EMA8 pendant que le prix est dans la zone
    // Calcul de l EMA glissante au fil des bougies
    const k3 = 2 / (3 + 1);
    const k8 = 2 / (8 + 1);
    let ema3 = candles[0].close;
    let ema8 = candles[0].close;
    let prevEma3 = ema3, prevEma8 = ema8;
    let inZone = false;
    for (let i = 1; i < candles.length - 2; i++) {
      const c = candles[i];
      prevEma3 = ema3; prevEma8 = ema8;
      ema3 = c.close * k3 + ema3 * (1 - k3);
      ema8 = c.close * k8 + ema8 * (1 - k8);
      if (!inZone && c.close >= entry) inZone = true;
      if (!inZone) continue;
      // Croisement : EMA3 passe au-dessus de EMA8
      if (prevEma3 <= prevEma8 && ema3 > ema8 && c.close >= entry) {
        return { idx: i, price: c.close };
      }
    }
    return null;
  }

  if (pattern === 'support_bounce') {
    // Token etablit un plus bas, remonte, reteste ce plus bas, rebondit → entrer
    let inZone    = false;
    let support   = null;
    let aboveSupport = false;
    for (let i = 3; i < candles.length - 2; i++) {
      const c = candles[i];
      if (!inZone && c.close >= entry) { inZone = true; support = c.low; }
      if (!inZone) continue;
      // Mettre a jour le support si nouveau plus bas
      if (c.low < support) { support = c.low; aboveSupport = false; }
      // Detecter quand le prix monte bien au-dessus du support (confirmation)
      if (c.close > support * 1.08) aboveSupport = true;
      // Rebond sur le support : prix retombe pres du support puis repart
      if (aboveSupport && c.low <= support * 1.04 && c.close > support * 1.06 && c.close >= entry) {
        return { idx: i, price: c.close };
      }
    }
    return null;
  }

  return null;
}

// ─── SIMULATION ───────────────────────────────────────────────────────────────
function simulateTrade(candles, cfg) {
  const entry = findEntry(candles, cfg);
  if (!entry) return null;

  const { idx: entryIdx, price: entryMC } = entry;
  const entryTime  = candles[entryIdx].t;
  const maxSec     = cfg.maxMin * 60;
  const tpMCs      = cfg.tpLevels.map(pct => entryMC * (1 + pct / 100));
  let slMC         = entryMC * (1 - cfg.sl / 100);
  let tpIndex      = 0;
  let totalGain    = 0;
  const nTp        = cfg.tpLevels.length;

  for (let i = entryIdx + 1; i < candles.length; i++) {
    const c = candles[i];

    // Timeout
    if (c.t - entryTime > maxSec) {
      const remainPct = 1 - tpIndex / nTp;
      const closeGain = ((c.close - entryMC) / entryMC) * MISE_USD * remainPct;
      return { outcome: 'timeout', gain: +(totalGain + closeGain).toFixed(2), tpsHit: tpIndex, entryMC };
    }

    // TPs sur le high de la bougie
    while (tpIndex < tpMCs.length && c.high >= tpMCs[tpIndex]) {
      totalGain += (cfg.tpLevels[tpIndex] / 100) * MISE_USD * (1 / nTp);
      if (tpIndex === 0) slMC = entryMC; // break-even apres TP1
      tpIndex++;
      if (tpIndex === nTp) {
        return { outcome: 'tp_full', gain: +totalGain.toFixed(2), tpsHit: tpIndex, entryMC };
      }
    }

    // SL sur le low de la bougie
    if (c.low <= slMC) {
      const remainPct = 1 - tpIndex / nTp;
      const slGain    = tpIndex === 0 ? -(cfg.sl / 100) * MISE_USD : 0;
      return { outcome: tpIndex > 0 ? 'breakeven_sl' : 'sl', gain: +(totalGain + slGain).toFixed(2), tpsHit: tpIndex, entryMC };
    }
  }

  const last       = candles[candles.length - 1];
  const remainPct  = 1 - tpIndex / nTp;
  const closeGain  = ((last.close - entryMC) / entryMC) * MISE_USD * remainPct;
  return { outcome: 'end_of_data', gain: +(totalGain + closeGain).toFixed(2), tpsHit: tpIndex, entryMC };
}

// ─── AFFICHAGE ────────────────────────────────────────────────────────────────
function printResults(results) {
  console.log('\n');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log('              RESULTATS BACKTEST — SCALPING vs SWING TRADING');
  console.log('══════════════════════════════════════════════════════════════════════════════');

  const swingIds = ['I_SW_HIGHERLOW', 'J_SW_CONSOL', 'K_SW_EMA', 'L_SW_SUPPORT'];
  const scalping = results.filter(r => !swingIds.includes(r.id)).sort((a, b) => b.ev - a.ev);
  const swing    = results.filter(r =>  swingIds.includes(r.id)).sort((a, b) => b.ev - a.ev);

  const printGroup = (group, title) => {
    console.log(`\n── ${title} ──`);
    let rank = 1;
    for (const r of group) {
      const medal  = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : ` ${rank} `;
      const evSign = r.ev >= 0 ? '+' : '';
      console.log(`${medal} [${r.id}] ${r.label}`);
      console.log(`     ${r.trades} trades | WR ${r.winRate}% | EV ${evSign}$${r.ev.toFixed(2)}/t | NET ${r.net >= 0 ? '+' : ''}$${r.net.toFixed(0)} | win +$${r.avgWin.toFixed(0)} | loss -$${r.avgLoss.toFixed(0)}`);
      rank++;
    }
  };

  printGroup(scalping, 'SCALPING (5-20 min)');
  printGroup(swing,    'SWING TRADING (30-60 min)');

  const allSorted  = [...results].sort((a, b) => b.ev - a.ev);
  const overall    = allSorted[0];
  console.log('\n══════════════════════════════════════════════════════════════════════════════');
  console.log(`\n🏆 MEILLEUR TOUTES CATEGORIES : [${overall.id}] ${overall.label.trim()}`);
  console.log(`   EV : ${overall.ev >= 0 ? '+' : ''}$${overall.ev.toFixed(2)}/trade | WR : ${overall.winRate}% | NET : ${overall.net >= 0 ? '+' : ''}$${overall.net.toFixed(0)}`);
  console.log('══════════════════════════════════════════════════════════════════════════════\n');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🔬 BACKTEST PATTERNS — ' + new Date().toLocaleString());
  console.log(`   Mise : $${MISE_USD} | ${CONFIGS.length} patterns a comparer\n`);

  let tokens, candlesMap;

  if (fs.existsSync(CACHE_FILE) && process.argv.includes('--cached')) {
    console.log('[CACHE] Chargement des donnees sauvegardees...');
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    tokens      = cache.tokens;
    candlesMap  = cache.candlesMap;
    console.log(`[CACHE] ${tokens.length} tokens, ${Object.keys(candlesMap).length} avec chandeliers\n`);
  } else {
    console.log('[FETCH] Telechargement des tokens Pump.fun...');
    tokens      = await getTokenList(500);
    const nComp = tokens.filter(t => t.complete).length;
    console.log(`\n[FETCH] ${tokens.length} tokens (${nComp} gradues, ${tokens.length - nComp} bonding curve)\n`);

    candlesMap  = {};
    let done    = 0;
    for (const token of tokens) {
      process.stdout.write(`\r[CANDLES] ${done}/${tokens.length} — ${token.symbol.padEnd(12)}  `);
      const candles = await getCandles(token.mint);
      if (candles && candles.length >= 5) candlesMap[token.mint] = candles;
      done++;
      await sleep(500);
    }
    console.log(`\n[CANDLES] ${Object.keys(candlesMap).length} tokens avec historique\n`);

    fs.writeFileSync(CACHE_FILE, JSON.stringify({ tokens, candlesMap }));
    console.log('[CACHE] Sauvegarde dans backtest_cache.json\n');
  }

  // Simulation
  const results = [];
  for (const cfg of CONFIGS) {
    let trades = 0, wins = 0, losses = 0, timeouts = 0;
    let totalGain = 0, totalLoss = 0, winGains = 0, lossAmounts = 0;

    for (const token of tokens) {
      const candles = candlesMap[token.mint];
      if (!candles) continue;
      const sim = simulateTrade(candles, cfg);
      if (!sim) continue;

      trades++;
      totalGain  += Math.max(0, sim.gain);
      totalLoss  += Math.max(0, -sim.gain);
      if (sim.gain > 0)  { wins++;   winGains     += sim.gain; }
      else if (sim.gain < 0) { losses++; lossAmounts += Math.abs(sim.gain); }
      if (sim.outcome === 'timeout') timeouts++;
    }

    const net     = totalGain - totalLoss;
    const ev      = trades > 0 ? net / trades : 0;
    const winRate = trades > 0 ? Math.round((wins / trades) * 100) : 0;
    const avgWin  = wins   > 0 ? winGains    / wins   : 0;
    const avgLoss = losses > 0 ? lossAmounts / losses : 0;

    results.push({ ...cfg, trades, wins, losses, timeouts, totalGain, totalLoss, net, ev, winRate, avgWin, avgLoss });
    process.stdout.write(`\r[SIM] ${cfg.id} — ${trades} trades | EV $${ev.toFixed(2)}/t       `);
  }

  console.log('\n');
  printResults(results);

  fs.writeFileSync('./backtest_results.json', JSON.stringify(results, null, 2));
  console.log('📄 Resultats sauvegardes dans backtest_results.json\n');
}

main().catch(console.error);
