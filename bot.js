if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const { Connection, PublicKey, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const http = require('http');

const server = http.createServer((req, res) => { res.writeHead(200); res.end('OK'); });
server.listen(3000);

const connection = new Connection('https://mainnet.helius-rpc.com/?api-key=' + process.env.HELIUS_API_KEY, 'confirmed');
const myWallet = Keypair.fromSecretKey(bs58.default.decode(process.env.PRIVATE_KEY));
const TARGETS = (process.env.TARGET_WALLET || '').split(',');
const SOL = 'So11111111111111111111111111111111111111112';
const ENTRY_MC = 3000;
const STOP_LOSS_MC = 2400;
const TARGET_MC = 6000;
const MISE_USD = 20;
const MIN_LIQUIDITY = 5000;
const processed = new Set();
const positions = {};
let availableSOL = 5000000;

const stats = {
  total: 0,
  reached8k: 0,
  reached5k: 0,
  reached3k: 0,
  rugged: 0,
  entryMCs: [],
  exitMCs: []
};

async function sendTelegram(msg) {
  try {
    await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
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
      const created = p.pairCreatedAt ? Math.floor((Date.now() - p.pairCreatedAt) / 60000) : 0;
      const hours = Math.floor(created / 60);
      const mins = created % 60;
      const age = hours > 0 ? hours + 'h ' + mins + 'm' : mins + 'm';
      const liquidity = p.liquidity?.usd || 0;
      const holders = p.info?.holders || 0;
      const liquidityLocked = p.info?.liquidityLocked || false;

      let score = 0;
      if (p.volume?.h24 > 10000) score += 3;
      else if (p.volume?.h24 > 5000) score += 2;
      else if (p.volume?.h24 > 1000) score += 1;

      if (liquidity > 10000) score += 3;
      else if (liquidity > 5000) score += 2;
      else if (liquidity > 2000) score += 1;

      if (created > 30) score += 2;
      else if (created > 10) score += 1;

      const txns = (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0);
      if (txns > 500) score += 2;
      else if (txns > 100) score += 1;

      return {
        mc: p.fdv || 0,
        price: parseFloat(p.priceUsd) || 0,
        name: p.baseToken.symbol || mint.slice(0,8),
        volume: p.volume?.h24 || 0,
        txns,
        age,
        ageMinutes: created,
        liquidity,
        holders,
        liquidityLocked,
        score
      };
    }
    return { mc: 0, price: 0, name: mint.slice(0,8), volume: 0, txns: 0, age: 'inconnu', ageMinutes: 0, liquidity: 0, holders: 0, liquidityLocked: false, score: 0 };
  } catch(e) {
    return { mc: 0, price: 0, name: mint.slice(0,8), volume: 0, txns: 0, age: 'inconnu', ageMinutes: 0, liquidity: 0, holders: 0, liquidityLocked: false, score: 0 };
  }
}

async function waitForEntry(mint, name, targetEntryMC) {
  console.log('En attente MC $' + targetEntryMC + ' pour ' + name);
  await sendTelegram('⏳ SNIPE EN ATTENTE\n==================\n🪙 ' + name + '\nMC trop haut pour entrer\nOn surveille : $' + targetEntryMC.toLocaleString() + ' MC\n==================\nVerification toutes les 5 sec...');

  const interval = setInterval(async () => {
    try {
      const { mc, price } = await getTokenInfo(mint);
      if (!mc) return;

      if (mc <= targetEntryMC) {
        console.log('ENTREE DETECTEE : ' + name + ' a $' + mc);
        await sendTelegram('🎯 ENTREE DETECTEE\n==================\n🪙 ' + name + '\n📊 MC : $' + mc.toLocaleString() + '\n💵 PRIX : $' + price + '\n==================\n⚡ ACHAT EN COURS...');
        clearInterval(interval);
        await executeBuy(mint, name, mc, price);
      }

      if (mc > targetEntryMC * 2) {
        console.log('Token trop monte, abandon : ' + name);
        clearInterval(interval);
      }
    } catch(e) {}
  }, 5000);
}

async function executeBuy(mint, name, entryMC, entryPrice) {
  for (let i = 1; i <= 3; i++) {
    try {
      const SOL = 'So11111111111111111111111111111111111111112';
      const qr = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=' + SOL + '&outputMint=' + mint + '&amount=' + availableSOL + '&slippageBps=150');
      const q = await qr.json();
      if (!q.outAmount) continue;
      const sr = await fetch('https://api.jup.ag/swap/v1/swap', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ quoteResponse: q, userPublicKey: myWallet.publicKey.toString(), wrapAndUnwrapSol: true })
      });
      const sd = await sr.json();
      if (!sd.swapTransaction) continue;
      const buf = Buffer.from(sd.swapTransaction, 'base64');
      const vtx = VersionedTransaction.deserialize(buf);
      vtx.sign([myWallet]);
      const sig = await connection.sendRawTransaction(vtx.serialize(), {skipPreflight: true, maxRetries: 3});
      await sendTelegram('✅ ACHAT EXECUTE\n==================\n🪙 ' + name + '\n💰 MISE : $' + MISE_USD + '\n==================\n📊 MC ENTREE : $' + entryMC.toLocaleString() + '\n💵 PRIX : $' + entryPrice + '\n==================\n🎯 OBJECTIF : $6,000 MC\n   Mise x2 → +$' + MISE_USD + ' profit\n🛑 STOP LOSS : $2,400 MC\n   Perte max → -$' + (MISE_USD * 0.24).toFixed(2) + '\n==================\n🔗 https://solscan.io/tx/' + sig);
      monitorMC(mint, name, entryMC);
      break;
    } catch(e) {
      console.log('Tentative ' + i + ' : ' + e.message);
    }
  }
}

async function handleWallet(TARGET_WALLET) {
  const pubkey = new PublicKey(TARGET_WALLET);
  connection.onLogs(pubkey, async (logs) => {
    if (logs.err || processed.has(logs.signature)) return;
    processed.add(logs.signature);
    try {
      await new Promise(r => setTimeout(r, 500));
      const tx = await connection.getParsedTransaction(logs.signature, {maxSupportedTransactionVersion: 0});
      if (!tx || !tx.meta) return;
      const pre = tx.meta.preTokenBalances || [];
      const post = tx.meta.postTokenBalances || [];
      const bought = post.find(p => p.owner === TARGET_WALLET && !pre.find(b => b.mint === p.mint && b.owner === TARGET_WALLET));
      if (!bought) return;
      const mint = bought.mint;
      const { mc, price, name, volume, txns, age, ageMinutes, liquidity, holders, liquidityLocked, score } = await getTokenInfo(mint);
      const shortWallet = TARGET_WALLET.slice(0,4) + '...' + TARGET_WALLET.slice(-4);

      const rugRisks = [];
      if (liquidity < MIN_LIQUIDITY && liquidity > 0) rugRisks.push('liquidite faible $' + liquidity.toFixed(0));
      if (ageMinutes < 5) rugRisks.push('token tres recent ' + ageMinutes + 'min');
      if (holders < 50 && holders > 0) rugRisks.push('peu de holders ' + holders);
      if (!liquidityLocked) rugRisks.push('liquidite non lockee');

      const scoreEmoji = score >= 7 ? '🟢' : score >= 5 ? '🟡' : '🔴';
      const rugScore = rugRisks.length === 0 ? '🟢 SAFE' : rugRisks.length === 1 ? '🟡 RISQUE ' + rugRisks.join(', ') : '🔴 DANGER ' + rugRisks.join(', ');

      if (score < 7) {
        console.log('Score trop bas : ' + score + '/10 pour ' + name + ', ignore');
        await sendTelegram('⚠️ IGNORE - Score trop bas\n==================\n🪙 TOKEN : ' + name + '\n' + scoreEmoji + ' SCORE : ' + score + '/10\nRaison : ' + rugRisks.join(', ') + '\n==================');
        return;
      }

      if (mc > ENTRY_MC && mc > 0) {
        console.log('MC trop eleve : $' + mc + ', on surveille...');
        await waitForEntry(mint, name, ENTRY_MC);
        return;
      }

      let status = '❌ ACHAT ECHOUE Jupiter indisponible';
      let sig = null;

      for (let i = 1; i <= 3; i++) {
        try {
          const qr = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=' + SOL + '&outputMint=' + mint + '&amount=' + availableSOL + '&slippageBps=150');
          const q = await qr.json();
          if (!q.outAmount) { status = '❌ ECHOUE Token non listable sur Jupiter'; continue; }
          const sr = await fetch('https://api.jup.ag/swap/v1/swap', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ quoteResponse: q, userPublicKey: myWallet.publicKey.toString(), wrapAndUnwrapSol: true })
          });
          const sd = await sr.json();
          if (!sd.swapTransaction) { status = '❌ ECHOUE Swap indisponible'; continue; }
          const buf = Buffer.from(sd.swapTransaction, 'base64');
          const vtx = VersionedTransaction.deserialize(buf);
          vtx.sign([myWallet]);
          sig = await connection.sendRawTransaction(vtx.serialize(), {skipPreflight: true, maxRetries: 3});
          status = '✅ ACHAT REUSSI';
availableSOL = Math.floor(availableSOL * 1.1);
console.log('Capital disponible : ' + availableSOL + ' lamports');
monitorMC(mint, name, mc);
          const key = mint.slice(0,8);
          positions[key] = { entry: price, name, mint };
          break;
        } catch(e) {
          status = '⚠️ ERREUR ' + e.message.slice(0,50);
        }
      }

      const entryStatus = mc <= ENTRY_MC ? '✅ ENTREE $3K POSSIBLE' : '⏳ MC A $' + mc.toLocaleString() + ' — SURVEILLANCE $3K';
      const snipeNote = ageMinutes > 0 ? '💡 Lance il y a ' + ageMinutes + ' min — snipe ideal au lancement' : '';

      const msg = '⚡ GHOSTCOPY SIGNAL ⚡\n'
        + '==================\n'
        + '🪙 ' + name + '\n'
        + '==================\n'
        + '📊 MC : $' + (mc ? mc.toLocaleString() : 'inconnu') + '\n'
        + '💵 PRIX : $' + price + '\n'
        + '⏰ AGE : ' + age + '\n'
        + '💧 LIQUIDITE : $' + liquidity.toLocaleString() + '\n'
        + '📈 VOLUME 24H : $' + volume.toLocaleString() + '\n'
        + '🔄 TXS 24H : ' + txns + '\n'
        + '==================\n'
        + scoreEmoji + ' SCORE : ' + score + '/10\n'
        + rugScore + '\n'
        + '==================\n'
        + '👛 COPIE : ' + shortWallet + '\n'
        + entryStatus + '\n'
        + snipeNote + '\n'
        + '==================\n'
        + status + '\n'
        + '==================\n'
        + (sig ? '🔗 TX : https://solscan.io/tx/' + sig + '\n' : '')
        + '📊 https://dexscreener.com/solana/' + mint;

      console.log(msg);
      await sendTelegram(msg);
    } catch(e) {
      console.log('Erreur : ' + e.message);
    }
  }, 'confirmed');
}

async function monitorMC(mint, name, entryMC) {
  stats.total++;
  stats.entryMCs.push(entryMC);
  let peak = entryMC;
  let sold40 = false;
  let sold35 = false;
  let sold25 = false;
  const startTime = Date.now();

  await sendTelegram('📊 POSITION OUVERTE\n==================\n🪙 ' + name + '\n💰 Mise : $' + MISE_USD + '\n📊 Entree : $' + entryMC.toLocaleString() + ' MC\n==================\n🎯 TP : $6,000 MC\n   → Gain attendu : +$' + MISE_USD + ' (+100%)\n🛑 SL : $2,400 MC\n   → Perte max : -$' + (MISE_USD * 0.24).toFixed(2) + ' (-24%)\n==================\nSuivi toutes les 15 sec...');

  const interval = setInterval(async () => {
    try {
      const { mc, price } = await getTokenInfo(mint);
      if (!mc) return;
      if (mc > peak) peak = mc;
      const duree = Math.round((Date.now() - startTime) / 60000) || 1;
      const vitesse = Math.round((mc - entryMC) / duree);

      if (mc >= TARGET_MC) {
        stats.reached8k++;
        stats.exitMCs.push(mc);
        const gainPct = Math.round((mc / entryMC - 1) * 100);
        const gainUSD = ((gainPct / 100) * MISE_USD).toFixed(2);
        const valeurFinale = (MISE_USD + parseFloat(gainUSD)).toFixed(2);
        await sendTelegram(
          '🏆 OBJECTIF ATTEINT — VENDRE TOUT\n==================\n🪙 ' + name + '\n💰 Mise initiale : $' + MISE_USD + '\n==================\n📊 MC entree : $' + entryMC.toLocaleString() + '\n📊 MC sortie : $' + mc.toLocaleString() + '\n📈 Pic atteint : $' + peak.toLocaleString() + '\n==================\n💰 Gain : +' + gainPct + '% (+$' + gainUSD + ')\n💵 Valeur finale : $' + valeurFinale + '\n⚡ Vitesse : +$' + vitesse.toLocaleString() + ' MC/min\n⏱ Duree : ' + duree + ' min\n==================\nBENEFICE NET : +$' + gainUSD + '\n==================\n📊 https://dexscreener.com/solana/' + mint
        );
        clearInterval(interval);
        if (stats.total % 5 === 0) sendReport();
        return;
      }

      if (mc <= STOP_LOSS_MC) {
        stats.rugged++;
        stats.exitMCs.push(mc);
        const pertePct = Math.round((mc / entryMC - 1) * 100);
        const perteUSD = Math.abs((pertePct / 100) * MISE_USD).toFixed(2);
        const vitesseChute = Math.round((entryMC - mc) / duree);
        await sendTelegram(
          '🔴 STOP LOSS DECLENCHE\n==================\n🪙 ' + name + '\n💰 Mise initiale : $' + MISE_USD + '\n==================\n📊 MC entree : $' + entryMC.toLocaleString() + '\n📊 MC sortie : $' + mc.toLocaleString() + '\n📈 Pic atteint : $' + peak.toLocaleString() + '\n==================\n📉 Perte : ' + pertePct + '% (-$' + perteUSD + ')\n⚡ Vitesse chute : -$' + vitesseChute.toLocaleString() + ' MC/min\n⏱ Duree : ' + duree + ' min\n==================\nPERTE NETTE : -$' + perteUSD + '\n==================\n📊 https://dexscreener.com/solana/' + mint
        );
        clearInterval(interval);
        if (stats.total % 5 === 0) sendReport();
      }

    } catch(e) {}
  }, 15000);
}

async function sendReport() {
  const winRate = stats.total > 0 ? Math.round((stats.reached8k / stats.total) * 100) : 0;
  const profitTotal = (stats.reached8k * MISE_USD).toFixed(2);
  const perteTotal = (stats.rugged * MISE_USD * 0.24).toFixed(2);
  const netUSD = (parseFloat(profitTotal) - parseFloat(perteTotal)).toFixed(2);
  const netEmoji = parseFloat(netUSD) >= 0 ? '✅' : '🔴';
  const msg = '📊 RAPPORT SESSION — ' + stats.total + ' TOKENS\n'
    + '==================\n'
    + '🏆 TP $6k atteint : ' + stats.reached8k + ' (' + winRate + '%)\n'
    + '🔴 Stop loss : ' + stats.rugged + '\n'
    + '==================\n'
    + '💰 Mise par trade : $' + MISE_USD + '\n'
    + '📈 Gains bruts : +$' + profitTotal + '\n'
    + '📉 Pertes : -$' + perteTotal + '\n'
    + netEmoji + ' NET : ' + (parseFloat(netUSD) >= 0 ? '+' : '') + '$' + netUSD + '\n'
    + '==================\n'
    + 'Win rate : ' + winRate + '%\n'
    + '==================';
  await sendTelegram(msg);
}

console.log('Bot PRO demarre');
TARGETS.forEach(w => handleWallet(w.trim()));
sendTelegram('🚀 GHOSTCOPY BOT DEMARRE\n==================\nWallets surveilles : ' + TARGETS.length + '\n==================');require('dotenv').config();
if (process.env.NODE_ENV !== 'production') require('dotenv').config();
