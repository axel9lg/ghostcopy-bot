if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const { Connection, PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const http = require('http');

const server = http.createServer((req, res) => { res.writeHead(200); res.end('SNIPER OK'); });
server.listen(3001);

const connection = new Connection(process.env.RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=' + process.env.HELIUS_API_KEY, 'confirmed');
const myWallet = Keypair.fromSecretKey(bs58.default.decode(process.env.PRIVATE_KEY));
const SOL = 'So11111111111111111111111111111111111111112';
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

// CONFIG — v3 (analyse de nuit)
const MISE_LAMPORTS = 1200000000; // ~1.2 SOL (~$200)
const MISE_USD = 200;
const MIN_ENTRY_MC = 3500;        // zone d'entree : $3,500 MC minimum
const MAX_ENTRY_MC = 5000;        // zone d'entree : $5,000 MC maximum
const SL_PCT = 20;                // SL -20% — coupe les rugs plus vite
const TRAILING_ACTIVATE_PCT = 25; // trailing actif des +25% (avant c'etait +30%)
const TRAILING_PCT = 20;          // trail -20% depuis pic (avant -15%)
const MIN_CREATOR_SOL = 0.3;      // createur doit avoir investi min 0.3 SOL
const MIN_LIQUIDITY = 500;
const JITO_FEE = 500000;
const MONITOR_INTERVAL = 5000;
const MAX_OPEN = 3;
const TIMEOUT_CHECKS = 96;        // 8 min max (96 x 5s)
const VALIDATION_CHECKS = 12;     // 60s pour valider le token
const MAX_WATCH = 200;

const sniped = new Set();
const positions = {};
const watched = {};

// Stats avec gains/pertes reels
const stats = {
  total: 0,
  wins: 0,
  losses: 0,
  skipped: 0,
  totalGainUSD: 0,
  totalLossUSD: 0,
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
  const net = stats.totalGainUSD - stats.totalLossUSD;
  const netEmoji = net >= 0 ? '✅' : '🔴';
  const fastest = stats.fastestWinMs < Infinity ? Math.round(stats.fastestWinMs / 1000) + 's (' + stats.fastestToken + ')' : 'N/A';

  let recommandation;
  if (winRate >= 50 && net > 0) {
    recommandation = '💹 RENTABLE — Tu peux augmenter la mise';
  } else if (winRate >= 35 && net >= 0) {
    recommandation = '⚖️ NEUTRE — Continue pour plus de donnees';
  } else if (winRate >= 35 && net < 0) {
    recommandation = '⚖️ PROCHE — Les gagnants ne courent pas assez, ajuste le trailing';
  } else {
    recommandation = '⚠️ NEGATIF — Reduis la mise, le marche est difficile';
  }

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
          await sendTelegram(
            '🔴 ABANDON\n==================\n🪙 ' + name + '\nNon indexe — rug probable\n==================\nPERTE ESTIMEE : -$' + lossUSD
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
      const trailingStatus = trailingActive ? ' [TRAILING ON]' : ' [SL ' + SL_PCT + '%]';
      console.log('[SNIPER] ' + name + ' | $' + mc.toLocaleString() + ' MC | ' + (gainPct >= 0 ? '+' : '') + gainPct + '% | Pic $' + peak.toLocaleString() + trailingStatus);

      // TRAILING STOP — vente quand le token redescend de 20% depuis son pic
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
          + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n'
          + '📈 Pic : $' + peak.toLocaleString() + ' MC\n'
          + '📊 Sortie : $' + mc.toLocaleString() + ' MC\n==================\n'
          + (gainPct >= 0 ? '💰 Gain' : '📉 Perte') + ' : ' + (gainPct >= 0 ? '+' : '') + gainPct + '% (' + (gainPct >= 0 ? '+$' : '-$') + Math.abs(gainUSD).toFixed(0) + ')\n'
          + '⏱ Duree : ' + dureeMin + ' min\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle requise')
        );
        if (stats.total === 10 || stats.total === 20 || stats.total === 30) sendSniperReport();
        return;
      }

      // STOP LOSS -20%
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
        if (stats.total === 10 || stats.total === 20 || stats.total === 30) sendSniperReport();
        return;
      }

      // TIMEOUT 8 min
      if (checks >= TIMEOUT_CHECKS) {
        clearInterval(interval);
        const gainUSD = (gainPct / 100) * MISE_USD;
        if (gainPct > 0) { stats.wins++; stats.totalGainUSD += gainUSD; }
        else { stats.losses++; stats.totalLossUSD += Math.abs(gainUSD); }
        delete positions[mint];
        const sig = await sellToken(mint);
        await sendTelegram(
          '⏱ TIMEOUT 8 MIN\n==================\n🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n'
          + '📊 Sortie : $' + mc.toLocaleString() + ' MC\n==================\n'
          + (gainPct >= 0 ? '💰 Gain' : '📉 Perte') + ' : ' + (gainPct >= 0 ? '+' : '') + gainPct + '% (' + (gainPct >= 0 ? '+$' : '-$') + Math.abs(gainUSD).toFixed(0) + ')\n'
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
      const qr = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=' + SOL + '&outputMint=' + mint + '&amount=' + MISE_LAMPORTS + '&slippageBps=2000');
      const q = await qr.json();
      if (!q.outAmount) {
        if (i === 3) {
          delete positions[mint];
          await sendTelegram('❌ ECHEC\n🪙 ' + name + '\nNon swappable (trop recent ou liquidite insuffisante)');
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

      const slMC = Math.round(entryMC * (1 - SL_PCT / 100));
      const trailingMC = Math.round(entryMC * (1 + TRAILING_ACTIVATE_PCT / 100));

      await sendTelegram(
        '🎯 SNIPE EXECUTE\n==================\n'
        + '🪙 ' + name + '\n'
        + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n==================\n'
        + '💰 Mise : $' + MISE_USD + '\n'
        + '🔄 Trailing : actif a $' + trailingMC.toLocaleString() + ' MC (+' + TRAILING_ACTIVATE_PCT + '%), coupe -' + TRAILING_PCT + '% du pic\n'
        + '🛑 SL : $' + slMC.toLocaleString() + ' MC (-' + SL_PCT + '%) → -$' + (MISE_USD * SL_PCT / 100) + '\n'
        + '⏱ Timeout : 8 min\n'
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

      if (w.checks >= VALIDATION_CHECKS) {
        clearInterval(interval);
        delete watched[mint];
        stats.skipped++;
        return;
      }

      const { mc, name, liquidity } = await getTokenInfo(mint);
      if (name && name !== mint.slice(0, 8)) w.name = name;
      if (!mc) return;

      // MC deja trop haut — on a rate la fenetre
      if (mc > MAX_ENTRY_MC) {
        clearInterval(interval);
        delete watched[mint];
        stats.skipped++;
        console.log('[SKIP] ' + w.name + ' trop haut: $' + mc.toLocaleString());
        return;
      }

      // MC dans la zone + liquidite ok = achat
      if (mc >= MIN_ENTRY_MC && liquidity >= MIN_LIQUIDITY) {
        clearInterval(interval);
        const tokenName = w.name;
        delete watched[mint];

        if (Object.keys(positions).length >= MAX_OPEN) {
          stats.skipped++;
          return;
        }

        console.log('[SNIPER] GO : ' + tokenName + ' | $' + mc.toLocaleString() + ' MC | Liq: $' + liquidity.toLocaleString());
        await snipe(mint, tokenName, mc);
      }
    } catch(e) {}
  }, MONITOR_INTERVAL);
}

function checkCreatorCommitment(tx) {
  // Verifie que le createur a investi au moins 0.3 SOL dans la creation
  // Le createur est generalement account[0] (fee payer)
  if (!tx.meta || !tx.meta.preBalances || !tx.meta.postBalances) return false;
  const solSpentLamports = tx.meta.preBalances[0] - tx.meta.postBalances[0];
  const solSpent = solSpentLamports / 1e9;
  // On soustrait ~0.015 SOL de frais/rent pour isoler l'achat initial
  const creatorBuySOL = solSpent - 0.015;
  console.log('[FILTRE] Createur a investi : ' + creatorBuySOL.toFixed(3) + ' SOL');
  return creatorBuySOL >= MIN_CREATOR_SOL;
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
  const processedSigs = new Set();

  // Marquer les dernieres signatures comme deja vues au demarrage
  try {
    const init = await connection.getSignaturesForAddress(pumpKey, { limit: 10, commitment: 'confirmed' });
    init.forEach(s => processedSigs.add(s.signature));
    console.log('[POLL] ' + init.length + ' signatures initiales marquees — pret');
  } catch(e) {
    console.log('[POLL] Init erreur : ' + e.message);
  }

  // Polling toutes les 12s — limite les requetes pour rester dans le plan gratuit
  setInterval(async () => {
    try {
      if (processedSigs.size > 2000) {
        const arr = [...processedSigs];
        processedSigs.clear();
        arr.slice(-1000).forEach(s => processedSigs.add(s));
      }

      const sigs = await connection.getSignaturesForAddress(pumpKey, { limit: 10, commitment: 'confirmed' });
      const newSigs = sigs.filter(s => !s.err && !processedSigs.has(s.signature));

      for (const sigInfo of newSigs) {
        processedSigs.add(sigInfo.signature);

        try {
          const tx = await connection.getParsedTransaction(sigInfo.signature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed'
          });
          if (!tx || !tx.meta) continue;

          const logs = tx.meta.logMessages || [];
          const isCreate = logs.some(l =>
            l.includes('InitializeMint') ||
            l.includes('Instruction: Create') ||
            l.includes('Instruction: Initialize')
          );
          if (!isCreate) continue;

          const mint = findNewMint(tx);
          if (!mint) continue;

          if (!checkCreatorCommitment(tx)) {
            stats.skipped++;
            continue;
          }

          await validateAndSnipe(mint);
        } catch(e) {}

        // Pause entre chaque requete pour ne pas surcharger l'API
        await new Promise(r => setTimeout(r, 400));
      }
    } catch(e) {
      console.log('[POLL] Erreur : ' + e.message);
    }
  }, 12000);

  console.log('[POLL] Sniper v3 actif — polling toutes les 3s — zone $' + MIN_ENTRY_MC + '-$' + MAX_ENTRY_MC + ' MC');
  await sendTelegram(
    '🎯 SNIPER v3 DEMARRE\n==================\n'
    + '📡 Polling Pump.fun (HTTP, plus de 429)\n'
    + '👤 Filtre createur : min ' + MIN_CREATOR_SOL + ' SOL investi\n'
    + '📊 Zone entree : $' + MIN_ENTRY_MC.toLocaleString() + ' — $' + MAX_ENTRY_MC.toLocaleString() + ' MC\n==================\n'
    + '💰 Mise : $' + MISE_USD + ' par trade\n'
    + '🔄 Trailing : actif a +' + TRAILING_ACTIVATE_PCT + '%, coupe -' + TRAILING_PCT + '% du pic\n'
    + '🛑 SL : -' + SL_PCT + '% (coupe plus vite les rugs)\n'
    + '⏱ Timeout : 8 min\n'
    + '🔢 Max positions : ' + MAX_OPEN + '\n'
    + '📊 Rapports a 10, 20, 30 snipes\n'
    + '=================='
  );
}

startSniper();
