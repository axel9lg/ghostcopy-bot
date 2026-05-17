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

// CONFIG
const MISE_LAMPORTS = 1200000000; // ~1.2 SOL (~$200)
const MISE_USD = 200;
const TP_PCT = 50;                // +50% = +$100 de benefice
const SL_PCT = 25;                // -25% = -$50
const MIN_ENTRY_MC = 2000;        // entrer a partir de $2,000 MC (tres tot)
const MAX_ENTRY_MC = 8000;        // refuser si MC > $8,000 (trop tard)
const MIN_LIQUIDITY = 500;        // liquidite minimum pour que le swap marche
const TRAILING_ACTIVATE_PCT = 30; // trailing actif apres +30%
const TRAILING_PCT = 15;          // trail -15% depuis pic
const JITO_FEE = 500000;          // 0.0005 SOL priority fee
const MONITOR_INTERVAL = 5000;   // check toutes les 5 sec
const MAX_OPEN = 3;               // max 3 positions ouvertes
const TIMEOUT_CHECKS = 60;        // 5 min max apres achat
const VALIDATION_CHECKS = 12;     // 60s max pour valider le token (12 x 5s)
const MAX_WATCH = 200;

const sniped = new Set();
const positions = {};
const watched = {};

const stats = {
  total: 0,
  wins: 0,
  losses: 0,
  skipped: 0,
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
    + '🚫 Ignores (trop tard/no data) : ' + stats.skipped + '\n'
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
            '🔴 ABANDON\n==================\n🪙 ' + name + '\nNon indexe apres 1 min\n==================\nPERTE ESTIMEE : -$' + (MISE_USD * SL_PCT / 100)
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
          '🔄 TRAILING STOP\n==================\n🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n'
          + '📈 Pic : $' + peak.toLocaleString() + ' MC\n'
          + '📊 Sortie : $' + mc.toLocaleString() + ' MC\n==================\n'
          + (gainPct >= 0 ? '💰 Gain' : '📉 Perte') + ' : ' + (gainPct >= 0 ? '+' : '') + gainPct + '% (' + (gainPct >= 0 ? '+$' : '-$') + Math.abs(parseInt(gainUSD)) + ')\n'
          + '⏱ Duree : ' + dureeMin + ' min\n'
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
          '🏆 TP ATTEINT\n==================\n🪙 ' + name + '\n'
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
          '🔴 STOP LOSS\n==================\n🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n'
          + '📊 Sortie : $' + mc.toLocaleString() + ' MC\n==================\n'
          + '📉 Perte : ' + gainPct + '% (-$' + perteUSD + ')\n'
          + '⏱ Duree : ' + dureeMin + ' min\n==================\n'
          + 'PERTE NETTE : -$' + perteUSD + '\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle requise')
        );
        if (stats.total === 10 || stats.total === 20 || stats.total === 30) sendSniperReport();
        return;
      }

      // TIMEOUT 5 min
      if (checks >= TIMEOUT_CHECKS) {
        clearInterval(interval);
        const gainUSD = ((gainPct / 100) * MISE_USD).toFixed(0);
        if (gainPct > 0) stats.wins++; else stats.losses++;
        delete positions[mint];
        const sig = await sellToken(mint);
        await sendTelegram(
          '⏱ TIMEOUT 5 MIN\n==================\n🪙 ' + name + '\n'
          + (gainPct >= 0 ? '💰 Gain' : '📉 Perte') + ' : ' + (gainPct >= 0 ? '+' : '') + gainPct + '% (' + (gainPct >= 0 ? '+$' : '-$') + Math.abs(parseInt(gainUSD)) + ')\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle requise')
        );
        if (stats.total === 10 || stats.total === 20 || stats.total === 30) sendSniperReport();
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
      // 2000 bps (20%) de slippage car on achete tres tot = gros impact prix
      const qr = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=' + SOL + '&outputMint=' + mint + '&amount=' + MISE_LAMPORTS + '&slippageBps=2000');
      const q = await qr.json();
      if (!q.outAmount) {
        if (i === 3) {
          delete positions[mint];
          await sendTelegram('❌ ECHEC\n🪙 ' + name + '\nNon swappable sur Jupiter (trop recent)');
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

      const tpMC = Math.round(entryMC * (1 + TP_PCT / 100));
      const slMC = Math.round(entryMC * (1 - SL_PCT / 100));

      await sendTelegram(
        '🎯 SNIPE EXECUTE\n==================\n'
        + '🪙 ' + name + '\n'
        + '📊 MC entree : $' + entryMC.toLocaleString() + ' (tres tot)\n==================\n'
        + '💰 Mise : $' + MISE_USD + '\n'
        + '🎯 TP : $' + tpMC.toLocaleString() + ' MC (+' + TP_PCT + '%) → +$' + (MISE_USD * TP_PCT / 100) + '\n'
        + '🛑 SL : $' + slMC.toLocaleString() + ' MC (-' + SL_PCT + '%) → -$' + (MISE_USD * SL_PCT / 100) + '\n'
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

async function validateAndSnipe(mint) {
  if (watched[mint] || sniped.has(mint)) return;
  if (Object.keys(watched).length >= MAX_WATCH) return;
  watched[mint] = { checks: 0, name: mint.slice(0, 8) };

  const interval = setInterval(async () => {
    try {
      if (!watched[mint]) { clearInterval(interval); return; }
      const w = watched[mint];
      w.checks++;

      // Abandon apres 60 secondes sans donnees ou signal
      if (w.checks >= VALIDATION_CHECKS) {
        clearInterval(interval);
        delete watched[mint];
        stats.skipped++;
        return;
      }

      const { mc, name, liquidity } = await getTokenInfo(mint);
      if (name && name !== mint.slice(0, 8)) w.name = name;

      // Pas encore indexe — on reessaie
      if (!mc) return;

      // MC trop eleve — token deja pompe, trop tard
      if (mc > MAX_ENTRY_MC) {
        clearInterval(interval);
        delete watched[mint];
        stats.skipped++;
        console.log('[SKIP] ' + w.name + ' MC trop haut: $' + mc.toLocaleString());
        return;
      }

      // MC dans la zone ET liquidite suffisante — on achete
      if (mc >= MIN_ENTRY_MC && liquidity >= MIN_LIQUIDITY) {
        clearInterval(interval);
        const tokenName = w.name;
        delete watched[mint];

        if (Object.keys(positions).length >= MAX_OPEN) {
          stats.skipped++;
          return;
        }

        console.log('[SNIPER] Entree: ' + tokenName + ' | $' + mc.toLocaleString() + ' MC | Liquidite: $' + liquidity.toLocaleString());
        await snipe(mint, tokenName, mc);
      }

      // MC trop bas (< $2k) — pas assez de liquidite initiale, on attend encore

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

      await validateAndSnipe(mint);
    } catch(e) {
      console.log('[SNIPER] Erreur : ' + e.message);
    }
  }, 'confirmed');

  console.log('Sniper actif — entree $' + MIN_ENTRY_MC + '-$' + MAX_ENTRY_MC + ' MC');
  await sendTelegram(
    '🎯 SNIPER PUMP.FUN DEMARRE\n==================\n'
    + '⚡ Achat : tous les nouveaux tokens a la creation\n'
    + '📊 Zone entree : $' + MIN_ENTRY_MC.toLocaleString() + ' — $' + MAX_ENTRY_MC.toLocaleString() + ' MC\n'
    + '✅ Filtre : liquidite > $' + MIN_LIQUIDITY + '\n==================\n'
    + '💰 Mise : $' + MISE_USD + ' par trade\n'
    + '🎯 TP : +' + TP_PCT + '% → +$' + (MISE_USD * TP_PCT / 100) + '\n'
    + '🛑 SL : -' + SL_PCT + '% → -$' + (MISE_USD * SL_PCT / 100) + '\n'
    + '🔄 Trailing : -' + TRAILING_PCT + '% (actif a +' + TRAILING_ACTIVATE_PCT + '%)\n'
    + '🔢 Max positions : ' + MAX_OPEN + '\n'
    + '📊 Rapports a 10, 20, 30 snipes\n'
    + '=================='
  );
}

startSniper();
