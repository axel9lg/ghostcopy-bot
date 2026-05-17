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
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

const ENTRY_MC = 3000;
const STOP_LOSS_MC = 2400;
const TARGET_MC = 6000;
const MISE_USD = 20;
const MIN_LIQUIDITY = 5000;
const TRAILING_STOP_PCT = 20;
const MIN_WALLET_WINRATE = 30;
const JITO_FEE = 100000;

const processed = new Set();
let availableSOL = 5000000;

const walletStats = {};

const stats = {
  total: 0,
  wins: 0,
  losses: 0,
  entryMCs: [],
  exitMCs: [],
  bestGainPct: 0,
  bestGainToken: '',
  fastestTPMin: Infinity,
  fastestTPToken: '',
  bestEntryMC: Infinity,
  bestEntryToken: ''
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

      return { mc: p.fdv || 0, price: parseFloat(p.priceUsd) || 0, name: p.baseToken.symbol || mint.slice(0,8), volume: p.volume?.h24 || 0, txns, age, ageMinutes: created, liquidity, holders, liquidityLocked, score };
    }
    return { mc: 0, price: 0, name: mint.slice(0,8), volume: 0, txns: 0, age: 'inconnu', ageMinutes: 0, liquidity: 0, holders: 0, liquidityLocked: false, score: 0 };
  } catch(e) {
    return { mc: 0, price: 0, name: mint.slice(0,8), volume: 0, txns: 0, age: 'inconnu', ageMinutes: 0, liquidity: 0, holders: 0, liquidityLocked: false, score: 0 };
  }
}

async function sellToken(mint) {
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(myWallet.publicKey, { mint: new PublicKey(mint) });
    if (!tokenAccounts.value.length) return null;
    const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
    if (balance === '0') return null;

    const qr = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=' + mint + '&outputMint=' + SOL + '&amount=' + balance + '&slippageBps=300');
    const q = await qr.json();
    if (!q.outAmount) return null;

    const sr = await fetch('https://api.jup.ag/swap/v1/swap', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ quoteResponse: q, userPublicKey: myWallet.publicKey.toString(), wrapAndUnwrapSol: true, prioritizationFeeLamports: JITO_FEE })
    });
    const sd = await sr.json();
    if (!sd.swapTransaction) return null;
    const buf = Buffer.from(sd.swapTransaction, 'base64');
    const vtx = VersionedTransaction.deserialize(buf);
    vtx.sign([myWallet]);
    return await connection.sendRawTransaction(vtx.serialize(), {skipPreflight: true, maxRetries: 3});
  } catch(e) {
    console.log('Erreur sell : ' + e.message);
    return null;
  }
}

function checkWalletPerf(wallet) {
  const ws = walletStats[wallet];
  if (!ws) return;
  const total = ws.wins + ws.losses;
  if (total < 5) return;
  const winRate = Math.round((ws.wins / total) * 100);
  if (winRate < MIN_WALLET_WINRATE) {
    ws.disabled = true;
    sendTelegram('⚠️ WALLET DESACTIVE\n==================\n👛 ' + wallet.slice(0,4) + '...' + wallet.slice(-4) + '\nWin rate : ' + winRate + '%\n' + ws.wins + ' wins / ' + ws.losses + ' losses\nSeuil minimum : ' + MIN_WALLET_WINRATE + '%\n==================\nTrop peu fiable, surveillance stoppee.');
  }
}

async function waitForEntry(mint, name, targetEntryMC, walletAddr) {
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
        await executeBuy(mint, name, mc, price, walletAddr);
      }
      if (mc > targetEntryMC * 2) {
        console.log('Token trop monte, abandon : ' + name);
        clearInterval(interval);
      }
    } catch(e) {}
  }, 5000);
}

async function executeBuy(mint, name, entryMC, entryPrice, walletAddr) {
  for (let i = 1; i <= 3; i++) {
    try {
      const qr = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=' + SOL + '&outputMint=' + mint + '&amount=' + availableSOL + '&slippageBps=150');
      const q = await qr.json();
      if (!q.outAmount) continue;
      const sr = await fetch('https://api.jup.ag/swap/v1/swap', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ quoteResponse: q, userPublicKey: myWallet.publicKey.toString(), wrapAndUnwrapSol: true, prioritizationFeeLamports: JITO_FEE })
      });
      const sd = await sr.json();
      if (!sd.swapTransaction) continue;
      const buf = Buffer.from(sd.swapTransaction, 'base64');
      const vtx = VersionedTransaction.deserialize(buf);
      vtx.sign([myWallet]);
      const sig = await connection.sendRawTransaction(vtx.serialize(), {skipPreflight: true, maxRetries: 3});
      availableSOL = Math.floor(availableSOL * 1.1);
      console.log('Capital disponible : ' + availableSOL + ' lamports');
      await sendTelegram('✅ ACHAT EXECUTE\n==================\n🪙 ' + name + '\n💰 MISE : $' + MISE_USD + '\n==================\n📊 MC ENTREE : $' + entryMC.toLocaleString() + '\n💵 PRIX : $' + entryPrice + '\n==================\n🎯 OBJECTIF : $6,000 MC\n   Mise x2 → +$' + MISE_USD + ' profit\n🛑 STOP LOSS : $2,400 MC\n   Perte max → -$' + (MISE_USD * 0.24).toFixed(2) + '\n🔄 Trailing stop : -' + TRAILING_STOP_PCT + '% du pic\n==================\n🔗 https://solscan.io/tx/' + sig);
      monitorMC(mint, name, entryMC, walletAddr);
      break;
    } catch(e) {
      console.log('Tentative ' + i + ' : ' + e.message);
    }
  }
}

async function handleWallet(TARGET_WALLET) {
  if (!walletStats[TARGET_WALLET]) walletStats[TARGET_WALLET] = { wins: 0, losses: 0, disabled: false };
  const pubkey = new PublicKey(TARGET_WALLET);
  connection.onLogs(pubkey, async (logs) => {
    if (logs.err || processed.has(logs.signature)) return;
    if (walletStats[TARGET_WALLET]?.disabled) return;
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
        await sendTelegram('⚠️ IGNORE — Score trop bas\n==================\n🪙 ' + name + '\n' + scoreEmoji + ' SCORE : ' + score + '/10\nRaison : ' + (rugRisks.join(', ') || 'activite insuffisante') + '\n==================');
        return;
      }

      const entryStatus = mc <= ENTRY_MC ? '✅ ENTREE $3K POSSIBLE' : '⏳ MC A $' + mc.toLocaleString() + ' — SURVEILLANCE $3K';
      const snipeNote = ageMinutes > 0 ? '💡 Lance il y a ' + ageMinutes + ' min — snipe ideal au lancement' : '';

      await sendTelegram('⚡ GHOSTCOPY SIGNAL ⚡\n==================\n🪙 ' + name + '\n==================\n📊 MC : $' + (mc ? mc.toLocaleString() : 'inconnu') + '\n💵 PRIX : $' + price + '\n⏰ AGE : ' + age + '\n💧 LIQUIDITE : $' + liquidity.toLocaleString() + '\n📈 VOLUME 24H : $' + volume.toLocaleString() + '\n🔄 TXS 24H : ' + txns + '\n==================\n' + scoreEmoji + ' SCORE : ' + score + '/10\n' + rugScore + '\n==================\n👛 COPIE : ' + shortWallet + '\n' + entryStatus + '\n' + snipeNote + '\n==================\n📊 https://dexscreener.com/solana/' + mint);

      if (mc > ENTRY_MC && mc > 0) {
        await waitForEntry(mint, name, ENTRY_MC, TARGET_WALLET);
      } else {
        await executeBuy(mint, name, mc, price, TARGET_WALLET);
      }
    } catch(e) {
      console.log('Erreur : ' + e.message);
    }
  }, 'confirmed');
}

async function monitorMC(mint, name, entryMC, walletAddr) {
  stats.total++;
  stats.entryMCs.push(entryMC);
  if (entryMC < stats.bestEntryMC) { stats.bestEntryMC = entryMC; stats.bestEntryToken = name; }

  let peak = entryMC;
  let trailingActive = false;
  const startTime = Date.now();

  await sendTelegram('📊 POSITION OUVERTE\n==================\n🪙 ' + name + '\n💰 Mise : $' + MISE_USD + '\n📊 Entree : $' + entryMC.toLocaleString() + ' MC\n==================\n🎯 TP : $6,000 MC → +$' + MISE_USD + ' (+100%)\n🛑 SL : $2,400 MC → -$' + (MISE_USD * 0.24).toFixed(2) + ' (-24%)\n🔄 Trailing stop : -' + TRAILING_STOP_PCT + '% du pic\n==================\nSuivi toutes les 15 sec...');

  const interval = setInterval(async () => {
    try {
      const { mc } = await getTokenInfo(mint);
      if (!mc) return;
      if (mc > peak) { peak = mc; if (peak >= entryMC * 1.3) trailingActive = true; }
      const duree = Math.round((Date.now() - startTime) / 60000) || 1;
      const vitesse = Math.round((mc - entryMC) / duree);
      const gainPct = Math.round((mc / entryMC - 1) * 100);
      console.log(name + ' | MC : $' + mc.toLocaleString() + ' | ' + (gainPct >= 0 ? '+' : '') + gainPct + '% | Pic : $' + peak.toLocaleString());

      // Trailing stop — actif apres +30% depuis l'entree
      if (trailingActive && mc <= peak * (1 - TRAILING_STOP_PCT / 100) && mc > STOP_LOSS_MC) {
        clearInterval(interval);
        const pct = Math.round((mc / entryMC - 1) * 100);
        const gainUSD = ((pct / 100) * MISE_USD).toFixed(2);
        if (pct > stats.bestGainPct) { stats.bestGainPct = pct; stats.bestGainToken = name; }
        const sig = await sellToken(mint);
        if (walletAddr && walletStats[walletAddr]) { if (pct > 0) walletStats[walletAddr].wins++; else walletStats[walletAddr].losses++; checkWalletPerf(walletAddr); }
        if (pct > 0) stats.wins++; else stats.losses++;
        await sendTelegram('🔄 TRAILING STOP — VENTE AUTO\n==================\n🪙 ' + name + '\n📈 Pic : $' + peak.toLocaleString() + ' MC\n📊 Sortie : $' + mc.toLocaleString() + ' MC\n' + (pct >= 0 ? '💰 Gain' : '📉 Perte') + ' : ' + (pct >= 0 ? '+' : '') + pct + '% (' + (pct >= 0 ? '+' : '') + '$' + gainUSD + ')\n⏱ Duree : ' + duree + ' min\n==================\n' + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle requise'));
        if (stats.total % 5 === 0) sendReport();
        return;
      }

      // TP
      if (mc >= TARGET_MC) {
        clearInterval(interval);
        stats.wins++;
        stats.exitMCs.push(mc);
        const pct = Math.round((mc / entryMC - 1) * 100);
        const gainUSD = ((pct / 100) * MISE_USD).toFixed(2);
        const valeurFinale = (MISE_USD + parseFloat(gainUSD)).toFixed(2);
        if (pct > stats.bestGainPct) { stats.bestGainPct = pct; stats.bestGainToken = name; }
        if (duree < stats.fastestTPMin) { stats.fastestTPMin = duree; stats.fastestTPToken = name; }
        const sig = await sellToken(mint);
        if (walletAddr && walletStats[walletAddr]) { walletStats[walletAddr].wins++; checkWalletPerf(walletAddr); }
        await sendTelegram('🏆 OBJECTIF ATTEINT — VENTE AUTO\n==================\n🪙 ' + name + '\n💰 Mise : $' + MISE_USD + '\n==================\n📊 Entree : $' + entryMC.toLocaleString() + ' MC\n📊 Sortie : $' + mc.toLocaleString() + ' MC\n📈 Pic : $' + peak.toLocaleString() + ' MC\n==================\n💰 Gain : +' + pct + '% (+$' + gainUSD + ')\n💵 Valeur finale : $' + valeurFinale + '\n⚡ Vitesse : +$' + vitesse.toLocaleString() + ' MC/min\n⏱ Duree : ' + duree + ' min\n==================\nBENEFICE NET : +$' + gainUSD + '\n==================\n📊 https://dexscreener.com/solana/' + mint + (sig ? '\n🔗 https://solscan.io/tx/' + sig : '\n⚠️ Vente manuelle requise'));
        if (stats.total % 5 === 0) sendReport();
        return;
      }

      // Stop Loss
      if (mc <= STOP_LOSS_MC) {
        clearInterval(interval);
        stats.losses++;
        stats.exitMCs.push(mc);
        const pct = Math.round((mc / entryMC - 1) * 100);
        const perteUSD = Math.abs((pct / 100) * MISE_USD).toFixed(2);
        const vitesseChute = Math.round((entryMC - mc) / duree);
        const sig = await sellToken(mint);
        if (walletAddr && walletStats[walletAddr]) { walletStats[walletAddr].losses++; checkWalletPerf(walletAddr); }
        await sendTelegram('🔴 STOP LOSS — VENTE AUTO\n==================\n🪙 ' + name + '\n💰 Mise : $' + MISE_USD + '\n==================\n📊 Entree : $' + entryMC.toLocaleString() + ' MC\n📊 Sortie : $' + mc.toLocaleString() + ' MC\n📈 Pic : $' + peak.toLocaleString() + ' MC\n==================\n📉 Perte : ' + pct + '% (-$' + perteUSD + ')\n⚡ Vitesse chute : -$' + vitesseChute.toLocaleString() + ' MC/min\n⏱ Duree : ' + duree + ' min\n==================\nPERTE NETTE : -$' + perteUSD + '\n==================\n📊 https://dexscreener.com/solana/' + mint + (sig ? '\n🔗 https://solscan.io/tx/' + sig : '\n⚠️ Vente manuelle requise'));
        if (stats.total % 5 === 0) sendReport();
      }
    } catch(e) {}
  }, 15000);
}

async function sendReport() {
  const total = stats.total;
  const winRate = total > 0 ? Math.round((stats.wins / total) * 100) : 0;
  const profitTotal = (stats.wins * MISE_USD).toFixed(2);
  const perteTotal = (stats.losses * MISE_USD * 0.24).toFixed(2);
  const netUSD = (parseFloat(profitTotal) - parseFloat(perteTotal)).toFixed(2);
  const netEmoji = parseFloat(netUSD) >= 0 ? '✅' : '🔴';
  const bestEntry = stats.bestEntryMC < Infinity ? '$' + stats.bestEntryMC.toLocaleString() + ' (' + stats.bestEntryToken + ')' : 'N/A';
  const fastestTP = stats.fastestTPMin < Infinity ? stats.fastestTPMin + ' min (' + stats.fastestTPToken + ')' : 'N/A';
  const bestGain = stats.bestGainPct > 0 ? '+' + stats.bestGainPct + '% (' + stats.bestGainToken + ')' : 'N/A';
  const walletReport = Object.entries(walletStats).map(([w, ws]) => {
    const t = ws.wins + ws.losses;
    const wr = t > 0 ? Math.round((ws.wins / t) * 100) : 0;
    return (ws.disabled ? '🔴' : '🟢') + ' ' + w.slice(0,4) + '...' + w.slice(-4) + ' : ' + wr + '% (' + ws.wins + 'W/' + ws.losses + 'L)';
  }).join('\n');

  const msg = '📊 RAPPORT SESSION — ' + total + ' TOKENS\n'
    + '==================\n'
    + '🏆 TP $6k : ' + stats.wins + ' (' + winRate + '%)\n'
    + '🔴 Stop loss : ' + stats.losses + '\n'
    + '==================\n'
    + '💰 Mise par trade : $' + MISE_USD + '\n'
    + '📈 Gains bruts : +$' + profitTotal + '\n'
    + '📉 Pertes : -$' + perteTotal + '\n'
    + netEmoji + ' NET : ' + (parseFloat(netUSD) >= 0 ? '+' : '') + '$' + netUSD + '\n'
    + '==================\n'
    + '🥇 MEILLEURES PERFS\n'
    + '⚡ Snipe le plus rapide : ' + fastestTP + '\n'
    + '💰 Meilleur gain : ' + bestGain + '\n'
    + '🎯 Meilleure entree : ' + bestEntry + '\n'
    + '==================\n'
    + '👛 WALLETS\n' + walletReport + '\n'
    + '==================\n'
    + 'Win rate global : ' + winRate + '%\n'
    + '==================';
  await sendTelegram(msg);
}

async function listenPumpFun() {
  const pumpKey = new PublicKey(PUMP_PROGRAM);
  connection.onLogs(pumpKey, async (logs) => {
    if (logs.err) return;
    const isCreate = logs.logs.some(l => l.includes('InitializeMint2') || l.includes('Instruction: Create'));
    if (!isCreate) return;
    if (processed.has(logs.signature)) return;
    processed.add(logs.signature);
    try {
      await new Promise(r => setTimeout(r, 1500));
      const tx = await connection.getParsedTransaction(logs.signature, {maxSupportedTransactionVersion: 0});
      if (!tx || !tx.meta) return;
      const post = tx.meta.postTokenBalances || [];
      const pre = tx.meta.preTokenBalances || [];
      const newMints = post.filter(p => !pre.find(b => b.mint === p.mint) && p.mint.endsWith('pump'));
      for (const mintInfo of newMints) {
        const mint = mintInfo.mint;
        const { mc, price, name, score } = await getTokenInfo(mint);
        if (!mc || score < 7) continue;
        if (mc <= ENTRY_MC) {
          await sendTelegram('🆕 NOUVEAU PUMP DETECTE\n==================\n🪙 ' + name + '\n📊 MC : $' + mc.toLocaleString() + '\n💵 PRIX : $' + price + '\n🟢 SCORE : ' + score + '/10\n==================\n⚡ Achat automatique...');
          await executeBuy(mint, name, mc, price, 'PUMP');
        }
      }
    } catch(e) {}
  }, 'confirmed');
}

console.log('Bot PRO demarre');
TARGETS.forEach(w => { const wallet = w.trim(); if (wallet) handleWallet(wallet); });
listenPumpFun();
sendTelegram('🚀 GHOSTCOPY BOT DEMARRE\n==================\nWallets surveilles : ' + TARGETS.length + '\n🔍 Detection Pump.fun active\n⚡ Priority fee : ' + (JITO_FEE / 1000000).toFixed(4) + ' SOL\n🔄 Trailing stop : -' + TRAILING_STOP_PCT + '% du pic\n🛑 Stop loss auto : $' + STOP_LOSS_MC + ' MC\n==================');
if (process.env.NODE_ENV !== 'production') require('dotenv').config();
