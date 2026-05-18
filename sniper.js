if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const { Connection, PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
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
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// CONFIG
const MISE_LAMPORTS = 1200000000; // ~1.2 SOL (~$200)
const MISE_USD = 200;
const TP_PCT = 100;               // x2 depuis l'entree
const SL_PCT = 30;
const TRAILING_ACTIVATE_PCT = 50;
const TRAILING_PCT = 20;
const JITO_FEE = 500000;
const MONITOR_INTERVAL = 5000;
const MAX_OPEN = 3;

// Filtres qualite (token doit survivre 60s et passer ces criteres)
const MIN_WAIT_SEC = 60;    // survie minimum avant d'acheter
const MAX_WAIT_SEC = 300;   // abandon apres 5 minutes
const MIN_MC = 5000;        // MC minimum ($5k)
const MAX_ENTRY_MC = 40000; // MC maximum ($40k)
const MIN_LIQUIDITY = 2000; // liquidite minimum ($2k)
const MIN_BUYS_5M = 10;     // achats actifs sur 5 min

// Dip — attente d'une correction avant achat
const DIP_PCT = 15;           // attendre -15% depuis le MC filtre
const MAX_DIP_WAIT_SEC = 180; // abandonner apres 3 min si pas de dip
const MAX_RISE_PCT = 60;      // si +60% depuis filtre = rate le train

const sniped = new Set();
const positions = {};
const watchlist = {};    // tokens en surveillance (attente 60s)
const dipWatchlist = {}; // tokens filtres, en attente du dip

const txQueue = [];
let processingQueue = false;

const stats = {
  total: 0, wins: 0, losses: 0, skipped: 0,
  totalGainUSD: 0, totalLossUSD: 0,
  bestGainPct: 0, bestToken: '',
  fastestWinMs: Infinity, fastestToken: ''
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

async function getTokenInfo(mint) {
  try {
    const r = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + mint);
    const d = await r.json();
    if (d.pairs && d.pairs.length > 0) {
      const p = d.pairs[0];
      return {
        mc: p.fdv || 0,
        price: parseFloat(p.priceUsd) || 0,
        name: p.baseToken?.symbol || mint.slice(0, 8),
        liquidity: p.liquidity?.usd || 0,
        buys5m: p.txns?.m5?.buys || 0,
        sells5m: p.txns?.m5?.sells || 0,
        priceChange5m: p.priceChange?.m5 || 0,
        volume5m: p.volume?.m5 || 0
      };
    }
    return { mc: 0, price: 0, name: mint.slice(0, 8), liquidity: 0, buys5m: 0, sells5m: 0, priceChange5m: 0, volume5m: 0 };
  } catch(e) {
    return { mc: 0, price: 0, name: mint.slice(0, 8), liquidity: 0, buys5m: 0, sells5m: 0, priceChange5m: 0, volume5m: 0 };
  }
}

async function sellToken(mint) {
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      myWallet.publicKey, { mint: new PublicKey(mint) }
    );
    if (!tokenAccounts.value.length) return null;
    const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
    if (balance === '0') return null;

    const qr = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=' + mint + '&outputMint=' + SOL + '&amount=' + balance + '&slippageBps=500');
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
    return await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 5 });
  } catch(e) {
    console.log('Erreur sell : ' + e.message);
    return null;
  }
}

async function sendSniperReport() {
  const winRate = stats.total > 0 ? Math.round((stats.wins / stats.total) * 100) : 0;
  const net = stats.totalGainUSD - stats.totalLossUSD;
  const netEmoji = net >= 0 ? '✅' : '🔴';
  const fastest = stats.fastestWinMs < Infinity ? Math.round(stats.fastestWinMs / 1000) + 's (' + stats.fastestToken + ')' : 'N/A';

  let recommandation;
  if (winRate >= 50 && net > 0) recommandation = '💹 RENTABLE — Tu peux augmenter la mise';
  else if (winRate >= 35 && net >= 0) recommandation = '⚖️ NEUTRE — Continue pour plus de donnees';
  else recommandation = '⚠️ NEGATIF — Le marche est difficile, patience';

  await sendTelegram(
    '📊 BILAN ' + stats.total + ' SNIPES\n'
    + '==================\n'
    + '🏆 Wins : ' + stats.wins + '\n'
    + '🔴 Losses : ' + stats.losses + '\n'
    + '📊 Win rate : ' + winRate + '%\n'
    + '🚫 Ignores : ' + stats.skipped + '\n'
    + '==================\n'
    + '💰 Mise par trade : $' + MISE_USD + '\n'
    + '📈 Gains reels : +$' + stats.totalGainUSD.toFixed(0) + '\n'
    + '📉 Pertes reelles : -$' + stats.totalLossUSD.toFixed(0) + '\n'
    + netEmoji + ' NET REEL : ' + (net >= 0 ? '+' : '') + '$' + net.toFixed(0) + '\n'
    + '==================\n'
    + '🥇 Meilleur gain : +' + stats.bestGainPct + '% (' + (stats.bestToken || 'N/A') + ')\n'
    + '⚡ Win le plus rapide : ' + fastest + '\n'
    + '==================\n'
    + recommandation + '\n'
    + '=================='
  );
}

async function monitorSnipe(mint, name, buyTime) {
  let entryMC = null;
  let peak = 0;
  let trailingActive = false;
  let checks = 0;

  const interval = setInterval(async () => {
    try {
      checks++;
      const { mc } = await getTokenInfo(mint);

      if (!mc) {
        if (checks >= 12) {
          clearInterval(interval);
          const lossUSD = MISE_USD * SL_PCT / 100;
          stats.losses++;
          stats.totalLossUSD += lossUSD;
          delete positions[mint];
          await sendTelegram('🔴 ABANDON\n==================\n🪙 ' + name + '\nPlus de liquidite\n==================\nPERTE ESTIMEE : -$' + lossUSD);
          if (stats.total % 10 === 0) sendSniperReport();
        }
        return;
      }

      if (!entryMC) { entryMC = mc; peak = mc; }
      if (mc > peak) {
        peak = mc;
        if (peak >= entryMC * (1 + TRAILING_ACTIVATE_PCT / 100)) trailingActive = true;
      }

      const gainPct = Math.round((mc / entryMC - 1) * 100);
      const dureeMin = Math.round((Date.now() - buyTime) / 60000);
      const trailingStatus = trailingActive ? ' [TRAILING ON]' : ' [SL ' + SL_PCT + '%]';
      console.log('[POS] ' + name + ' | $' + mc.toLocaleString() + ' MC | ' + (gainPct >= 0 ? '+' : '') + gainPct + '% | Pic $' + peak.toLocaleString() + trailingStatus);

      // TRAILING STOP
      if (trailingActive && mc <= peak * (1 - TRAILING_PCT / 100)) {
        clearInterval(interval);
        const gainUSD = (gainPct / 100) * MISE_USD;
        if (gainPct > stats.bestGainPct) { stats.bestGainPct = gainPct; stats.bestToken = name; }
        if (gainPct > 0) { stats.wins++; stats.totalGainUSD += gainUSD; }
        else { stats.losses++; stats.totalLossUSD += Math.abs(gainUSD); }
        delete positions[mint];
        const sig = await sellToken(mint);
        await sendTelegram(
          '🔄 TRAILING STOP\n==================\n🪙 ' + name + '\n'
          + '📈 Pic : $' + peak.toLocaleString() + ' MC\n'
          + '📊 Sortie : $' + mc.toLocaleString() + ' MC\n==================\n'
          + (gainPct >= 0 ? '💰 Gain' : '📉 Perte') + ' : ' + (gainPct >= 0 ? '+' : '') + gainPct + '% (' + (gainPct >= 0 ? '+$' : '-$') + Math.abs(gainUSD).toFixed(0) + ')\n'
          + '⏱ Duree : ' + dureeMin + ' min\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle requise')
        );
        if (stats.total % 10 === 0) sendSniperReport();
        return;
      }

      // TAKE PROFIT x2
      if (gainPct >= TP_PCT) {
        clearInterval(interval);
        const gainUSD = (gainPct / 100) * MISE_USD;
        const dureeMs = Date.now() - buyTime;
        if (dureeMs < stats.fastestWinMs) { stats.fastestWinMs = dureeMs; stats.fastestToken = name; }
        if (gainPct > stats.bestGainPct) { stats.bestGainPct = gainPct; stats.bestToken = name; }
        stats.wins++;
        stats.totalGainUSD += gainUSD;
        delete positions[mint];
        const sig = await sellToken(mint);
        await sendTelegram(
          '🏆 x2 ATTEINT\n==================\n🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n'
          + '📊 Sortie : $' + mc.toLocaleString() + ' MC\n==================\n'
          + '💰 Gain : +' + gainPct + '% (+$' + gainUSD.toFixed(0) + ')\n'
          + '💵 Valeur finale : $' + (MISE_USD + gainUSD).toFixed(0) + '\n'
          + '⏱ Duree : ' + dureeMin + ' min\n==================\n'
          + 'BENEFICE NET : +$' + gainUSD.toFixed(0) + '\n'
          + '📊 https://dexscreener.com/solana/' + mint + '\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle requise')
        );
        if (stats.total % 10 === 0) sendSniperReport();
        return;
      }

      // STOP LOSS
      if (gainPct <= -SL_PCT) {
        clearInterval(interval);
        const perteUSD = Math.abs((gainPct / 100) * MISE_USD);
        stats.losses++;
        stats.totalLossUSD += perteUSD;
        delete positions[mint];
        const sig = await sellToken(mint);
        await sendTelegram(
          '🔴 STOP LOSS\n==================\n🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n'
          + '📊 Sortie : $' + mc.toLocaleString() + ' MC\n==================\n'
          + '📉 Perte : -' + Math.abs(gainPct) + '% (-$' + perteUSD.toFixed(0) + ')\n'
          + '⏱ Duree : ' + dureeMin + ' min\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle requise')
        );
        if (stats.total % 10 === 0) sendSniperReport();
      }
    } catch(e) {}
  }, MONITOR_INTERVAL);
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
      const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 5 });

      const buyTime = Date.now();
      positions[mint] = { status: 'open', buyTime, sig };
      stats.total++;
      sniped.add(mint);

      await sendTelegram(
        '🎯 SNIPE EXECUTE\n==================\n'
        + '🪙 ' + name + '\n'
        + '📊 MC entree : $' + entryMC.toLocaleString() + '\n==================\n'
        + '💰 Mise : $' + MISE_USD + '\n'
        + '🎯 TP : x2 (+' + TP_PCT + '%) → +$' + (MISE_USD * TP_PCT / 100) + '\n'
        + '🔄 Trailing : actif a +' + TRAILING_ACTIVATE_PCT + '%, coupe -' + TRAILING_PCT + '% du pic\n'
        + '🛑 SL : -' + SL_PCT + '%\n==================\n'
        + '🔗 https://solscan.io/tx/' + sig + '\n'
        + '📊 https://dexscreener.com/solana/' + mint
      );

      monitorSnipe(mint, name, buyTime);
      break;
    } catch(e) {
      console.log('Tentative ' + i + ' : ' + e.message);
      if (i === 3) delete positions[mint];
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Verifie les tokens en surveillance toutes les 5 secondes
async function checkWatchlist() {
  const now = Date.now();
  const mints = Object.keys(watchlist);
  if (mints.length === 0) return;

  for (const mint of mints) {
    if (!watchlist[mint]) continue;
    const info = watchlist[mint];
    const ageSec = (now - info.detectedAt) / 1000;

    // Pas encore assez vieux
    if (ageSec < MIN_WAIT_SEC) continue;

    // Trop vieux — abandonner
    if (ageSec > MAX_WAIT_SEC) {
      delete watchlist[mint];
      stats.skipped++;
      console.log('[EXPIRE] ' + info.name + ' — abandon apres ' + Math.round(ageSec) + 's');
      continue;
    }

    try {
      const { mc, name, liquidity, buys5m, priceChange5m } = await getTokenInfo(mint);
      if (name && name !== mint.slice(0, 8)) info.name = name;

      // Pas encore indexe sur DexScreener
      if (!mc) continue;

      // MC trop haut — rate la fenetre
      if (mc > MAX_ENTRY_MC) {
        delete watchlist[mint];
        stats.skipped++;
        console.log('[SKIP] ' + info.name + ' — MC trop haut $' + mc.toLocaleString());
        continue;
      }

      // Filtres qualite
      if (mc < MIN_MC) {
        console.log('[WAIT] ' + info.name + ' | MC trop bas $' + mc);
        continue;
      }
      if (liquidity < MIN_LIQUIDITY) {
        console.log('[WAIT] ' + info.name + ' | Liquidite insuffisante $' + Math.round(liquidity));
        continue;
      }
      if (buys5m < MIN_BUYS_5M) {
        console.log('[WAIT] ' + info.name + ' | Activite faible ' + buys5m + ' buys/5m');
        continue;
      }
      if (priceChange5m < -40) {
        delete watchlist[mint];
        stats.skipped++;
        console.log('[SKIP] ' + info.name + ' — chute ' + priceChange5m + '%/5m (rug probable)');
        continue;
      }

      // Passe tous les filtres — attente du dip avant achat
      delete watchlist[mint];
      if (sniped.has(mint) || positions[mint] || dipWatchlist[mint]) continue;

      const dipTargetMC = Math.round(mc * (1 - DIP_PCT / 100));
      dipWatchlist[mint] = { filterMC: mc, detectedAt: Date.now(), name };

      console.log('[FILTRE OK] ' + name + ' | $' + mc.toLocaleString() + ' MC | Attente dip -' + DIP_PCT + '% → <$' + dipTargetMC.toLocaleString());
      await sendTelegram(
        '🔍 FILTRE PASSE\n==================\n'
        + '🪙 ' + name + '\n'
        + '📊 MC au filtre : $' + mc.toLocaleString() + '\n'
        + '💧 Liquidite : $' + Math.round(liquidity).toLocaleString() + '\n'
        + '📈 Buys 5m : ' + buys5m + '\n'
        + '📊 Variation 5m : ' + priceChange5m + '%\n'
        + '⏱ Age : ' + Math.round(ageSec) + 's\n==================\n'
        + '⏳ Attente correction -' + DIP_PCT + '%\n'
        + '   Cible achat : <$' + dipTargetMC.toLocaleString() + ' MC\n'
        + '   Timeout : ' + MAX_DIP_WAIT_SEC + 's'
      );
    } catch(e) {}

    await new Promise(r => setTimeout(r, 200));
  }
}

// Surveille les tokens filtres et achete sur le dip
async function checkDipWatchlist() {
  const now = Date.now();
  const mints = Object.keys(dipWatchlist);
  if (mints.length === 0) return;

  for (const mint of mints) {
    if (!dipWatchlist[mint]) continue;
    const info = dipWatchlist[mint];
    const ageSec = (now - info.detectedAt) / 1000;

    // Timeout — pas de dip, on abandonne
    if (ageSec > MAX_DIP_WAIT_SEC) {
      delete dipWatchlist[mint];
      console.log('[DIP] ' + info.name + ' — timeout ' + Math.round(ageSec) + 's, pas de dip');
      continue;
    }

    try {
      const { mc } = await getTokenInfo(mint);
      if (!mc) continue;

      // Trop monte depuis le filtre — rate le train
      if (mc > info.filterMC * (1 + MAX_RISE_PCT / 100)) {
        delete dipWatchlist[mint];
        stats.skipped++;
        console.log('[DIP] ' + info.name + ' — trop monte $' + mc.toLocaleString() + ' (+' + Math.round((mc/info.filterMC-1)*100) + '%)');
        continue;
      }

      const dipPct = Math.round((mc / info.filterMC - 1) * 100);
      console.log('[DIP WATCH] ' + info.name + ' | $' + mc.toLocaleString() + ' MC | ' + dipPct + '% depuis filtre');

      // Dip dans la zone achat (-15% a -50%)
      if (dipPct <= -DIP_PCT && dipPct >= -50) {
        delete dipWatchlist[mint];
        if (sniped.has(mint) || positions[mint]) continue;
        if (Object.keys(positions).length >= MAX_OPEN) { stats.skipped++; continue; }

        console.log('[GO DIP] ' + info.name + ' | Dip ' + dipPct + '% | $' + mc.toLocaleString() + ' MC (filtre $' + info.filterMC.toLocaleString() + ')');
        await sendTelegram(
          '📉 DIP DETECTE — ACHAT\n==================\n'
          + '🪙 ' + info.name + '\n'
          + '📊 MC au filtre : $' + info.filterMC.toLocaleString() + '\n'
          + '📉 MC au dip : $' + mc.toLocaleString() + ' (' + dipPct + '%)\n==================\n'
          + '⚡ Achat au prix bas en cours...'
        );
        await snipe(mint, info.name, mc);
      }
    } catch(e) {}

    await new Promise(r => setTimeout(r, 200));
  }
}

function findNewMint(tx) {
  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];
  const newMints = post.map(b => b.mint).filter(mint => !pre.find(b => b.mint === mint));
  return newMints.find(m => m.endsWith('pump')) || null;
}

async function processTxQueue() {
  if (processingQueue) return;
  processingQueue = true;
  while (txQueue.length > 0) {
    const { signature, timestamp } = txQueue.shift();
    // 30s pour trouver le mint (on n'est pas presse — survie 60s obligatoire)
    if (Date.now() - timestamp > 30000) continue;
    try {
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0, commitment: 'confirmed'
      });
      if (!tx || !tx.meta) continue;
      const mint = findNewMint(tx);
      if (!mint || watchlist[mint] || sniped.has(mint)) continue;

      watchlist[mint] = { detectedAt: Date.now(), name: mint.slice(0, 8) };
      console.log('[WATCH] ' + mint.slice(0, 12) + '... en surveillance (attente ' + MIN_WAIT_SEC + 's)');
    } catch(e) { console.log('[QUEUE] Erreur : ' + e.message); }
    await new Promise(r => setTimeout(r, 600));
  }
  processingQueue = false;
}

async function startSniper() {
  const pumpKey = new PublicKey(PUMP_PROGRAM);
  const processedSigs = new Set();

  try {
    const init = await connection.getSignaturesForAddress(pumpKey, { limit: 10, commitment: 'confirmed' });
    init.forEach(s => processedSigs.add(s.signature));
    console.log('[INIT] ' + init.length + ' signatures initiales marquees');
  } catch(e) {}

  let subId = null;
  let retryDelay = 3000;

  async function subscribe() {
    try {
      if (subId !== null) { try { await connection.removeOnLogsListener(subId); } catch(e) {} subId = null; }
      subId = connection.onLogs(pumpKey, (logs) => {
        if (logs.err) return;
        const isCreate = logs.logs.some(l =>
          l.includes('InitializeMint') || l.includes('Instruction: Create') || l.includes('Instruction: Initialize')
        );
        if (!isCreate) return;
        if (processedSigs.has(logs.signature)) return;
        processedSigs.add(logs.signature);
        txQueue.push({ signature: logs.signature, timestamp: Date.now() });
        processTxQueue();
      }, 'confirmed');
      retryDelay = 3000;
      console.log('[WS] Connecte (subId: ' + subId + ')');
    } catch(e) {
      console.log('[WS] Erreur : ' + e.message + ' — retry dans ' + retryDelay / 1000 + 's');
      setTimeout(() => { retryDelay = Math.min(retryDelay * 2, 30000); subscribe(); }, retryDelay);
    }
  }

  await subscribe();
  setInterval(() => subscribe(), 10 * 60 * 1000);

  // Verifier la watchlist toutes les 5 secondes
  setInterval(() => checkWatchlist(), 5000);
  // Verifier les dips toutes les 5 secondes
  setInterval(() => checkDipWatchlist(), 5000);

  console.log('[SNIPER] Actif — filtres 60s — TP x2 — SL -' + SL_PCT + '%');
  await sendTelegram(
    '🎯 SNIPER v5 DEMARRE\n==================\n'
    + '📡 Detection Pump.fun temps reel\n'
    + '⏱ Survie 60 secondes obligatoire\n==================\n'
    + '💰 Mise : $' + MISE_USD + ' par trade\n'
    + '🎯 TP : x2 (+' + TP_PCT + '%) → +$' + (MISE_USD * TP_PCT / 100) + '\n'
    + '🔄 Trailing : actif a +' + TRAILING_ACTIVATE_PCT + '%, coupe -' + TRAILING_PCT + '% du pic\n'
    + '🛑 SL : -' + SL_PCT + '%\n==================\n'
    + '🔍 FILTRES QUALITE\n'
    + '   MC entree : $' + MIN_MC.toLocaleString() + ' - $' + MAX_ENTRY_MC.toLocaleString() + '\n'
    + '   Liquidite : >$' + MIN_LIQUIDITY.toLocaleString() + '\n'
    + '   Activite : >' + MIN_BUYS_5M + ' achats/5min\n'
    + '=================='
  );
}

startSniper();
