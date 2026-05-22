// backtest.js — teste 8 configs sur des tokens Pump.fun reels
// Usage : node backtest.js
if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const fs = require('fs');

const SOL_PRICE   = parseFloat(process.env.SOL_PRICE || '170');
const TOTAL_SUPPLY = 1_000_000_000;
const MISE_USD    = 100;
const CACHE_FILE  = './backtest_cache.json';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Origin': 'https://pump.fun',
  'Referer': 'https://pump.fun/',
};

// 8 configs a comparer
const CONFIGS = [
  { id: 'A', label: '$6k  / TP +30%  / SL -10%',           entry: 5500,  maxE: 8000,  tpLevels: [30],           sl: 10, maxMin: 8 },
  { id: 'B', label: '$6k  / TP +100% / SL -10%',           entry: 5500,  maxE: 8000,  tpLevels: [100],          sl: 10, maxMin: 8 },
  { id: 'C', label: '$8k  / TP +30%  / SL -10%  (v11)',    entry: 7500,  maxE: 11000, tpLevels: [30],           sl: 10, maxMin: 8 },
  { id: 'D', label: '$8k  / Multi-TP / SL -10%',           entry: 7500,  maxE: 11000, tpLevels: [20,40,60,100], sl: 10, maxMin: 8 },
  { id: 'E', label: '$10k / TP +50%  / SL -10%',           entry: 9000,  maxE: 13000, tpLevels: [50],           sl: 10, maxMin: 8 },
  { id: 'F', label: '$15k / Multi-TP / SL -10%',           entry: 13000, maxE: 18000, tpLevels: [20,40,60,100], sl: 10, maxMin: 8 },
  { id: 'G', label: '$20k / TP +30%  / SL -10%',           entry: 18000, maxE: 25000, tpLevels: [30],           sl: 10, maxMin: 8 },
  { id: 'H', label: '$8k  / TP +30%  / SL -15%',           entry: 7500,  maxE: 11000, tpLevels: [30],           sl: 15, maxMin: 8 },
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
  const seen = new Set();
  // On inclut les tokens completes (gradues Raydium) — ils ont plus d'historique de prix
  const sorts = ['created_timestamp', 'last_trade_unix_time', 'market_cap'];
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
  const data = await fetchWithRetry(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
  const pairs = data?.pairs;
  if (!pairs || !pairs.length) return null;
  // Prendre la paire Pump.fun ou la premiere dispo
  const pair = pairs.find(p => p.dexId === 'pumpfun') || pairs[0];
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

function simulateTrade(candles, cfg) {
  // Trouver le premier chandelier ou le token croise le seuil d entree
  let entryIdx = -1;
  for (let i = 0; i < candles.length - 2; i++) {
    if (candles[i].high >= cfg.entry && candles[i].low <= cfg.maxE) {
      entryIdx = i;
      break;
    }
  }
  if (entryIdx === -1) return null; // token n a jamais atteint la zone d entree

  const entryMC    = cfg.entry;
  const entryTime  = candles[entryIdx].t;
  const maxSec     = cfg.maxMin * 60;
  const tpMCs      = cfg.tpLevels.map(pct => entryMC * (1 + pct / 100));
  let slMC         = entryMC * (1 - cfg.sl / 100);
  let tpIndex      = 0;
  let totalGain    = 0;

  for (let i = entryIdx + 1; i < candles.length; i++) {
    const c = candles[i];

    // Timeout : force sell au close
    if (c.t - entryTime > maxSec) {
      const remainPct = 1 - tpIndex * 0.25;
      const closeGain = ((c.close - entryMC) / entryMC) * MISE_USD * remainPct;
      return { outcome: 'timeout', gain: +(totalGain + closeGain).toFixed(2), tpsHit: tpIndex };
    }

    // TPs : on utilise le high de la bougie
    while (tpIndex < tpMCs.length && c.high >= tpMCs[tpIndex]) {
      const pct = cfg.tpLevels[tpIndex] / 100;
      totalGain += pct * MISE_USD * 0.25;
      if (tpIndex === 0) slMC = entryMC; // break-even apres TP1
      tpIndex++;
      if (tpIndex === tpMCs.length) {
        return { outcome: 'tp_full', gain: +totalGain.toFixed(2), tpsHit: tpIndex };
      }
    }

    // SL : on utilise le low de la bougie
    if (c.low <= slMC) {
      const remainPct = 1 - tpIndex * 0.25;
      const slGain    = tpIndex === 0 ? -(cfg.sl / 100) * MISE_USD : 0; // break-even si TP1 deja hit
      return { outcome: tpIndex > 0 ? 'breakeven_sl' : 'sl', gain: +(totalGain + slGain).toFixed(2), tpsHit: tpIndex };
    }
  }

  // Fin des donnees : ferme au dernier close
  const last = candles[candles.length - 1];
  const remainPct = 1 - tpIndex * 0.25;
  const closeGain = ((last.close - entryMC) / entryMC) * MISE_USD * remainPct;
  return { outcome: 'end_of_data', gain: +(totalGain + closeGain).toFixed(2), tpsHit: tpIndex };
}

function printResults(results) {
  console.log('\n');
  console.log('══════════════════════════════════════════════════════════════════════════════');
  console.log('                        RESULTATS BACKTEST');
  console.log('══════════════════════════════════════════════════════════════════════════════');

  const sorted = [...results].sort((a, b) => b.ev - a.ev);
  let rank = 1;
  for (const r of sorted) {
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
    console.log(`\n${medal} CONFIG ${r.id} — ${r.label}`);
    console.log(`   Trades  : ${r.trades} | Wins : ${r.wins} (${r.winRate}%) | Losses : ${r.losses} | Timeouts : ${r.timeouts}`);
    console.log(`   Gains   : +$${r.totalGain.toFixed(0)} | Pertes : -$${r.totalLoss.toFixed(0)} | NET : ${r.net >= 0 ? '+' : ''}$${r.net.toFixed(0)}`);
    console.log(`   EV/trade: ${r.ev >= 0 ? '+' : ''}$${r.ev.toFixed(2)} | Avg win : +$${r.avgWin.toFixed(2)} | Avg loss : -$${r.avgLoss.toFixed(2)}`);
    rank++;
  }

  console.log('\n══════════════════════════════════════════════════════════════════════════════');
  const best = sorted[0];
  console.log(`\n✅ MEILLEURE CONFIG : ${best.id} — ${best.label}`);
  console.log(`   EV : +$${best.ev.toFixed(2)}/trade | Win rate : ${best.winRate}% | NET total : +$${best.net.toFixed(0)}`);
  console.log('══════════════════════════════════════════════════════════════════════════════\n');
}

async function main() {
  console.log('🔬 BACKTEST PUMP.FUN — ' + new Date().toLocaleString());
  console.log(`   SOL price : $${SOL_PRICE} | Mise : $${MISE_USD} | 8 configs\n`);

  // Charger depuis le cache si disponible
  let tokens, candlesMap;
  if (fs.existsSync(CACHE_FILE) && process.argv.includes('--cached')) {
    console.log('[CACHE] Chargement des donnees sauvegardees...');
    const cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    tokens = cache.tokens;
    candlesMap = cache.candlesMap;
    console.log(`[CACHE] ${tokens.length} tokens, ${Object.keys(candlesMap).length} avec chandeliers\n`);
  } else {
    // Telecharger les tokens
    console.log('[FETCH] Telechargement des tokens Pump.fun...');
    tokens = await getTokenList(500);
    const nComplete = tokens.filter(t => t.complete).length;
    console.log(`\n[FETCH] ${tokens.length} tokens recuperes (${nComplete} gradues Raydium, ${tokens.length - nComplete} en bonding curve)\n`);

    // Telecharger les chandeliers
    candlesMap = {};
    let done = 0;
    for (const token of tokens) {
      process.stdout.write(`\r[CANDLES] ${done}/${tokens.length} — ${token.symbol.padEnd(12)}  `);
      const candles = await getCandles(token.mint);
      if (candles && candles.length >= 5) candlesMap[token.mint] = candles;
      done++;
      await sleep(500); // rate limit DexScreener + GeckoTerminal
    }
    console.log(`\n[CANDLES] ${Object.keys(candlesMap).length} tokens avec historique\n`);

    // Sauvegarder le cache
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ tokens, candlesMap }));
    console.log('[CACHE] Donnees sauvegardees dans backtest_cache.json\n');
  }

  // Simuler chaque config
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
      totalGain += Math.max(0, sim.gain);
      totalLoss += Math.max(0, -sim.gain);

      if (sim.gain > 0) { wins++; winGains += sim.gain; }
      else if (sim.gain < 0) { losses++; lossAmounts += Math.abs(sim.gain); }

      if (sim.outcome === 'timeout') timeouts++;
    }

    const net     = totalGain - totalLoss;
    const ev      = trades > 0 ? net / trades : 0;
    const winRate = trades > 0 ? Math.round((wins / trades) * 100) : 0;
    const avgWin  = wins  > 0 ? winGains    / wins   : 0;
    const avgLoss = losses > 0 ? lossAmounts / losses : 0;

    results.push({ ...cfg, trades, wins, losses, timeouts, totalGain, totalLoss, net, ev, winRate, avgWin, avgLoss });
    process.stdout.write(`\r[SIM] Config ${cfg.id} — ${trades} trades, EV $${ev.toFixed(2)}/trade        `);
  }

  console.log('\n');
  printResults(results);

  // Sauvegarder les resultats
  fs.writeFileSync('./backtest_results.json', JSON.stringify(results, null, 2));
  console.log('📄 Resultats sauvegardes dans backtest_results.json\n');
}

main().catch(console.error);
