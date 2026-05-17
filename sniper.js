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

// CONFIG — strategie MOMENTUM RAPIDE
const MISE_LAMPORTS = 1200000000; // ~1.2 SOL (~$200)
const MISE_USD = 200;
const ENTRY_MC = 5000;            // achat des que le token atteint $5,000 MC
const ENTRY_WINDOW_MIN = 10;      // token doit atteindre $5k en moins de 10 min
const ENTRY_WINDOW_CHECKS = 120;  // 10 min = 120 checks x 5s
const TP_PCT = 100;               // TP +100% → $10,000 MC → +$200
const SL_PCT = 30;                // SL -30% → $3,500 MC → -$60
const TRAILING_ACTIVATE_PCT = 50; // trailing actif apres +50%
const TRAILING_PCT = 15;          // trail -15% depuis pic
const JITO_FEE = 500000;          // 0.0005 SOL priority fee
const MONITOR_INTERVAL = 5000;   // check toutes les 5 sec
const MAX_OPEN = 3;               // max 3 positions ouvertes
const TIMEOUT_CHECKS = 120;      // 10 min apres achat (120 x 5s)
const MAX_WATCH = 200;            // max 200 tokens surveilles en meme temps

const sniped = new Set();
const positions = {};
const watched = {};

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
  const gainBrut = stats.wins * MISE_USD * TP_PCT / 100;
  const perteBrut = stats.losses * MISE_USD * SL_PCT / 100;
  const net = gainBrut - perteBrut;
  const netEmoji = net >= 0 ? '✅' : '🔴';
  const fastest = stats.fastestWinMs < Infinity ? Math.round(stats.fastestWinMs / 1000) + 's (' + stats.fastestToken + ')' : 'N/A';

  let recommandation;
  if (winRate >= 50 && net > 0) {
    recommandation = '💹 RENTABLE — Tu peux augmenter la mise';
  } else if (winRate >= 40 && net >= -MISE_USD) {
    recommandation = '⚖️ NEUTRE — Continue pour plus de donnees';
  } else {
    recommandation = '⚠️ NEGATIF — Reduis la mise ou change de strategie';
  }

  await sendTelegram(
    '📊 BILAN ' + stats.total + ' SNIPES\n'
    + '==================\n'
    + '🏆 Wins (TP) : ' + stats.wins + '\n'
    + '🔴 Losses (SL) : ' + stats.losses + '\n'
    + '📊 Win rate : ' + winRate + '%\n'
    + '==================\n'
    + '💰 Mise par trade : $' + MISE_USD + '\n'
    + '📈 Gains bruts : +$' + gainBrut.toFixed(0) + '\n'
    + '📉 Pertes totales : -$' + perteBrut.toFixed(0) + '\n'
    + netEmoji + ' NET : ' + (net >= 0 ? '+' : '') + '$' + net.toFixed(0) + '\n'
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
          stats.losses++;
          delete positions[mint];
          await sendTelegram(
            '🔴 SNIPE ABANDONNE\n==================\n🪙 ' + name + '\nNon indexe apres 1 min\n==================\nPERTE ESTIMEE : -$' + (MISE_USD * SL_PCT / 100)
          );
          if (stats.total === 10 || stats.total === 20 || stats.total === 30) sendSniperReport();
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
        const gainUSD = ((gainPct / 100) * MISE_USD).toFixed(0);
        if (gainPct > stats.bestGainPct) { stats.bestGainPct = gainPct; stats.bestToken = name; }
        if (gainPct > 0) stats.wins++; else stats.losses++;
        delete positions[mint];
        const sig = await sellToken(mint);
        await sendTelegram(
          '🔄 TRAILING STOP — VENTE AUTO\n==================\n🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n'
          + '📈 Pic : $' + peak.toLocaleString() + ' MC\n'
          + '📊 Sortie : $' + mc.toLocaleString() + ' MC\n==================\n'
          + (gainPct >= 0 ? '💰 Gain' : '📉 Perte') + ' : ' + (gainPct >= 0 ? '+' : '') + gainPct + '% (' + (gainPct >= 0 ? '+$' : '-$') + Math.abs(parseInt(gainUSD)) + ')\n'
          + '⏱ Duree : ' + dureeMin + ' min\n==================\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle requise')
        );
        if (stats.total === 10 || stats.total === 20 || stats.total === 30) sendSniperReport();
        return;
      }

      // TAKE PROFIT
      if (gainPct >= TP_PCT) {
        clearInterval(interval);
        const gainUSD = ((gainPct / 100) * MISE_USD).toFixed(0);
        const dureeMs = Date.now() - buyTime;
        if (dureeMs < stats.fastestWinMs) { stats.fastestWinMs = dureeMs; stats.fastestToken = name; }
        if (gainPct > stats.bestGainPct) { stats.bestGainPct = gainPct; stats.bestToken = name; }
        stats.wins++;
        delete positions[mint];
        const sig = await sellToken(mint);
        await sendTelegram(
          '🏆 TP ATTEINT — VENTE AUTO\n==================\n🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n'
          + '📊 Sortie : $' + mc.toLocaleString() + ' MC\n'
          + '📈 Pic : $' + peak.toLocaleString() + ' MC\n==================\n'
          + '💰 Gain : +' + gainPct + '% (+$' + gainUSD + ')\n'
          + '💵 Valeur finale : $' + (MISE_USD + parseInt(gainUSD)) + '\n'
          + '⏱ Duree : ' + dureeMin + ' min\n==================\n'
          + 'BENEFICE NET : +$' + gainUSD + '\n==================\n'
          + '📊 https://dexscreener.com/solana/' + mint + '\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle requise')
        );
        if (stats.total === 10 || stats.total === 20 || stats.total === 30) sendSniperReport();
        return;
      }

      // STOP LOSS
      if (gainPct <= -SL_PCT) {
        clearInterval(interval);
        const perteUSD = Math.abs((gainPct / 100) * MISE_USD).toFixed(0);
        stats.losses++;
        delete positions[mint];
        const sig = await sellToken(mint);
        await sendTelegram(
          '🔴 STOP LOSS — VENTE AUTO\n==================\n🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n'
          + '📊 Sortie : $' + mc.toLocaleString() + ' MC\n==================\n'
          + '📉 Perte : ' + gainPct + '% (-$' + perteUSD + ')\n'
          + '⏱ Duree : ' + dureeMin + ' min\n==================\n'
          + 'PERTE NETTE : -$' + perteUSD + '\n==================\n'
          + '📊 https://dexscreener.com/solana/' + mint + '\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle requise')
        );
        if (stats.total === 10 || stats.total === 20 || stats.total === 30) sendSniperReport();
        return;
      }

      // TIMEOUT 10 min
      if (checks >= TIMEOUT_CHECKS) {
        clearInterval(interval);
        const gainUSD = ((gainPct / 100) * MISE_USD).toFixed(0);
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

async function snipe(mint, tokenName, entryMCDetected) {
  if (positions[mint]) return;
  if (Object.keys(positions).length >= MAX_OPEN) return;
  positions[mint] = { status: 'buying' };

  for (let i = 1; i <= 3; i++) {
    try {
      const qr = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=' + SOL + '&outputMint=' + mint + '&amount=' + MISE_LAMPORTS + '&slippageBps=1000');
      const q = await qr.json();
      if (!q.outAmount) {
        if (i === 3) {
          delete positions[mint];
          await sendTelegram('❌ SNIPE ECHOUE\n🪙 ' + tokenName + '\nNon swappable sur Jupiter');
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
      positions[mint] = { status: 'open', buyTime, sig };
      stats.total++;
      sniped.add(mint);

      const tpMC = Math.round(entryMCDetected * (1 + TP_PCT / 100));
      const slMC = Math.round(entryMCDetected * (1 - SL_PCT / 100));

      await sendTelegram(
        '🚀 MOMENTUM SNIPE\n==================\n'
        + '🪙 ' + tokenName + '\n'
        + '⚡ $' + ENTRY_MC.toLocaleString() + ' MC atteint en < ' + ENTRY_WINDOW_MIN + ' min\n==================\n'
        + '💰 Mise : $' + MISE_USD + '\n'
        + '🎯 TP : $' + tpMC.toLocaleString() + ' MC (+' + TP_PCT + '%) → +$' + (MISE_USD * TP_PCT / 100) + '\n'
        + '🛑 SL : $' + slMC.toLocaleString() + ' MC (-' + SL_PCT + '%) → -$' + (MISE_USD * SL_PCT / 100) + '\n'
        + '🔄 Trailing : -' + TRAILING_PCT + '% du pic (actif a +' + TRAILING_ACTIVATE_PCT + '%)\n'
        + '==================\n'
        + '🔗 https://solscan.io/tx/' + sig + '\n'
        + '📊 https://dexscreener.com/solana/' + mint
      );

      monitorSnipe(mint, tokenName, buyTime);
      break;
    } catch(e) {
      console.log('Tentative ' + i + ' : ' + e.message);
      if (i === 3) delete positions[mint];
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function watchToken(mint) {
  if (watched[mint] || sniped.has(mint)) return;
  if (Object.keys(watched).length >= MAX_WATCH) return;

  watched[mint] = { checks: 0, name: mint.slice(0, 8) };

  const interval = setInterval(async () => {
    try {
      if (!watched[mint]) { clearInterval(interval); return; }
      const w = watched[mint];
      w.checks++;

      // Abandon apres 10 min sans atteindre $5k (pas de momentum)
      if (w.checks >= ENTRY_WINDOW_CHECKS) {
        clearInterval(interval);
        delete watched[mint];
        return;
      }

      const { mc, name } = await getTokenInfo(mint);
      if (name && name !== mint.slice(0, 8)) w.name = name;
      if (!mc) return;

      // Signal : le token atteint $5,000 MC en moins de 10 min
      if (mc >= ENTRY_MC) {
        clearInterval(interval);
        const tokenName = w.name;
        const minutesElapsed = Math.round((w.checks * MONITOR_INTERVAL) / 60000);
        delete watched[mint];

        if (Object.keys(positions).length >= MAX_OPEN) {
          console.log('[WATCH] ' + tokenName + ' — $5k atteint mais max positions');
          return;
        }

        console.log('[SNIPER] MOMENTUM : ' + tokenName + ' | $' + mc.toLocaleString() + ' MC en ' + minutesElapsed + ' min');
        await snipe(mint, tokenName, mc);
      }
    } catch(e) {}
  }, MONITOR_INTERVAL);
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

    try {
      const tx = await connection.getParsedTransaction(logs.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed'
      });
      if (!tx || !tx.meta) return;

      const mint = findNewMint(tx);
      if (!mint) return;

      await watchToken(mint);
    } catch(e) {
      console.log('[SNIPER] Erreur : ' + e.message);
    }
  }, 'confirmed');

  console.log('Sniper MOMENTUM actif — achat a $' + ENTRY_MC.toLocaleString() + ' MC en < ' + ENTRY_WINDOW_MIN + ' min');
  await sendTelegram(
    '🚀 SNIPER MOMENTUM DEMARRE\n==================\n'
    + '📡 Surveillance : tous les nouveaux tokens Pump.fun\n'
    + '⚡ Signal : $' + ENTRY_MC.toLocaleString() + ' MC atteint en < ' + ENTRY_WINDOW_MIN + ' min\n==================\n'
    + '💰 Mise : $' + MISE_USD + ' par trade\n'
    + '🎯 TP : +' + TP_PCT + '% → +$' + (MISE_USD * TP_PCT / 100) + '\n'
    + '🛑 SL : -' + SL_PCT + '% → -$' + (MISE_USD * SL_PCT / 100) + '\n'
    + '🔄 Trailing : -' + TRAILING_PCT + '% du pic (actif a +' + TRAILING_ACTIVATE_PCT + '%)\n'
    + '🔢 Max positions : ' + MAX_OPEN + '\n'
    + '=================='
  );
}

startSniper();
