if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const { Connection, PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const http = require('http');

const server = http.createServer((req, res) => { res.writeHead(200); res.end('SNIPER OK'); });
server.listen(3001);

const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=' + process.env.HELIUS_API_KEY, 'confirmed');
const myWallet = Keypair.fromSecretKey(bs58.default.decode(process.env.PRIVATE_KEY));
const SOL = 'So11111111111111111111111111111111111111112';
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// CONFIG SNIPER
const MISE_LAMPORTS = 10000000;  // 0.01 SOL par snipe (~$1.5)
const MISE_USD = 10;             // affichage $10 (ajuste selon prix SOL)
const TP_PCT = 150;              // TP a +150%
const SL_PCT = 40;               // SL a -40%
const TRAILING_ACTIVATE_PCT = 50;// trailing actif apres +50%
const TRAILING_PCT = 25;         // trail -25% depuis pic
const JITO_FEE = 500000;         // 0.0005 SOL priority fee agressif
const MONITOR_INTERVAL = 10000; // check toutes les 10 sec
const MAX_OPEN = 3;              // max 3 positions en meme temps
const TIMEOUT_CHECKS = 60;       // 10 min max par position

const sniped = new Set();
const positions = {};

const stats = {
  total: 0,
  wins: 0,
  losses: 0,
  bestGainPct: 0,
  bestToken: '',
  fastestWinMs: Infinity,
  fastestToken: ''
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
      myWallet.publicKey,
      { mint: new PublicKey(mint) }
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
      body: JSON.stringify({
        quoteResponse: q,
        userPublicKey: myWallet.publicKey.toString(),
        wrapAndUnwrapSol: true,
        prioritizationFeeLamports: JITO_FEE
      })
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
  const gainBrut = (stats.wins * MISE_USD * TP_PCT / 100).toFixed(2);
  const perteBrut = (stats.losses * MISE_USD * SL_PCT / 100).toFixed(2);
  const net = (parseFloat(gainBrut) - parseFloat(perteBrut)).toFixed(2);
  const netEmoji = parseFloat(net) >= 0 ? '✅' : '🔴';
  const fastest = stats.fastestWinMs < Infinity ? Math.round(stats.fastestWinMs / 1000) + 's (' + stats.fastestToken + ')' : 'N/A';
  await sendTelegram(
    '📊 RAPPORT SNIPER — ' + stats.total + ' SNIPES\n'
    + '==================\n'
    + '🏆 TP atteint : ' + stats.wins + ' (' + winRate + '%)\n'
    + '🔴 Stop loss : ' + stats.losses + '\n'
    + '==================\n'
    + '💰 Mise par snipe : $' + MISE_USD + '\n'
    + '📈 Gains bruts : +$' + gainBrut + '\n'
    + '📉 Pertes : -$' + perteBrut + '\n'
    + netEmoji + ' NET : ' + (parseFloat(net) >= 0 ? '+' : '') + '$' + net + '\n'
    + '==================\n'
    + '🥇 Meilleur gain : +' + stats.bestGainPct + '% (' + (stats.bestToken || 'N/A') + ')\n'
    + '⚡ Snipe le + rapide : ' + fastest + '\n'
    + '==================\n'
    + 'Win rate : ' + winRate + '%\n'
    + '=================='
  );
}

async function monitorSnipe(mint, name, buyTime) {
  let entryMC = null;
  let peak = 0;
  let trailingActive = false;
  let checks = 0;

  // Laisse 15s pour que DexScreener indexe le token
  await new Promise(r => setTimeout(r, 15000));

  const interval = setInterval(async () => {
    try {
      checks++;
      const { mc, price } = await getTokenInfo(mint);

      // Pas encore indexe
      if (!mc) {
        if (checks >= 6) {
          // 1 min sans donnees = rug probable
          clearInterval(interval);
          stats.losses++;
          delete positions[mint];
          await sendTelegram(
            '🔴 SNIPE ABANDONNE\n==================\n🪙 ' + name + '\nNon indexe apres 1 min\nRug probable\n==================\nPERTE ESTIMEE : -$' + (MISE_USD * SL_PCT / 100).toFixed(2)
          );
          if (stats.total % 5 === 0) sendSniperReport();
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
      console.log('[SNIPER] ' + name + ' | $' + mc.toLocaleString() + ' | ' + (gainPct >= 0 ? '+' : '') + gainPct + '% | Pic $' + peak.toLocaleString());

      // TRAILING STOP
      if (trailingActive && mc <= peak * (1 - TRAILING_PCT / 100)) {
        clearInterval(interval);
        const gainUSD = ((gainPct / 100) * MISE_USD).toFixed(2);
        if (gainPct > stats.bestGainPct) { stats.bestGainPct = gainPct; stats.bestToken = name; }
        if (gainPct > 0) stats.wins++; else stats.losses++;
        delete positions[mint];
        const sig = await sellToken(mint);
        await sendTelegram(
          '🔄 TRAILING STOP — VENTE AUTO\n==================\n🪙 ' + name + '\n📈 Pic : $' + peak.toLocaleString() + ' MC\n📊 Sortie : $' + mc.toLocaleString() + ' MC\n'
          + (gainPct >= 0 ? '💰 Gain' : '📉 Perte') + ' : ' + (gainPct >= 0 ? '+' : '') + gainPct + '% (' + (gainPct >= 0 ? '+$' : '-$') + Math.abs(parseFloat(gainUSD)).toFixed(2) + ')\n'
          + '⏱ Duree : ' + dureeMin + ' min\n==================\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle requise')
        );
        if (stats.total % 5 === 0) sendSniperReport();
        return;
      }

      // TAKE PROFIT
      if (gainPct >= TP_PCT) {
        clearInterval(interval);
        const gainUSD = ((gainPct / 100) * MISE_USD).toFixed(2);
        const dureeMs = Date.now() - buyTime;
        if (dureeMs < stats.fastestWinMs) { stats.fastestWinMs = dureeMs; stats.fastestToken = name; }
        if (gainPct > stats.bestGainPct) { stats.bestGainPct = gainPct; stats.bestToken = name; }
        stats.wins++;
        delete positions[mint];
        const sig = await sellToken(mint);
        await sendTelegram(
          '🏆 TP ATTEINT — VENTE AUTO\n==================\n🪙 ' + name + '\n💰 Mise : $' + MISE_USD + '\n==================\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n'
          + '📊 Sortie : $' + mc.toLocaleString() + ' MC\n'
          + '📈 Pic : $' + peak.toLocaleString() + ' MC\n==================\n'
          + '💰 Gain : +' + gainPct + '% (+$' + gainUSD + ')\n'
          + '💵 Valeur finale : $' + (MISE_USD + parseFloat(gainUSD)).toFixed(2) + '\n'
          + '⏱ Duree : ' + dureeMin + ' min\n==================\n'
          + 'BENEFICE NET : +$' + gainUSD + '\n==================\n'
          + '📊 https://dexscreener.com/solana/' + mint + '\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle requise')
        );
        if (stats.total % 5 === 0) sendSniperReport();
        return;
      }

      // STOP LOSS
      if (gainPct <= -SL_PCT) {
        clearInterval(interval);
        const perteUSD = Math.abs((gainPct / 100) * MISE_USD).toFixed(2);
        stats.losses++;
        delete positions[mint];
        const sig = await sellToken(mint);
        await sendTelegram(
          '🔴 STOP LOSS — VENTE AUTO\n==================\n🪙 ' + name + '\n💰 Mise : $' + MISE_USD + '\n==================\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n'
          + '📊 Sortie : $' + mc.toLocaleString() + ' MC\n'
          + '📈 Pic : $' + peak.toLocaleString() + ' MC\n==================\n'
          + '📉 Perte : ' + gainPct + '% (-$' + perteUSD + ')\n'
          + '⏱ Duree : ' + dureeMin + ' min\n==================\n'
          + 'PERTE NETTE : -$' + perteUSD + '\n==================\n'
          + '📊 https://dexscreener.com/solana/' + mint + '\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle requise')
        );
        if (stats.total % 5 === 0) sendSniperReport();
        return;
      }

      // TIMEOUT 10 min
      if (checks >= TIMEOUT_CHECKS) {
        clearInterval(interval);
        const gainUSD = ((gainPct / 100) * MISE_USD).toFixed(2);
        if (gainPct > 0) stats.wins++; else stats.losses++;
        delete positions[mint];
        const sig = await sellToken(mint);
        await sendTelegram(
          '⏱ TIMEOUT 10 MIN — VENTE AUTO\n==================\n🪙 ' + name + '\n'
          + (gainPct >= 0 ? '💰 Gain' : '📉 Perte') + ' : ' + (gainPct >= 0 ? '+' : '') + gainPct + '%\n==================\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle requise')
        );
      }
    } catch(e) {}
  }, MONITOR_INTERVAL);
}

async function snipe(mint, parseTimeMs, detectTime) {
  if (positions[mint]) return;
  if (Object.keys(positions).length >= MAX_OPEN) {
    console.log('Max ' + MAX_OPEN + ' positions, snipe ignore : ' + mint.slice(0, 8));
    return;
  }
  positions[mint] = { status: 'buying' };

  for (let i = 1; i <= 3; i++) {
    try {
      const qr = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=' + SOL + '&outputMint=' + mint + '&amount=' + MISE_LAMPORTS + '&slippageBps=1000');
      const q = await qr.json();
      if (!q.outAmount) {
        if (i === 3) {
          delete positions[mint];
          await sendTelegram('❌ SNIPE ECHOUE\n==================\n🪙 ' + mint.slice(0, 8) + '...pump\nNon listable sur Jupiter\n(trop recent — liquidite absente)\n==================');
        }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      const sr = await fetch('https://api.jup.ag/swap/v1/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quoteResponse: q,
          userPublicKey: myWallet.publicKey.toString(),
          wrapAndUnwrapSol: true,
          prioritizationFeeLamports: JITO_FEE
        })
      });
      const sd = await sr.json();
      if (!sd.swapTransaction) continue;

      const buf = Buffer.from(sd.swapTransaction, 'base64');
      const vtx = VersionedTransaction.deserialize(buf);
      vtx.sign([myWallet]);
      const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 5 });

      const buyTime = Date.now();
      const latencyTotal = buyTime - detectTime;
      positions[mint] = { status: 'open', buyTime, sig };
      stats.total++;

      let name = mint.slice(0, 8) + '...pump';
      try {
        const info = await getTokenInfo(mint);
        if (info.name && info.name !== mint.slice(0, 8)) name = info.name;
      } catch(e) {}

      await sendTelegram(
        '🎯 SNIPE EXECUTE\n==================\n🪙 ' + name + '\n==================\n'
        + '⚡ Latence totale : ' + latencyTotal + 'ms\n'
        + '   Detection tx : ' + parseTimeMs + 'ms\n'
        + '   Execution swap : ' + (latencyTotal - parseTimeMs) + 'ms\n'
        + '==================\n'
        + '💰 Mise : $' + MISE_USD + '\n'
        + '==================\n'
        + '🎯 TP : +' + TP_PCT + '% → +$' + (MISE_USD * TP_PCT / 100).toFixed(2) + '\n'
        + '🛑 SL : -' + SL_PCT + '% → -$' + (MISE_USD * SL_PCT / 100).toFixed(2) + '\n'
        + '🔄 Trailing : -' + TRAILING_PCT + '% du pic (actif a +' + TRAILING_ACTIVATE_PCT + '%)\n'
        + '==================\n'
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

function findNewMint(tx) {
  const pre = tx.meta.preTokenBalances || [];
  const post = tx.meta.postTokenBalances || [];
  const newMints = post
    .map(b => b.mint)
    .filter(mint => !pre.find(b => b.mint === mint));
  return newMints.find(m => m.endsWith('pump')) || null;
}

async function startSniper() {
  const pumpKey = new PublicKey(PUMP_PROGRAM);

  connection.onLogs(pumpKey, async (logs) => {
    if (logs.err) return;

    const isCreate = logs.logs.some(l =>
      l.includes('InitializeMint') ||
      l.includes('Instruction: Create') ||
      l.includes('Instruction: Initialize')
    );
    if (!isCreate) return;
    if (sniped.has(logs.signature)) return;
    sniped.add(logs.signature);

    const detectTime = Date.now();

    try {
      const tx = await connection.getParsedTransaction(logs.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });
      if (!tx || !tx.meta) return;

      const mint = findNewMint(tx);
      if (!mint) return;

      const parseTimeMs = Date.now() - detectTime;
      console.log('[SNIPER] Nouveau token detecte : ' + mint.slice(0, 12) + '... (' + parseTimeMs + 'ms)');

      await snipe(mint, parseTimeMs, detectTime);
    } catch(e) {
      console.log('[SNIPER] Erreur : ' + e.message);
    }
  }, 'confirmed');

  console.log('Sniper Pump.fun actif');
  await sendTelegram(
    '🎯 SNIPER PUMP.FUN DEMARRE\n==================\n'
    + '💰 Mise : $' + MISE_USD + ' par snipe\n'
    + '🎯 TP : +' + TP_PCT + '%\n'
    + '🛑 SL : -' + SL_PCT + '%\n'
    + '🔄 Trailing : -' + TRAILING_PCT + '% (actif a +' + TRAILING_ACTIVATE_PCT + '%)\n'
    + '⚡ Priority fee : ' + (JITO_FEE / 1000000).toFixed(4) + ' SOL\n'
    + '🔢 Max positions : ' + MAX_OPEN + '\n'
    + '=================='
  );
}

startSniper();
