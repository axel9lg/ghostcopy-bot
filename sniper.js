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
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// CONFIG — new pairs, fenetre 3 min, MC >= $8k
const MISE_LAMPORTS = 1200000000; // ~1.2 SOL (~$200)
const MISE_USD = 200;
const TP_PCT = 100;               // x2 depuis l entree
const SL_PCT = 30;                // stop loss -30%
const TRAILING_ACTIVATE_PCT = 50; // trailing actif des +50%
const TRAILING_PCT = 20;          // coupe -20% depuis pic
const JITO_FEE = 500000;
const JITO_TIP = 1000000;         // 0.001 SOL tip Jito
const MONITOR_INTERVAL = 5000;
const MAX_OPEN = 3;

// Filtres new pairs
const MIN_MC = 8000;        // MC minimum $8k
const MAX_AGE_SEC = 180;    // fenetre max 3 minutes
const MIN_LIQUIDITY = 1000; // liquidite minimum $1k

// Jito block engine
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
const watchlist = {}; // { mint: { detectedAt, name } }

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
        liquidity: p.liquidity?.usd || 0
      };
    }
    return { mc: 0, price: 0, name: mint.slice(0, 8), liquidity: 0 };
  } catch(e) {
    return { mc: 0, price: 0, name: mint.slice(0, 8), liquidity: 0 };
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
    return await submitViaJito(vtx);
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
  else if (winRate >= 35) recommandation = '⚖️ NEUTRE — Continue pour plus de donnees';
  else recommandation = '⚠️ NEGATIF — Le marche est difficile, patience';

  await sendTelegram(
    '📊 BILAN ' + stats.total + ' SNIPES\n'
    + '==================\n'
    + '🏆 Wins : ' + stats.wins + ' | 🔴 Losses : ' + stats.losses + '\n'
    + '📊 Win rate : ' + winRate + '%\n'
    + '🚫 Fenetre fermee : ' + stats.skipped + '\n'
    + '==================\n'
    + '💰 Mise : $' + MISE_USD + ' | TP : x2 | SL : -' + SL_PCT + '%\n'
    + '📈 Gains : +$' + stats.totalGainUSD.toFixed(0) + '\n'
    + '📉 Pertes : -$' + stats.totalLossUSD.toFixed(0) + '\n'
    + netEmoji + ' NET : ' + (net >= 0 ? '+' : '') + '$' + net.toFixed(0) + '\n'
    + '==================\n'
    + '🥇 Meilleur gain : +' + stats.bestGainPct + '% (' + (stats.bestToken || 'N/A') + ')\n'
    + '⚡ Win le plus rapide : ' + fastest + '\n'
    + '==================\n'
    + recommandation
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
          await sendTelegram('🔴 ABANDON\n🪙 ' + name + '\nPlus de liquidite\nPERTE ESTIMEE : -$' + lossUSD);
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
      console.log('[POS] ' + name + ' | $' + mc.toLocaleString() + ' MC | ' + (gainPct >= 0 ? '+' : '') + gainPct + '% | Pic $' + peak.toLocaleString() + (trailingActive ? ' [TRAIL]' : ''));

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
      const sig = await submitViaJito(vtx);

      const buyTime = Date.now();
      positions[mint] = { status: 'open', buyTime, sig };
      stats.total++;
      sniped.add(mint);

      const tpMC = Math.round(entryMC * 2);
      const slMC = Math.round(entryMC * (1 - SL_PCT / 100));

      await sendTelegram(
        '🎯 SNIPE EXECUTE\n==================\n'
        + '🪙 ' + name + '\n'
        + '📊 MC entree : $' + entryMC.toLocaleString() + '\n==================\n'
        + '💰 Mise : $' + MISE_USD + '\n'
        + '🎯 TP : x2 → $' + tpMC.toLocaleString() + ' MC (+$' + (MISE_USD * TP_PCT / 100) + ')\n'
        + '🛑 SL : -' + SL_PCT + '% → $' + slMC.toLocaleString() + ' MC (-$' + (MISE_USD * SL_PCT / 100) + ')\n'
        + '🔄 Trailing : actif a +' + TRAILING_ACTIVATE_PCT + '%\n==================\n'
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

// Surveille les nouveaux tokens — fenetre 3 min, MC >= $8k
async function checkWatchlist() {
  const now = Date.now();
  const mints = Object.keys(watchlist);
  if (mints.length === 0) return;

  for (const mint of mints) {
    if (!watchlist[mint]) continue;
    const info = watchlist[mint];
    const ageSec = (now - info.detectedAt) / 1000;

    // Fenetre 3 min fermee
    if (ageSec > MAX_AGE_SEC) {
      delete watchlist[mint];
      stats.skipped++;
      console.log('[EXPIRE] ' + info.name + ' — 3 min ecoules sans atteindre $' + MIN_MC.toLocaleString());
      continue;
    }

    try {
      const { mc, name, liquidity } = await getTokenInfo(mint);
      if (name && name !== mint.slice(0, 8)) info.name = name;

      // Pas encore indexe sur DexScreener
      if (!mc) {
        console.log('[WAIT] ' + info.name + ' | age ' + Math.round(ageSec) + 's | pas encore indexe...');
        continue;
      }

      const remainingSec = Math.round(MAX_AGE_SEC - ageSec);
      console.log('[CHECK] ' + info.name + ' | $' + mc.toLocaleString() + ' MC | age ' + Math.round(ageSec) + 's | ' + remainingSec + 's restantes');

      // MC pas encore a $8k
      if (mc < MIN_MC) continue;

      // MC OK, liquidite insuffisante
      if (liquidity < MIN_LIQUIDITY) {
        console.log('[WAIT] ' + info.name + ' | MC ok $' + mc.toLocaleString() + ' mais liquidite faible $' + Math.round(liquidity));
        continue;
      }

      // Tout OK — achat dans la fenetre 3 min
      delete watchlist[mint];
      if (sniped.has(mint) || positions[mint]) continue;
      if (Object.keys(positions).length >= MAX_OPEN) { stats.skipped++; continue; }

      console.log('[GO] ' + name + ' | $' + mc.toLocaleString() + ' MC | age ' + Math.round(ageSec) + 's | ' + remainingSec + 's restantes');
      await sendTelegram(
        '🆕 NEW PAIR VALIDE\n==================\n'
        + '🪙 ' + name + '\n'
        + '📊 MC : $' + mc.toLocaleString() + '\n'
        + '💧 Liquidite : $' + Math.round(liquidity).toLocaleString() + '\n'
        + '⏱ Age : ' + Math.round(ageSec) + 's (' + remainingSec + 's restantes)\n==================\n'
        + '⚡ Achat via Jito...'
      );
      await snipe(mint, name, mc);
    } catch(e) {}

    await new Promise(r => setTimeout(r, 300));
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
    // Deja trop vieux pour la fenetre 3 min
    if (Date.now() - timestamp > MAX_AGE_SEC * 1000) continue;
    try {
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0, commitment: 'confirmed'
      });
      if (!tx || !tx.meta) continue;
      const mint = findNewMint(tx);
      if (!mint || watchlist[mint] || sniped.has(mint)) continue;

      watchlist[mint] = { detectedAt: Date.now(), name: mint.slice(0, 8) };
      console.log('[NEW] ' + mint.slice(0, 12) + '... — fenetre 3 min ouverte');
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

  // Verifier la watchlist toutes les 10 secondes
  setInterval(() => checkWatchlist(), 10000);

  console.log('[SNIPER] Actif — new pairs MC >$' + MIN_MC.toLocaleString() + ' — fenetre ' + MAX_AGE_SEC + 's');
  await sendTelegram(
    '🎯 SNIPER v7 DEMARRE\n==================\n'
    + '📡 Detection new pairs Pump.fun\n==================\n'
    + '⏱ Fenetre : ' + (MAX_AGE_SEC / 60) + ' minutes max\n'
    + '📊 MC minimum : $' + MIN_MC.toLocaleString() + '\n'
    + '💧 Liquidite min : $' + MIN_LIQUIDITY.toLocaleString() + '\n==================\n'
    + '💰 Mise : $' + MISE_USD + ' par trade\n'
    + '🎯 TP : x2 (+$' + (MISE_USD * TP_PCT / 100) + ')\n'
    + '🔄 Trailing : actif a +' + TRAILING_ACTIVATE_PCT + '%\n'
    + '🛑 SL : -' + SL_PCT + '%\n'
    + '⚡ Jito bundles actifs\n'
    + '📊 Rapport toutes les 10 snipes\n'
    + '=================='
  );
}

startSniper();
