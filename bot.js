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
const ENTRY_MC = 2500;
const STOP_LOSS_MC = 2400;
const TARGET_MC = 5000;
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
      return {
        mc: p.fdv || 0,
        price: parseFloat(p.priceUsd) || 0,
        name: p.baseToken.symbol || mint.slice(0,8),
        volume: p.volume?.h24 || 0,
        txns: (p.txns?.h24?.buys || 0) + (p.txns?.h24?.sells || 0),
        age,
        ageMinutes: created,
        liquidity
      };
    }
    return { mc: 0, price: 0, name: mint.slice(0,8), volume: 0, txns: 0, age: 'inconnu', ageMinutes: 0, liquidity: 0 };
  } catch(e) {
    return { mc: 0, price: 0, name: mint.slice(0,8), volume: 0, txns: 0, age: 'inconnu', ageMinutes: 0, liquidity: 0 };
  }
}

async function waitForEntry(mint, name, targetEntryMC) {
  console.log('En attente MC $' + targetEntryMC + ' pour ' + name);
  await sendTelegram('⏳ ATTENTE ENTREE\n==================\n🪙 TOKEN : ' + name + '\nMC actuel : en surveillance\nOn attend : $' + targetEntryMC + '\n==================');

  const interval = setInterval(async () => {
    try {
      const { mc, price } = await getTokenInfo(mint);
      if (!mc) return;

      if (mc <= targetEntryMC) {
        console.log('ENTREE DETECTEE : ' + name + ' a $' + mc);
        await sendTelegram('🎯 ENTREE DETECTEE\n==================\n🪙 TOKEN : ' + name + '\nMC : $' + mc.toLocaleString() + '\nPRIX : $' + price + '\nACHAT EN COURS...\n==================');
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
      await sendTelegram('✅ ACHAT REUSSI\n==================\n🪙 TOKEN : ' + name + '\nMC entree : $' + entryMC.toLocaleString() + '\nPRIX : $' + entryPrice + '\nSTOP LOSS : $2,400 MC\nOBJECTIF : $5,000 MC\n==================\n🔗 TX : https://solscan.io/tx/' + sig);
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
      const { mc, price, name, volume, txns, age, ageMinutes, liquidity } = await getTokenInfo(mint);
      const shortWallet = TARGET_WALLET.slice(0,4) + '...' + TARGET_WALLET.slice(-4);

      const rugRisks = [];
      if (liquidity < MIN_LIQUIDITY && liquidity > 0) rugRisks.push('liquidite faible $' + liquidity.toFixed(0));
      if (ageMinutes < 5) rugRisks.push('token tres recent ' + ageMinutes + 'min');
      if (mc > ENTRY_MC && mc > 0) rugRisks.push('MC trop eleve $' + mc.toLocaleString());

      const rugScore = rugRisks.length === 0 ? '🟢 SAFE' : rugRisks.length === 1 ? '🟡 RISQUE ' + rugRisks.join(', ') : '🔴 DANGER ' + rugRisks.join(', ');

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

      const msg = '⚡ GHOSTCOPY ALERT ⚡\n'
        + '==================\n\n'
        + '🪙 TOKEN : ' + name + '\n'
        + '📊 MC : $' + (mc ? mc.toLocaleString() : 'inconnu') + '\n'
        + '💵 PRIX : $' + price + '\n'
        + '💧 LIQUIDITE : $' + liquidity.toLocaleString() + '\n'
        + '📈 VOLUME 24H : $' + volume.toLocaleString() + '\n'
        + '🔄 TXS 24H : ' + txns + '\n'
        + '⏰ AGE : ' + age + '\n\n'
        + rugScore + '\n\n'
        + '==================\n'
        + '👛 WALLET : ' + shortWallet + '\n'
        + '💰 MISE : 0.005 SOL\n\n'
        + status + '\n'
        + '==================\n'
        + (sig ? '🔗 TX : https://solscan.io/tx/' + sig + '\n' : '')
        + '📊 CHART : https://dexscreener.com/solana/' + mint + '\n\n'
        + '🎯 TP : +100% | 🛑 SL : -30%\n'
        + '==================';

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
  const startTime = Date.now();
  await sendTelegram('📊 SUIVI OUVERT\n==================\n🪙 ' + name + '\nEntree MC : $' + entryMC.toLocaleString() + '\nObjectif : $8,000\nStop Loss : $1,500\n==================\nSurveillance toutes les 15 sec...');

  const interval = setInterval(async () => {
    try {
      const { mc } = await getTokenInfo(mint);
      if (!mc) return;
      if (mc > peak) peak = mc;
      const pct = Math.round((mc/entryMC-1)*100);
      const status = mc > entryMC ? '+' + pct + '%' : pct + '%';
      console.log(name + ' | MC actuel : $' + mc.toLocaleString() + ' | ' + status);

      if (Date.now() % 300000 < 15000) {
        const pct2 = Math.round((mc/entryMC-1)*100);
        await sendTelegram('⏱ SUIVI ' + name + '\n==================\nMC actuel : $' + mc.toLocaleString() + '\nVariation : ' + (pct2 > 0 ? '+' : '') + pct2 + '%\nPic : $' + peak.toLocaleString() + '\nObjectif : $8,000\n==================');
      }

      if (mc >= TARGET_MC) {
        stats.reached8k++;
        stats.exitMCs.push(mc);
        const gainPct = Math.round((mc/entryMC-1)*100);
        const bilan = '🏆 BILAN FINAL\n==================\n🪙 TOKEN : ' + name + '\n\nEntree : $' + entryMC.toLocaleString() + ' MC\nSortie : $' + mc.toLocaleString() + ' MC\nPic atteint : $' + peak.toLocaleString() + ' MC\n\nGain : +' + gainPct + '%\nObjectif $8,000 : ATTEINT\nStop Loss : NON DECLENCHE\n\nDuree : ' + Math.round((Date.now() - startTime)/60000) + ' min\n==================\n STRATEGIE GAGNANTE';
        await sendTelegram(bilan);
        clearInterval(interval);
        if (stats.total % 10 === 0) sendReport();
      } else if (mc >= 5000) {
        stats.reached5k++;
      } else if (mc >= 3000) {
        stats.reached3k++;
      } else if (mc <= entryMC * 0.5) {
        stats.rugged++;
        stats.exitMCs.push(mc);
        const pertePct = Math.round((mc/entryMC-1)*100);
        const bilan = '📋 BILAN FINAL\n==================\n🪙 TOKEN : ' + name + '\n\nEntree : $' + entryMC.toLocaleString() + ' MC\nSortie : $' + mc.toLocaleString() + ' MC\nPic atteint : $' + peak.toLocaleString() + ' MC\n\nPerte : ' + pertePct + '%\nObjectif $8,000 : NON ATTEINT\nStop Loss : DECLENCHE\n\nDuree : ' + Math.round((Date.now() - startTime)/60000) + ' min\n==================\n STRATEGIE PERDANTE';
        await sendTelegram(bilan);
        clearInterval(interval);
        if (stats.total % 10 === 0) sendReport();
      }
    } catch(e) {}
  }, 15000);
}

async function sendReport() {
  const winRate = Math.round((stats.reached8k / stats.total) * 100);
  const msg = '📊 RAPPORT ' + stats.total + ' TOKENS\n'
    + '==================\n'
    + '✅ Objectif $8k atteint : ' + stats.reached8k + ' (' + winRate + '%)\n'
    + '🟡 Atteint $5k : ' + stats.reached5k + '\n'
    + '🟠 Atteint $3k : ' + stats.reached3k + '\n'
    + '🔴 Ruggés : ' + stats.rugged + '\n'
    + '==================\n'
    + 'Meilleure entree : $' + Math.min(...stats.entryMCs).toLocaleString() + '\n'
    + 'Strategie win rate : ' + winRate + '%\n'
    + '==================';
  await sendTelegram(msg);
}

console.log('Bot PRO demarre');
TARGETS.forEach(w => handleWallet(w.trim()));
sendTelegram('🚀 GHOSTCOPY BOT DEMARRE\n==================\nWallets surveilles : ' + TARGETS.length + '\n==================');require('dotenv').config();
if (process.env.NODE_ENV !== 'production') require('dotenv').config();
