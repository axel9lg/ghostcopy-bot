if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const { Connection, PublicKey, Keypair, VersionedTransaction, Transaction, SystemProgram } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const http = require('http');

const server = http.createServer((req, res) => { res.writeHead(200); res.end('SNIPER OK'); });
server.listen(3001);

const httpUrl = process.env.RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=' + process.env.HELIUS_API_KEY;
const wsUrl = 'wss://mainnet.helius-rpc.com/?api-key=' + process.env.HELIUS_API_KEY;
const connection = new Connection(httpUrl, { commitment: 'confirmed', wsEndpoint: wsUrl });
const myWallet = Keypair.fromSecretKey(bs58.default.decode(process.env.PRIVATE_KEY));
const SOL = 'So11111111111111111111111111111111111111112';

// CONFIG — $200 mise, ratio TP:SL 2:1
const MISE_LAMPORTS = 1200000000; // ~1.2 SOL (~$200)
const MISE_USD = 200;
const TP_PCT = 20;   // +20% = +$40
const SL_PCT = 10;   // -10% = -$20  → ratio 2:1 (besoin de 34% win rate pour etre rentable)
const JITO_FEE = 500000;
const JITO_TIP = 1000000;
const MONITOR_INTERVAL = 3000;  // check toutes les 3s
const MAX_OPEN = 4;
const MAX_HOLD_MS = 12 * 60 * 1000; // force sell apres 12 minutes max

// Filtres — donnees Pump.fun directes
const MIN_AGE_SEC = 10;          // au moins 10s
const MAX_AGE_SEC = 900;         // max 15 minutes
const MIN_MC = 8000;             // MC minimum $8k (token avec traction)
const MAX_MC = 100000;           // MC maximum $100k
const MAX_LAST_TRADE_SEC = 120;  // trade dans les 2 dernieres minutes
const SCAN_INTERVAL = 5000;      // scan toutes les 5 secondes

// Jito
const JITO_ENDPOINTS = [
  'https://mainnet.block-engine.jito.labs.io/api/v1/bundles',
  'https://amsterdam.mainnet.block-engine.jito.labs.io/api/v1/bundles',
  'https://frankfurt.mainnet.block-engine.jito.labs.io/api/v1/bundles',
  'https://ny.mainnet.block-engine.jito.labs.io/api/v1/bundles',
];
const JITO_TIP_ACCOUNTS = [
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  'HFqU5x63VTqvB6pMFUFbTYPtoKyers4LcyHz7V1Y5TP',
  'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1sMaC9yXJrL',
];

const sniped = new Set();
const positions = {};
const watchlist = {};  // tokens surveilles en approche du seuil $8k

const WATCH_MIN_MC = 5000;  // commence a surveiller a $5k

const stats = {
  total: 0, wins: 0, losses: 0, skipped: 0,
  totalGainUSD: 0, totalLossUSD: 0,
  bestGainPct: 0, bestToken: ''
};

async function sendTelegram(msg) {
  try {
    await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: msg })
    });
  } catch(e) {}
}

let lastUpdateId = 0;
async function pollTelegram() {
  try {
    const r = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_TOKEN + '/getUpdates?offset=' + (lastUpdateId + 1) + '&limit=10&timeout=0');
    const data = await r.json();
    if (!data.ok || !data.result.length) return;
    for (const update of data.result) {
      lastUpdateId = update.update_id;
      const text = (update.message?.text || '').toLowerCase().trim();
      if (text === '/bilan' || text === 'bilan') {
        await sendSniperReport();
      } else if (text === '/positions' || text === 'positions') {
        const open = Object.entries(positions).filter(([, p]) => p.status === 'open');
        if (!open.length) {
          await sendTelegram('📭 Aucune position ouverte');
        } else {
          let msg = '📊 POSITIONS OUVERTES (' + open.length + '/' + MAX_OPEN + ')\n==================\n';
          for (const [mint, pos] of open) {
            const dureeMin = Math.round((Date.now() - pos.buyTime) / 60000);
            msg += '🪙 ' + (pos.name || mint.slice(0, 8)) + ' — ' + dureeMin + 'min\n';
          }
          await sendTelegram(msg);
        }
      } else if (text === '/aide' || text === 'aide') {
        await sendTelegram('🤖 COMMANDES DISPONIBLES\n==================\n/bilan — rapport complet des snipes\n/positions — positions actuellement ouvertes\n/aide — cette liste');
      }
    }
  } catch(e) {}
}

const PUMP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Origin': 'https://pump.fun',
  'Referer': 'https://pump.fun/',
};

// Essaie plusieurs endpoints Pump.fun — retourne le premier qui marche
async function fetchPumpList(sort) {
  const urls = [
    'https://frontend-api-v3.pump.fun/coins?sort=' + sort + '&order=DESC&offset=0&limit=50',
    'https://frontend-api.pump.fun/coins?sort=' + sort + '&order=DESC&offset=0&limit=100',
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: PUMP_HEADERS });
      if (!r.ok) { console.log('[API] ' + url.split('/')[2] + ' → HTTP ' + r.status); continue; }
      const data = await r.json();
      const list = Array.isArray(data) ? data : (data.coins || data.data || data.tokens || []);
      if (list.length > 0) { console.log('[API] ' + list.length + ' tokens via ' + url.split('/')[2]); return list; }
      console.log('[API] Reponse vide depuis ' + url.split('/')[2]);
    } catch(e) { console.log('[API] Erreur ' + e.message); }
  }
  return [];
}

async function getPumpTokens() {
  const [list1, list2] = await Promise.all([
    fetchPumpList('created_timestamp'),
    fetchPumpList('last_trade_unix_time'),
  ]);
  const seen = new Set();
  const merged = [];
  for (const coin of [...list1, ...list2]) {
    if (coin.mint && !seen.has(coin.mint)) { seen.add(coin.mint); merged.push(coin); }
  }
  return merged;
}

async function getPumpCoin(mint) {
  const urls = [
    'https://frontend-api-v3.pump.fun/coins/' + mint,
    'https://frontend-api.pump.fun/coins/' + mint,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: PUMP_HEADERS });
      if (!r.ok) continue;
      const data = await r.json();
      return data;
    } catch(e) {}
  }
  return null;
}

async function submitViaJito(vtx) {
  const txBase64 = Buffer.from(vtx.serialize()).toString('base64');
  try {
    const tipAccount = new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]);
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const tipTx = new Transaction({ recentBlockhash: blockhash, feePayer: myWallet.publicKey })
      .add(SystemProgram.transfer({ fromPubkey: myWallet.publicKey, toPubkey: tipAccount, lamports: JITO_TIP }));
    tipTx.sign(myWallet);
    const tipBase64 = Buffer.from(tipTx.serialize()).toString('base64');
    const endpoint = JITO_ENDPOINTS[Math.floor(Math.random() * JITO_ENDPOINTS.length)];
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [[txBase64, tipBase64]] })
    });
    const result = await r.json();
    if (result.result) {
      const sig = bs58.default.encode(Buffer.from(vtx.signatures[0]));
      console.log('[JITO] Bundle envoye — ' + sig.slice(0, 12) + '...');
      return sig;
    }
    throw new Error(result.error ? JSON.stringify(result.error) : 'no result');
  } catch(e) {
    console.log('[JITO] Fallback RPC : ' + e.message);
    return await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 5 });
  }
}

async function sellToken(mint, slippageBps = 500) {
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      myWallet.publicKey, { mint: new PublicKey(mint) }
    );
    if (!tokenAccounts.value.length) return null;
    const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
    if (balance === '0') return null;
    const qr = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=' + mint + '&outputMint=' + SOL + '&amount=' + balance + '&slippageBps=' + slippageBps);
    const q = await qr.json();
    if (!q.outAmount) return null;
    const sr = await fetch('https://api.jup.ag/swap/v1/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quoteResponse: q, userPublicKey: myWallet.publicKey.toString(), wrapAndUnwrapSol: true, prioritizationFeeLamports: JITO_FEE })
    });
    const sd = await sr.json();
    if (!sd.swapTransaction) return null;
    const buf = Buffer.from(sd.swapTransaction, 'base64');
    const vtx = VersionedTransaction.deserialize(buf);
    vtx.sign([myWallet]);
    return await submitViaJito(vtx);
  } catch(e) { console.log('Erreur sell : ' + e.message); return null; }
}

async function sendSniperReport() {
  const winRate = stats.total > 0 ? Math.round((stats.wins / stats.total) * 100) : 0;
  const net = stats.totalGainUSD - stats.totalLossUSD;
  const netEmoji = net >= 0 ? '✅' : '🔴';
  let recommandation;
  if (winRate >= 55 && net > 0) recommandation = '💹 RENTABLE — Tu peux augmenter la mise';
  else if (winRate >= 45) recommandation = '⚖️ PROCHE — Continue pour plus de donnees';
  else recommandation = '⚠️ EN DESSOUS — Marche difficile, patience';
  await sendTelegram(
    '📊 BILAN ' + stats.total + ' SNIPES\n==================\n'
    + '🏆 Wins : ' + stats.wins + ' | 🔴 Losses : ' + stats.losses + '\n'
    + '📊 Win rate : ' + winRate + '% (objectif : >50%)\n'
    + '🚫 Skips : ' + stats.skipped + '\n==================\n'
    + '💰 Mise : $' + MISE_USD + ' | TP : +' + TP_PCT + '% | SL : -' + SL_PCT + '%\n'
    + '📈 Gains : +$' + stats.totalGainUSD.toFixed(0) + '\n'
    + '📉 Pertes : -$' + stats.totalLossUSD.toFixed(0) + '\n'
    + netEmoji + ' NET : ' + (net >= 0 ? '+' : '') + '$' + net.toFixed(0) + '\n==================\n'
    + '🥇 Meilleur : +' + stats.bestGainPct + '% (' + (stats.bestToken || 'N/A') + ')\n==================\n'
    + recommandation
  );
}

async function monitorSnipe(mint, name, entryMC, buyTime) {
  let peak = entryMC;
  let checks = 0;
  let consecutiveZeros = 0;
  let lastMC = entryMC;
  const tpMC = Math.round(entryMC * (1 + TP_PCT / 100));
  const slMC = Math.round(entryMC * (1 - SL_PCT / 100));

  const interval = setInterval(async () => {
    try {
      checks++;
      const coin = await getPumpCoin(mint);
      const mc = coin ? Math.round(coin.usd_market_cap || 0) : 0;

      // MC = 0 : rug probable — vendre apres 2 checks consecutifs (6s)
      if (!mc) {
        consecutiveZeros++;
        if (consecutiveZeros >= 2) {
          clearInterval(interval);
          delete positions[mint];
          stats.losses++;
          stats.totalLossUSD += MISE_USD * SL_PCT / 100;
          const sig = await sellToken(mint, 3000);
          await sendTelegram(
            '💀 RUG DETECTE\n==================\n🪙 ' + name + '\n'
            + '⚠️ MC a $0 — vente urgence\n==================\n'
            + '📉 Perte estimee : -$' + (MISE_USD * SL_PCT / 100).toFixed(0) + '\n'
            + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle')
          );
          if (stats.total % 10 === 0) sendSniperReport();
        }
        return;
      }
      consecutiveZeros = 0;

      // Force sell apres MAX_HOLD_MS (10 min)
      if (Date.now() - buyTime > MAX_HOLD_MS) {
        clearInterval(interval);
        const gainPct = Math.round((mc / entryMC - 1) * 100);
        const gainUSD = (gainPct / 100) * MISE_USD;
        delete positions[mint];
        if (gainUSD >= 0) { stats.wins++; stats.totalGainUSD += gainUSD; }
        else { stats.losses++; stats.totalLossUSD += Math.abs(gainUSD); }
        const sig = await sellToken(mint, 1000);
        const dureeMin = Math.round((Date.now() - buyTime) / 60000);
        await sendTelegram(
          '⏰ 10MIN MAX ATTEINT\n==================\n🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n'
          + '📊 Sortie : $' + mc.toLocaleString() + ' MC\n==================\n'
          + (gainPct >= 0 ? '💰 +' : '📉 ') + gainPct + '% (' + (gainUSD >= 0 ? '+' : '') + '$' + gainUSD.toFixed(0) + ')\n'
          + '⏱ Duree : ' + dureeMin + ' min\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle')
        );
        if (stats.total % 10 === 0) sendSniperReport();
        return;
      }

      // Dump rapide : chute >30% en un seul check = vente urgence
      const dropPct = lastMC > 0 ? Math.round((mc / lastMC - 1) * 100) : 0;
      lastMC = mc;
      if (dropPct <= -30) {
        clearInterval(interval);
        const gainPct = Math.round((mc / entryMC - 1) * 100);
        const perteUSD = Math.abs((gainPct / 100) * MISE_USD);
        stats.losses++;
        stats.totalLossUSD += perteUSD;
        delete positions[mint];
        const sig = await sellToken(mint, 3000);
        const dureeMin = Math.round((Date.now() - buyTime) / 60000);
        await sendTelegram(
          '📉 DUMP -' + Math.abs(dropPct) + '% DETECTE\n==================\n🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n'
          + '📊 Sortie : $' + mc.toLocaleString() + ' MC\n==================\n'
          + '📉 Perte : -$' + perteUSD.toFixed(0) + '\n'
          + '⏱ Duree : ' + dureeMin + ' min\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle')
        );
        if (stats.total % 10 === 0) sendSniperReport();
        return;
      }

      if (mc > peak) peak = mc;
      const gainPct = Math.round((mc / entryMC - 1) * 100);
      const dureeMin = Math.round((Date.now() - buyTime) / 60000);
      console.log('[POS] ' + name + ' | $' + mc.toLocaleString() + ' MC | ' + (gainPct >= 0 ? '+' : '') + gainPct + '% | TP $' + tpMC.toLocaleString() + ' | SL $' + slMC.toLocaleString());

      // TAKE PROFIT +10%
      if (mc >= tpMC) {
        clearInterval(interval);
        const gainUSD = (gainPct / 100) * MISE_USD;
        if (gainPct > stats.bestGainPct) { stats.bestGainPct = gainPct; stats.bestToken = name; }
        stats.wins++;
        stats.totalGainUSD += gainUSD;
        delete positions[mint];
        const sig = await sellToken(mint, 500);
        await sendTelegram(
          '🏆 TP +' + TP_PCT + '% ATTEINT\n==================\n🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n'
          + '📊 Sortie : $' + mc.toLocaleString() + ' MC\n==================\n'
          + '💰 Gain : +' + gainPct + '% (+$' + gainUSD.toFixed(0) + ')\n'
          + '💵 Capital : $' + (MISE_USD + gainUSD).toFixed(0) + '\n'
          + '⏱ Duree : ' + dureeMin + ' min\n==================\n'
          + 'BENEFICE : +$' + gainUSD.toFixed(0) + '\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle') + '\n'
          + '📊 https://dexscreener.com/solana/' + mint
        );
        if (stats.total % 10 === 0) sendSniperReport();
        return;
      }

      // STOP LOSS -10%
      if (mc <= slMC) {
        clearInterval(interval);
        const perteUSD = Math.abs((gainPct / 100) * MISE_USD);
        stats.losses++;
        stats.totalLossUSD += perteUSD;
        delete positions[mint];
        const sig = await sellToken(mint, 1500);
        await sendTelegram(
          '🔴 STOP LOSS\n==================\n🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n'
          + '📊 Sortie : $' + mc.toLocaleString() + ' MC\n==================\n'
          + '📉 Perte : -' + Math.abs(gainPct) + '% (-$' + perteUSD.toFixed(0) + ')\n'
          + '⏱ Duree : ' + dureeMin + ' min\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle')
        );
        if (stats.total % 10 === 0) sendSniperReport();
      }
    } catch(e) {}
  }, MONITOR_INTERVAL);
}

// Surveille les tokens en approche $8k et achete au passage du seuil
async function checkWatchlist() {
  const entries = Object.entries(watchlist);
  if (entries.length === 0) return;
  for (const [mint, info] of entries) {
    if (sniped.has(mint) || positions[mint]) { delete watchlist[mint]; continue; }
    if (Date.now() - info.addedAt > MAX_AGE_SEC * 1000) {
      delete watchlist[mint];
      continue;
    }
    try {
      const coin = await getPumpCoin(mint);
      const mc = coin ? Math.round(coin.usd_market_cap || 0) : 0;
      if (!mc) { delete watchlist[mint]; continue; }
      console.log('[WATCH] ' + info.name + ' | $' + mc.toLocaleString() + ' MC → seuil $' + MIN_MC.toLocaleString());
      if (mc >= MIN_MC) {
        delete watchlist[mint];
        if (Object.keys(positions).length < MAX_OPEN) {
          console.log('[ENTRY] ' + info.name + ' franchit $' + mc.toLocaleString() + ' → ACHAT!');
          await snipe(mint, info.name, mc);
        }
      }
    } catch(e) {}
  }
}

async function snipe(mint, name, entryMC) {
  if (positions[mint]) return;
  if (Object.keys(positions).length >= MAX_OPEN) return;
  positions[mint] = { status: 'buying' };

  for (let i = 1; i <= 3; i++) {
    try {
      const qr = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=' + SOL + '&outputMint=' + mint + '&amount=' + MISE_LAMPORTS + '&slippageBps=2000');
      const q = await qr.json();
      if (!q.outAmount) {
        if (i === 3) { delete positions[mint]; await sendTelegram('❌ ECHEC\n🪙 ' + name + '\nNon swappable'); }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      const sr = await fetch('https://api.jup.ag/swap/v1/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteResponse: q, userPublicKey: myWallet.publicKey.toString(), wrapAndUnwrapSol: true, prioritizationFeeLamports: JITO_FEE })
      });
      const sd = await sr.json();
      if (!sd.swapTransaction) continue;
      const buf = Buffer.from(sd.swapTransaction, 'base64');
      const vtx = VersionedTransaction.deserialize(buf);
      vtx.sign([myWallet]);
      const sig = await submitViaJito(vtx);

      const buyTime = Date.now();
      positions[mint] = { status: 'open', buyTime, sig, name };
      stats.total++;
      sniped.add(mint);

      const tpMC = Math.round(entryMC * (1 + TP_PCT / 100));
      const slMC = Math.round(entryMC * (1 - SL_PCT / 100));

      await sendTelegram(
        '🎯 SNIPE EXECUTE\n==================\n'
        + '🪙 ' + name + '\n'
        + '📊 MC entree : $' + entryMC.toLocaleString() + '\n==================\n'
        + '💰 Mise : $' + MISE_USD + '\n'
        + '🎯 TP : +' + TP_PCT + '% → $' + tpMC.toLocaleString() + ' MC (+$' + (MISE_USD * TP_PCT / 100) + ')\n'
        + '🛑 SL : -' + SL_PCT + '% → $' + slMC.toLocaleString() + ' MC (-$' + (MISE_USD * SL_PCT / 100) + ')\n==================\n'
        + '🔗 https://solscan.io/tx/' + sig + '\n'
        + '📊 https://dexscreener.com/solana/' + mint
      );
      monitorSnipe(mint, name, entryMC, buyTime);
      break;
    } catch(e) {
      console.log('Tentative ' + i + ' : ' + e.message);
      if (i === 3) delete positions[mint];
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Scan Pump.fun directement — pas de delai DexScreener
async function scanPumpFun() {
  try {
    const tokens = await getPumpTokens();
    if (!tokens || tokens.length === 0) {
      console.log('[SCAN] API injoignable — retry dans ' + (SCAN_INTERVAL / 1000) + 's');
      return;
    }
    console.log('[SCAN] ' + tokens.length + ' tokens reçus');

    const now = Date.now() / 1000;
    let total = 0, tooYoung = 0, tooOld = 0, mcTooLow = 0, mcTooHigh = 0, inactive = 0, candidates = 0;

    for (const coin of tokens) {
      if (!coin.mint || sniped.has(coin.mint) || positions[coin.mint]) continue;
      total++;

      // Pump.fun: created_timestamp en millisecondes
      const createdSec = coin.created_timestamp > 1e12 ? coin.created_timestamp / 1000 : coin.created_timestamp;
      const ageSec = now - createdSec;
      const mc = Math.round(coin.usd_market_cap || 0);
      // last_trade peut etre en ms ou en s selon l'API, ou 0 si jamais trade
      const lastTradeRaw = coin.last_trade_unix_time || 0;
      const lastTradeSec = lastTradeRaw > 1e12 ? now - (lastTradeRaw / 1000) : (lastTradeRaw > 0 ? now - lastTradeRaw : 0);
      const name = coin.symbol || coin.name || coin.mint.slice(0, 8);

      if (ageSec < MIN_AGE_SEC) { tooYoung++; continue; }
      if (ageSec > MAX_AGE_SEC) { tooOld++; continue; }
      if (coin.complete) continue;
      // last_trade=0 = jamais trade = token tres frais = OK
      if (lastTradeSec > MAX_LAST_TRADE_SEC && lastTradeRaw > 0) { inactive++; continue; }

      // Token en approche du seuil $8k : ajouter au watchlist
      if (mc >= WATCH_MIN_MC && mc < MIN_MC) {
        if (!watchlist[coin.mint] && !sniped.has(coin.mint) && !positions[coin.mint]) {
          watchlist[coin.mint] = { name, addedAt: Date.now() };
          console.log('[WATCH] ' + name + ' | $' + mc.toLocaleString() + ' MC → surveillance jusqu a $' + MIN_MC.toLocaleString());
        }
        continue;
      }

      if (mc < MIN_MC) { mcTooLow++; continue; }
      if (mc > MAX_MC) { mcTooHigh++; continue; }

      candidates++;
      console.log('[CANDIDAT] ' + name + ' | $' + mc.toLocaleString() + ' MC | age ' + Math.round(ageSec) + 's | trade il y a ' + Math.round(lastTradeSec) + 's');

      if (Object.keys(positions).length >= MAX_OPEN) { stats.skipped++; continue; }

      const tpTarget = Math.round(mc * (1 + TP_PCT / 100));
      const slTarget = Math.round(mc * (1 - SL_PCT / 100));
      await sendTelegram(
        '🔍 CANDIDAT TROUVE\n==================\n'
        + '🪙 ' + name + '\n'
        + '📊 MC entree : $' + mc.toLocaleString() + '\n'
        + '⏱ Age : ' + Math.round(ageSec) + 's\n'
        + '🔄 Dernier trade : il y a ' + Math.round(lastTradeSec) + 's\n==================\n'
        + '🏆 TP : $' + tpTarget.toLocaleString() + ' MC (+$' + (MISE_USD * TP_PCT / 100) + ')\n'
        + '🛑 SL : $' + slTarget.toLocaleString() + ' MC (-$' + (MISE_USD * SL_PCT / 100) + ')\n==================\n'
        + '⚡ Achat $' + MISE_USD + ' via Jito...'
      );
      await snipe(coin.mint, name, mc);
      break;
    }

    console.log('[SCAN] ' + total + ' tokens | trop frais:' + tooYoung + ' trop vieux:' + tooOld + ' MC bas:' + mcTooLow + ' MC haut:' + mcTooHigh + ' inactifs:' + inactive + ' → ' + candidates + ' candidat(s)');
  } catch(e) {
    console.log('[SCAN] Erreur : ' + e.message);
  }
}

async function startSniper() {
  console.log('[SNIPER] Actif — scan Pump.fun direct — MC $' + MIN_MC.toLocaleString() + '-$' + MAX_MC.toLocaleString() + ' — TP +' + TP_PCT + '% SL -' + SL_PCT + '%');
  const tpUSD = MISE_USD * TP_PCT / 100;
  const slUSD = MISE_USD * SL_PCT / 100;
  const breakevenWinRate = Math.round(slUSD / (tpUSD + slUSD) * 100);
  await sendTelegram(
    '🎯 SNIPER v9 DEMARRE\n==================\n'
    + '📡 Scan Pump.fun direct toutes les ' + (SCAN_INTERVAL / 1000) + 's\n==================\n'
    + '⏱ Age token : ' + MIN_AGE_SEC + 's - ' + (MAX_AGE_SEC / 60) + 'min\n'
    + '📊 MC : $' + MIN_MC.toLocaleString() + ' - $' + MAX_MC.toLocaleString() + '\n'
    + '🔄 Activite : trade < ' + MAX_LAST_TRADE_SEC + 's\n==================\n'
    + '💰 Mise : $' + MISE_USD + ' x ' + MAX_OPEN + ' positions\n'
    + '🏆 TP : +' + TP_PCT + '% = +$' + tpUSD + ' de benefice\n'
    + '🛑 SL : -' + SL_PCT + '% = -$' + slUSD + ' de perte\n'
    + '📐 Ratio risque : 2:1 (rentable a partir de ' + breakevenWinRate + '% win)\n==================\n'
    + '💀 Rug : vente urgence en 6s\n'
    + '📉 Dump -30% : vente urgence immediate\n'
    + '⏰ Max hold : 12 minutes\n'
    + '⚡ Jito bundles actifs\n==================\n'
    + '🧮 OBJECTIF :\n'
    + '   5 trades/jour a 45% win\n'
    + '   → +' + (5 * (tpUSD * 0.45 - slUSD * 0.55)).toFixed(0) + '$/jour estimé\n'
    + '=================='
  );

  // Scan toutes les 5 secondes pour decouvrir nouveaux tokens
  setInterval(() => scanPumpFun(), SCAN_INTERVAL);
  // Watchlist verifie toutes les 3 secondes pour saisir le passage a $8k
  setInterval(() => checkWatchlist(), 3000);
  // Ecoute les commandes Telegram toutes les 3 secondes
  setInterval(() => pollTelegram(), 3000);
  // Premier scan immediat
  scanPumpFun();
}

startSniper();
