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

// CONFIG — strategie DIP & RECOVERY
const MISE_LAMPORTS = 1200000000; // ~1.2 SOL (~$200)
const MISE_USD = 200;
const ENTRY_MC = 9100;            // on achete a $9,100 MC
const TP_PCT = 100;               // TP +100% → $18,200 MC → +$200
const SL_PCT = 30;                // SL -30% → $6,370 MC → -$60
const WATCH_MIN_MC = 5000;        // on commence a surveiller a $5,000 MC
const DIP_PCT = 10;               // le token doit avoir chute de 10%+ depuis son pic
const TRAILING_ACTIVATE_PCT = 50; // trailing actif apres +50%
const TRAILING_PCT = 15;          // trail -15% depuis pic
const JITO_FEE = 500000;          // 0.0005 SOL priority fee
const MONITOR_INTERVAL = 5000;   // check toutes les 5 sec
const MAX_OPEN = 3;               // max 3 positions ouvertes
const TIMEOUT_CHECKS = 120;      // 10 min max apres achat (120 x 5s)
const MAX_WATCH = 150;            // max 150 tokens surveilles
const WATCH_TIMEOUT = 720;        // 1h max de surveillance par token (720 x 5s)

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
  const gainBrut = (stats.wins * MISE_USD * TP_PCT / 100).toFixed(2);
  const perteBrut = (stats.losses * MISE_USD * SL_PCT / 100).toFixed(2);
  const net = (parseFloat(gainBrut) - parseFloat(perteBrut)).toFixed(2);
  const netEmoji = parseFloat(net) >= 0 ? '✅' : '🔴';
  const fastest = stats.fastestWinMs < Infinity ? Math.round(stats.fastestWinMs / 1000) + 's (' + stats.fastestToken + ')' : 'N/A';
  await sendTelegram(
    '📊 RAPPORT SNIPER — ' + stats.total + ' TRADES\n'
    + '==================\n'
    + '🏆 TP atteint : ' + stats.wins + ' (' + winRate + '%)\n'
    + '🔴 Stop loss : ' + stats.losses + '\n'
    + '==================\n'
    + '💰 Mise par trade : $' + MISE_USD + '\n'
    + '📈 Gains bruts : +$' + gainBrut + '\n'
    + '📉 Pertes : -$' + perteBrut + '\n'
    + netEmoji + ' NET : ' + (parseFloat(net) >= 0 ? '+' : '') + '$' + net + '\n'
    + '==================\n'
    + '🥇 Meilleur gain : +' + stats.bestGainPct + '% (' + (stats.bestToken || 'N/A') + ')\n'
    + '⚡ Win le plus rapide : ' + fastest + '\n'
    + '👁 Tokens surveilles : ' + Object.keys(watched).length + '\n'
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
            '🔴 SNIPE ABANDONNE\n==================\n🪙 ' + name + '\nNon indexe apres 1 min\n==================\nPERTE ESTIMEE : -$' + (MISE_USD * SL_PCT / 100).toFixed(0)
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
        if (stats.total % 5 === 0) sendSniperReport();
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
        if (stats.total % 5 === 0) sendSniperReport();
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
        if (stats.total % 5 === 0) sendSniperReport();
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

async function snipe(mint, detectTime, peakMC, tokenName) {
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
          await sendTelegram('❌ SNIPE ECHOUE\n🪙 ' + (tokenName || mint.slice(0, 8)) + '\nNon swappable sur Jupiter');
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

      const tpMC = Math.round(ENTRY_MC * (1 + TP_PCT / 100));
      const slMC = Math.round(ENTRY_MC * (1 - SL_PCT / 100));

      await sendTelegram(
        '🎯 SNIPE EXECUTE — DIP RECOVERY\n==================\n'
        + '🪙 ' + tokenName + '\n==================\n'
        + '📉 Pic precedent : $' + peakMC.toLocaleString() + ' MC\n'
        + '📈 Entree : $' + ENTRY_MC.toLocaleString() + ' MC\n==================\n'
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

  watched[mint] = { peak: 0, hadDip: false, checks: 0, name: mint.slice(0, 8) };
  console.log('[WATCH] ' + Object.keys(watched).length + ' tokens surveilles | Nouveau : ' + mint.slice(0, 12) + '...');

  const interval = setInterval(async () => {
    try {
      if (!watched[mint]) { clearInterval(interval); return; }
      const w = watched[mint];
      w.checks++;

      // Abandon rapide : apres 5 min si le token n'a jamais atteint $2,500 MC
      if (w.checks === 60 && w.peak < 2500) {
        clearInterval(interval);
        delete watched[mint];
        return;
      }

      // Timeout 1h
      if (w.checks >= WATCH_TIMEOUT) {
        clearInterval(interval);
        delete watched[mint];
        return;
      }

      const { mc, name } = await getTokenInfo(mint);
      if (name && name !== mint.slice(0, 8)) w.name = name;
      if (!mc) return;

      // Track pic
      if (mc > w.peak) w.peak = mc;

      // Detecter le dip : pic >= $5,000 et MC a baisse de 10%+ depuis le pic
      if (w.peak >= WATCH_MIN_MC && mc <= w.peak * (1 - DIP_PCT / 100)) {
        w.hadDip = true;
      }

      // Signal entree : dip confirme + MC remonte a $9,100 (±15% de marge)
      if (w.hadDip && mc >= ENTRY_MC && mc <= ENTRY_MC * 1.15) {
        clearInterval(interval);
        const name = w.name;
        const peakMC = w.peak;
        delete watched[mint];

        if (Object.keys(positions).length >= MAX_OPEN) {
          console.log('[WATCH] Signal ' + name + ' ignore — ' + MAX_OPEN + ' positions deja ouvertes');
          return;
        }

        console.log('[SNIPER] DIP+RECOVERY detecte : ' + name + ' | Pic: $' + peakMC.toLocaleString() + ' → Entree: $' + mc.toLocaleString());
        await sendTelegram(
          '📡 SIGNAL DIP + RECOVERY\n==================\n'
          + '🪙 ' + name + '\n'
          + '📈 Montee : $' + WATCH_MIN_MC.toLocaleString() + ' → $' + peakMC.toLocaleString() + ' MC\n'
          + '📉 Dip confirme (-' + DIP_PCT + '%+ depuis pic)\n'
          + '📈 Recovery : $' + mc.toLocaleString() + ' MC\n'
          + '==================\n'
          + '🎯 Achat en cours a $' + ENTRY_MC.toLocaleString() + ' MC...'
        );

        await snipe(mint, Date.now(), peakMC, name);
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

  console.log('Sniper DIP+RECOVERY actif — entree a $' + ENTRY_MC.toLocaleString() + ' MC');
  await sendTelegram(
    '🎯 SNIPER DIP & RECOVERY DEMARRE\n==================\n'
    + '📡 Surveillance : tous les nouveaux tokens Pump.fun\n'
    + '📊 Zone de montee : $' + WATCH_MIN_MC.toLocaleString() + ' → $' + ENTRY_MC.toLocaleString() + ' MC\n'
    + '📉 Condition : dip de ' + DIP_PCT + '%+ depuis le pic\n'
    + '📈 Entree : $' + ENTRY_MC.toLocaleString() + ' MC (recovery)\n==================\n'
    + '💰 Mise : $' + MISE_USD + ' par trade\n'
    + '🎯 TP : +' + TP_PCT + '% → +$' + (MISE_USD * TP_PCT / 100) + '\n'
    + '🛑 SL : -' + SL_PCT + '% → -$' + (MISE_USD * SL_PCT / 100) + '\n'
    + '🔄 Trailing : -' + TRAILING_PCT + '% du pic (actif a +' + TRAILING_ACTIVATE_PCT + '%)\n'
    + '🔢 Max positions : ' + MAX_OPEN + '\n'
    + '=================='
  );
}

startSniper();
