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

// CONFIG — $200 mise, +$20 profit cible
const MISE_LAMPORTS = 1200000000; // ~1.2 SOL (~$200)
const MISE_USD = 200;
const TP_PCT = 10;   // +10% = +$20
const SL_PCT = 10;   // -10% = -$20 (risque/recompense 1:1)
const JITO_FEE = 500000;
const JITO_TIP = 1000000;
const MONITOR_INTERVAL = 5000;
const MAX_OPEN = 3;

// Filtres — donnees Pump.fun directes (pas de delai DexScreener)
const MIN_AGE_SEC = 15;         // au moins 15s (evite les rugs immediats)
const MAX_AGE_SEC = 300;        // max 5 minutes
const MIN_MC = 5000;            // MC minimum $5k
const MAX_MC = 80000;           // MC maximum $80k
const MAX_LAST_TRADE_SEC = 60;  // trade dans les 60 dernieres secondes
const SCAN_INTERVAL = 8000;     // scan toutes les 8 secondes

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

// Pump.fun API — deux listes : plus recents + plus actifs
async function getPumpTokens() {
  try {
    const [r1, r2] = await Promise.all([
      fetch('https://frontend-api.pump.fun/coins?sort=created_timestamp&order=DESC&offset=0&limit=100',
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }),
      fetch('https://frontend-api.pump.fun/coins?sort=last_trade_unix_time&order=DESC&offset=0&limit=100',
        { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } })
    ]);
    const list1 = r1.ok ? await r1.json() : [];
    const list2 = r2.ok ? await r2.json() : [];
    // Fusionner sans doublons
    const seen = new Set();
    const merged = [];
    for (const coin of [...list1, ...list2]) {
      if (coin.mint && !seen.has(coin.mint)) { seen.add(coin.mint); merged.push(coin); }
    }
    return merged;
  } catch(e) { return []; }
}

async function getPumpCoin(mint) {
  try {
    const r = await fetch('https://frontend-api.pump.fun/coins/' + mint,
      { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } }
    );
    if (!r.ok) return null;
    return await r.json();
  } catch(e) { return null; }
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
  const tpMC = Math.round(entryMC * (1 + TP_PCT / 100));
  const slMC = Math.round(entryMC * (1 - SL_PCT / 100));

  const interval = setInterval(async () => {
    try {
      checks++;
      // Surveillance via Pump.fun API — plus rapide que DexScreener pour nouveaux tokens
      const coin = await getPumpCoin(mint);
      const mc = coin ? Math.round(coin.usd_market_cap || 0) : 0;

      if (!mc) {
        if (checks >= 24) { // 2 minutes sans donnees = rug
          clearInterval(interval);
          const lossUSD = MISE_USD * SL_PCT / 100;
          stats.losses++;
          stats.totalLossUSD += lossUSD;
          delete positions[mint];
          await sendTelegram('🔴 ABANDON\n🪙 ' + name + '\nRug probable\nPERTE : -$' + lossUSD);
          if (stats.total % 10 === 0) sendSniperReport();
        }
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
        const sig = await sellToken(mint);
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
        const sig = await sellToken(mint);
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
      console.log('[SCAN] Aucun token recu de Pump.fun API');
      return;
    }

    const now = Date.now() / 1000;
    let total = 0, tooYoung = 0, tooOld = 0, mcTooLow = 0, mcTooHigh = 0, inactive = 0, candidates = 0;

    for (const coin of tokens) {
      if (!coin.mint || sniped.has(coin.mint) || positions[coin.mint]) continue;
      total++;

      // Pump.fun: created_timestamp en millisecondes
      const createdSec = coin.created_timestamp > 1e12 ? coin.created_timestamp / 1000 : coin.created_timestamp;
      const ageSec = now - createdSec;
      const mc = Math.round(coin.usd_market_cap || 0);
      const lastTradeSec = now - (coin.last_trade_unix_time || 0);
      const name = coin.symbol || coin.name || coin.mint.slice(0, 8);

      if (ageSec < MIN_AGE_SEC) { tooYoung++; continue; }
      if (ageSec > MAX_AGE_SEC) { tooOld++; continue; }
      if (mc < MIN_MC) { mcTooLow++; continue; }
      if (mc > MAX_MC) { mcTooHigh++; continue; }
      if (lastTradeSec > MAX_LAST_TRADE_SEC) { inactive++; continue; }
      if (coin.complete) continue;

      candidates++;
      console.log('[CANDIDAT] ' + name + ' | $' + mc.toLocaleString() + ' MC | age ' + Math.round(ageSec) + 's | trade il y a ' + Math.round(lastTradeSec) + 's');

      if (Object.keys(positions).length >= MAX_OPEN) { stats.skipped++; continue; }

      await sendTelegram(
        '🔍 CANDIDAT TROUVE\n==================\n'
        + '🪙 ' + name + '\n'
        + '📊 MC : $' + mc.toLocaleString() + '\n'
        + '⏱ Age : ' + Math.round(ageSec) + 's\n'
        + '🔄 Dernier trade : il y a ' + Math.round(lastTradeSec) + 's\n==================\n'
        + '⚡ Achat via Jito...'
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
  await sendTelegram(
    '🎯 SNIPER v8 DEMARRE\n==================\n'
    + '📡 Scan Pump.fun direct (pas de delai)\n==================\n'
    + '⏱ Fenetre : ' + MIN_AGE_SEC + 's - ' + MAX_AGE_SEC + 's\n'
    + '📊 MC : $' + MIN_MC.toLocaleString() + ' - $' + MAX_MC.toLocaleString() + '\n'
    + '🔄 Activite : trade < ' + MAX_LAST_TRADE_SEC + 's\n==================\n'
    + '💰 Mise : $' + MISE_USD + '\n'
    + '🎯 TP : +' + TP_PCT + '% = +$' + (MISE_USD * TP_PCT / 100) + '\n'
    + '🛑 SL : -' + SL_PCT + '% = -$' + (MISE_USD * SL_PCT / 100) + '\n'
    + '⚡ Jito bundles actifs\n'
    + '📊 Rapport toutes les 10 snipes\n'
    + '=================='
  );

  // Scan toutes les 8 secondes
  setInterval(() => scanPumpFun(), SCAN_INTERVAL);
  // Premier scan immediat
  scanPumpFun();
}

startSniper();
