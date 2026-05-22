if (process.env.NODE_ENV !== 'production') require('dotenv').config();
const { Connection, PublicKey, Keypair, VersionedTransaction, Transaction, SystemProgram } = require('@solana/web3.js');
const bs58 = require('bs58');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const http = require('http');
const fs = require('fs');

const server = http.createServer((req, res) => { res.writeHead(200); res.end('SNIPER OK'); });
server.listen(3001);

const httpUrl = process.env.RPC_URL || 'https://mainnet.helius-rpc.com/?api-key=' + process.env.HELIUS_API_KEY;
const wsUrl = 'wss://mainnet.helius-rpc.com/?api-key=' + process.env.HELIUS_API_KEY;
const connection = new Connection(httpUrl, { commitment: 'confirmed', wsEndpoint: wsUrl });
const myWallet = Keypair.fromSecretKey(bs58.default.decode(process.env.PRIVATE_KEY));
const SOL = 'So11111111111111111111111111111111111111112';

// PAIEMENT
const PRIX_MENSUEL_SOL = process.env.PRIX_MENSUEL_SOL || '0.5';
const PAYMENT_WALLET = process.env.PAYMENT_WALLET || '';

// PAPER TRADING : node sniper.js --paper  (aucun vrai achat)
const PAPER_MODE = process.argv.includes('--paper') || process.env.PAPER_MODE === 'true';

// COFFRE AUTOMATIQUE
const COFFRE_TRIGGER_USD = 700;
const COFFRE_AMOUNT_USD  = 500;
const TREASURY_WALLET    = process.env.TREASURY_WALLET || '';
let cofrageEnCours = false;

// LIMITE JOURNALIERE
const MAX_DAILY_LOSS_USD = 500;
let dailyLossUSD  = 0;
let dailyLossDate = new Date().toDateString();
let tradingPaused = false;

// CONSTANTES GLOBALES
const SOL_PRICE        = parseFloat(process.env.SOL_PRICE || '170');
const JITO_FEE         = 500000;
const JITO_TIP         = 1000000;
const MONITOR_INTERVAL = 1000;
const MIN_AGE_SEC      = 10;
const MAX_AGE_SEC      = 600;
const MAX_LAST_TRADE_SEC = 120;

// ─── STRATEGIES ──────────────────────────────────────────────────────────────
const STRATEGIES = [
  {
    id: 'low',    emoji: '🟢', name: 'LOW',
    MISE_LAMPORTS: 1764706000,  MISE_USD: 300,
    TP_LEVELS: [25, 60],        SL_PCT: 8,
    MIN_MC: 4000,  MAX_MC: 10000, WATCH_MIN_MC: 3000,
    MIN_HOLDERS: 15, MAX_OPEN: 2,
    MAX_HOLD_MS: 8 * 60 * 1000, SCAN_INTERVAL: 4000,
    MIN_REPLY: 1,
    TRAIL_ACTIVATION_PCT: 20, TRAIL_PCT: 10,
  },
  {
    id: 'medium', emoji: '🟡', name: 'MEDIUM',
    MISE_LAMPORTS: 1764706000,  MISE_USD: 300,
    TP_LEVELS: [20, 50],        SL_PCT: 10,
    MIN_MC: 10000, MAX_MC: 25000, WATCH_MIN_MC: 8000,
    MIN_HOLDERS: 25, MAX_OPEN: 2,
    MAX_HOLD_MS: 8 * 60 * 1000, SCAN_INTERVAL: 5000,
    MIN_REPLY: 2, REQUIRE_SOCIAL: true,
    TRAIL_ACTIVATION_PCT: 20, TRAIL_PCT: 12,
  },
  {
    id: 'high',   emoji: '🔴', name: 'HIGH',
    MISE_LAMPORTS: 1764706000,  MISE_USD: 300,
    TP_LEVELS: [20, 40],        SL_PCT: 10,
    MIN_MC: 25000, MAX_MC: 60000, WATCH_MIN_MC: 20000,
    MIN_HOLDERS: 40, MAX_OPEN: 2,
    MAX_HOLD_MS: 8 * 60 * 1000, SCAN_INTERVAL: 6000,
    MIN_REPLY: 3, REQUIRE_SOCIAL: true,
    TRAIL_ACTIVATION_PCT: 15, TRAIL_PCT: 10,
  },
];

// JITO
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

const ADMIN_ID       = String(process.env.TELEGRAM_CHAT_ID);
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || '@admin';
const SUBSCRIBERS_FILE = './subscribers.json';

let subscribers = {};
try { subscribers = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf8')); } catch(e) { subscribers = {}; }
function saveSubscribers() {
  try { fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(subscribers, null, 2)); } catch(e) {}
}

// ─── ETAT PAR STRATEGIE ───────────────────────────────────────────────────────
const positions = { low: {}, medium: {}, high: {} };
const watchlist  = { low: {}, medium: {}, high: {} };
const stats = {};
for (const s of STRATEGIES) {
  stats[s.id] = { total: 0, wins: 0, losses: 0, skipped: 0,
                  totalGainUSD: 0, totalLossUSD: 0, bestGainPct: 0, bestToken: '' };
}
const sniped = new Set(); // partage entre strategies : evite double achat

// ─── ANTI-RUG ─────────────────────────────────────────────────────────────────
const rugDevs     = new Set(); // wallets dev serial ruggers
const rugNames    = new Set(); // noms de tokens qui ont rugge
const rugTwitters = new Set(); // twitters de tokens qui ont rugge
const tokenMeta   = {};        // { mint: { creator, twitter } } stocke au moment du scan
const devCache    = {};        // cache des resultats isSerialRugger

// ─── CACHE TOKENS (partage entre strategies) ──────────────────────────────────
let tokenCache = [];
let tokenCacheTime = 0;
let tokenCacheFetching = false;
const TOKEN_CACHE_TTL = 5000;

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
async function sendTo(chatId, msg) {
  try {
    await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg })
    });
  } catch(e) {}
}

async function sendTelegram(msg) { await sendTo(ADMIN_ID, msg); }

async function broadcastTelegram(msg, countAsSnipe = false) {
  await sendTo(ADMIN_ID, msg);
  for (const [id, sub] of Object.entries(subscribers)) {
    if (sub.status !== 'active' && sub.status !== 'trial') continue;
    // Verifier expiration 7 jours
    if (sub.status === 'trial' && sub.trialExpiresAt && Date.now() > sub.trialExpiresAt) {
      sub.status = 'expired';
      saveSubscribers();
      await sendTo(id, '⏰ ESSAI 7 JOURS TERMINE\n==================\nVotre essai gratuit est expire.\nContactez ' + ADMIN_USERNAME + ' pour continuer 💎');
      continue;
    }
    await sendTo(id, msg);
    if (countAsSnipe && sub.status === 'trial') {
      sub.snipesUsed = (sub.snipesUsed || 0) + 1;
      saveSubscribers();
    }
  }
}

let lastUpdateId = 0;
async function pollTelegram() {
  try {
    const r = await fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_TOKEN + '/getUpdates?offset=' + (lastUpdateId + 1) + '&limit=10&timeout=0');
    const data = await r.json();
    if (!data.ok || !data.result.length) return;
    for (const update of data.result) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg) continue;
      const userId   = String(msg.from.id);
      const chatId   = String(msg.chat.id);
      const username = msg.from.username ? '@' + msg.from.username : (msg.from.first_name || userId);
      const text     = (msg.text || '').trim();
      const isAdmin  = chatId === ADMIN_ID;
      const cmd      = text.toLowerCase().split(' ')[0];
      const args     = text.split(' ').slice(1);

      if (!isAdmin && !subscribers[userId]) {
        subscribers[userId] = { username, status: 'pending', snipesLeft: 0, snipesUsed: 0, joinedAt: new Date().toISOString().slice(0, 10) };
        saveSubscribers();
        await sendTelegram('🆕 NOUVEAU\n' + username + ' (ID: ' + userId + ')\na contacte le bot.');
      }

      if (cmd === '/start') {
        await sendTo(chatId,
          '👋 Bienvenue sur GhostCopy Sniper!\n==================\n'
          + '🤖 Signaux de snipe Pump.fun en temps reel\n==================\n'
          + '🆓 /trial — Essai gratuit 7 jours\n'
          + '💎 /payer — Acces premium\n==================\n'
          + '/statut — Mon acces\n/aide — Aide'
        );
      } else if (cmd === '/payer' && !isAdmin) {
        const wallet = PAYMENT_WALLET || '(adresse non configuree — contactez ' + ADMIN_USERNAME + ')';
        await sendTo(chatId,
          '💎 ACCES MENSUEL ILLIMITE\n==================\n'
          + '💰 Prix : ' + PRIX_MENSUEL_SOL + ' SOL / mois\n==================\n'
          + '📤 Envoie exactement ' + PRIX_MENSUEL_SOL + ' SOL a :\n\n'
          + wallet + '\n\n==================\n'
          + '✅ Ensuite envoie le lien de ta transaction a ' + ADMIN_USERNAME + '\n'
          + 'Ton acces sera active manuellement sous 24h.\n==================\n'
          + '🆓 Essai gratuit disponible : /trial'
        );
      } else if (cmd === '/trial' && !isAdmin) {
        const sub = subscribers[userId];
        if (sub && sub.status === 'active') {
          await sendTo(chatId, '✅ Vous avez deja un acces actif!\n/statut pour les details.');
        } else if (sub && sub.status === 'trial' && sub.trialExpiresAt && Date.now() < sub.trialExpiresAt) {
          const daysLeft = Math.ceil((sub.trialExpiresAt - Date.now()) / (1000 * 60 * 60 * 24));
          await sendTo(chatId, '✅ Essai en cours — ' + daysLeft + ' jour(s) restant(s).\n/statut pour les details.');
        } else if (sub && sub.status === 'expired') {
          await sendTo(chatId, '⛔ Essai 7 jours termine.\nContactez ' + ADMIN_USERNAME + ' pour un acces complet.');
        } else {
          const trialExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
          subscribers[userId] = { username, status: 'trial', snipesLeft: 999999, snipesUsed: 0, trialExpiresAt, joinedAt: new Date().toISOString().slice(0, 10) };
          saveSubscribers();
          const expireDate = new Date(trialExpiresAt).toLocaleDateString('fr-FR');
          await sendTo(chatId, '🎉 ESSAI 7 JOURS ACTIVE!\n==================\n✅ Acces gratuit pendant 7 jours\n📅 Expire le : ' + expireDate + '\nVous allez recevoir tous les signaux!\n==================\nPour continuer apres l essai → ' + ADMIN_USERNAME);
          await sendTelegram('🆕 ESSAI 7J\n' + username + ' (ID: ' + userId + ')\na active un essai 7 jours.');
        }
      } else if (cmd === '/statut') {
        if (isAdmin) {
          await sendSniperReport();
        } else {
          const sub = subscribers[userId];
          if (!sub || sub.status === 'pending' || sub.status === 'inactive') {
            await sendTo(chatId, '⛔ Pas d\'acces.\n/trial pour essai gratuit\n' + ADMIN_USERNAME + ' pour acces complet');
          } else if (sub.status === 'trial') {
            const daysLeft = sub.trialExpiresAt ? Math.max(0, Math.ceil((sub.trialExpiresAt - Date.now()) / (1000 * 60 * 60 * 24))) : '?';
            const expireDate = sub.trialExpiresAt ? new Date(sub.trialExpiresAt).toLocaleDateString('fr-FR') : '?';
            await sendTo(chatId, '🆓 ESSAI EN COURS\n==================\n📅 ' + daysLeft + ' jour(s) restant(s) (expire le ' + expireDate + ')\n📈 ' + (sub.snipesUsed || 0) + ' signaux recus');
          } else if (sub.status === 'active') {
            await sendTo(chatId, '💎 ACCES COMPLET\n==================\n✅ Illimite\n📈 ' + (sub.snipesUsed || 0) + ' signaux recus');
          } else if (sub.status === 'expired') {
            await sendTo(chatId, '❌ ESSAI EXPIRE\nContactez ' + ADMIN_USERNAME + ' pour continuer.');
          }
        }
      } else if (cmd === '/bilan' && !isAdmin) {
        const sub = subscribers[userId];
        const hasAccess = sub && (sub.status === 'active' || (sub.status === 'trial' && sub.trialExpiresAt && Date.now() < sub.trialExpiresAt));
        if (!hasAccess) {
          await sendTo(chatId, '⛔ Acces requis pour voir le bilan.\n/trial pour 7 jours gratuits.');
        } else {
          await sendPublicReport(chatId);
        }
      } else if (cmd === '/aide') {
        let helpMsg = '🤖 COMMANDES\n==================\n/start — Accueil\n/trial — Essai gratuit 7 jours\n/payer — Acces premium\n/statut — Mon acces\n/bilan — Performance du bot\n/aide — Cette liste';
        if (isAdmin) helpMsg += '\n==================\n👑 ADMIN\n/users — Abonnes\n/activer [id] — Acces illimite\n/trial [id] [n] — Donner N snipes\n/desactiver [id] — Couper acces\n/bilan — Rapport complet\n/positions — Positions';
        await sendTo(chatId, helpMsg);

      } else if (isAdmin) {
        if (cmd === '/bilan') {
          await sendSniperReport();
        } else if (cmd === '/positions') {
          let posMsg = '📊 POSITIONS OUVERTES\n==================\n';
          let totalOpen = 0;
          for (const strat of STRATEGIES) {
            const open = Object.entries(positions[strat.id]).filter(([, p]) => p.status === 'open');
            if (open.length) {
              posMsg += strat.emoji + ' ' + strat.name + ' (' + open.length + '/' + strat.MAX_OPEN + ')\n';
              for (const [mint, pos] of open) {
                posMsg += '  🪙 ' + (pos.name || mint.slice(0, 8)) + ' — ' + Math.round((Date.now() - pos.buyTime) / 60000) + 'min\n';
              }
              totalOpen += open.length;
            }
          }
          if (!totalOpen) await sendTelegram('📭 Aucune position ouverte');
          else await sendTelegram(posMsg);
        } else if (cmd === '/users') {
          const entries = Object.entries(subscribers);
          if (!entries.length) { await sendTelegram('📭 Aucun utilisateur'); }
          else {
            let usersMsg = '👥 ABONNES (' + entries.length + ')\n==================\n';
            for (const [id, sub] of entries) {
              const e = sub.status === 'active' ? '💎' : sub.status === 'trial' ? '🆓' : sub.status === 'expired' ? '❌' : '⏳';
              usersMsg += e + ' ' + (sub.username || id) + ' — ' + sub.status + (sub.status === 'trial' ? ' (' + sub.snipesLeft + ' left)' : '') + '\nID: ' + id + '\n\n';
            }
            await sendTelegram(usersMsg);
          }
        } else if (cmd === '/activer') {
          const targetId = args[0];
          if (!targetId) { await sendTelegram('Usage: /activer [user_id]'); }
          else {
            if (!subscribers[targetId]) subscribers[targetId] = { username: targetId, snipesUsed: 0, joinedAt: new Date().toISOString().slice(0, 10) };
            subscribers[targetId].status = 'active';
            subscribers[targetId].snipesLeft = 999999;
            saveSubscribers();
            await sendTelegram('✅ ' + (subscribers[targetId].username || targetId) + ' — acces illimite active');
            await sendTo(targetId, '🎉 ACCES COMPLET ACTIVE!\n==================\n💎 Vous etes maintenant abonne illimite!\nVous recevrez tous les signaux en temps reel.');
          }
        } else if (cmd === '/trial' && isAdmin) {
          const targetId = args[0];
          const n = parseInt(args[1]) || 50;
          if (!targetId) { await sendTelegram('Usage: /trial [user_id] [snipes]'); }
          else {
            if (!subscribers[targetId]) subscribers[targetId] = { username: targetId, snipesUsed: 0, joinedAt: new Date().toISOString().slice(0, 10) };
            subscribers[targetId].status = 'trial';
            subscribers[targetId].snipesLeft = n;
            saveSubscribers();
            await sendTelegram('✅ ' + (subscribers[targetId].username || targetId) + ' — ' + n + ' snipes offerts');
            await sendTo(targetId, '🎉 ESSAI ACTIVE!\n==================\n🆓 ' + n + ' snipes offerts!\nVous recevrez les signaux en temps reel.');
          }
        } else if (cmd === '/desactiver') {
          const targetId = args[0];
          if (!targetId) { await sendTelegram('Usage: /desactiver [user_id]'); }
          else if (!subscribers[targetId]) { await sendTelegram('❌ Utilisateur introuvable'); }
          else {
            subscribers[targetId].status = 'inactive';
            saveSubscribers();
            await sendTelegram('✅ ' + (subscribers[targetId].username || targetId) + ' — desactive');
            await sendTo(targetId, '⛔ Votre acces a ete suspendu.\nContactez ' + ADMIN_USERNAME + ' pour reactiver.');
          }
        }
      }
    }
  } catch(e) { console.log('[TELEGRAM] Erreur poll : ' + e.message); }
}

// ─── PUMP.FUN API ─────────────────────────────────────────────────────────────
const PUMP_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Origin': 'https://pump.fun',
  'Referer': 'https://pump.fun/',
};

async function fetchPumpList(sort) {
  const urls = [
    'https://frontend-api-v3.pump.fun/coins?sort=' + sort + '&order=DESC&offset=0&limit=50',
    'https://frontend-api.pump.fun/coins?sort=' + sort + '&order=DESC&offset=0&limit=100',
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: PUMP_HEADERS });
      if (!r.ok) { console.log('[API] ' + url.split('/')[2] + ' → HTTP ' + r.status); continue; }
      const data = await r.json();
      const list = Array.isArray(data) ? data : (data.coins || data.data || data.tokens || []);
      if (list.length > 0) { console.log('[API] ' + list.length + ' tokens via ' + url.split('/')[2]); return list; }
    } catch(e) { console.log('[API] Erreur ' + e.message); }
  }
  return [];
}

async function getPumpTokens() {
  const [list1, list2] = await Promise.all([
    fetchPumpList('created_timestamp'),
    fetchPumpList('last_trade_unix_time'),
  ]);
  const seen = new Set();
  const merged = [];
  for (const coin of [...list1, ...list2]) {
    if (coin.mint && !seen.has(coin.mint)) { seen.add(coin.mint); merged.push(coin); }
  }
  return merged;
}

// Verifie si un dev a cree 3+ tokens qui ont tous plafonne a < $3k (serial rugger)
async function isSerialRugger(creator) {
  if (creator in devCache) return devCache[creator];
  if (rugDevs.has(creator)) return (devCache[creator] = true);
  try {
    const r = await fetch('https://frontend-api-v3.pump.fun/coins/user-created-coins/' + creator + '?offset=0&limit=10&includeNsfw=true', { headers: PUMP_HEADERS });
    if (!r.ok) return (devCache[creator] = false);
    const data = await r.json();
    const coins = Array.isArray(data) ? data : (data.coins || data.data || []);
    if (coins.length < 3) return (devCache[creator] = false);
    const allLow = coins.every(c => (c.usd_market_cap || 0) < 3000);
    if (allLow) rugDevs.add(creator);
    return (devCache[creator] = allLow);
  } catch(e) { return (devCache[creator] = false); }
}

// Enregistre un rug dans les blacklists (nom, twitter, dev)
function trackRug(mint, name) {
  rugNames.add(name.toLowerCase());
  const meta = tokenMeta[mint];
  if (meta) {
    if (meta.creator) { rugDevs.add(meta.creator); devCache[meta.creator] = true; }
    if (meta.twitter) rugTwitters.add(meta.twitter.toLowerCase());
    delete tokenMeta[mint];
  }
}

async function getTokenCache() {
  if (Date.now() - tokenCacheTime < TOKEN_CACHE_TTL) return tokenCache;
  if (tokenCacheFetching) { await new Promise(r => setTimeout(r, 500)); return tokenCache; }
  tokenCacheFetching = true;
  try {
    const fresh = await getPumpTokens();
    if (fresh.length > 0) { tokenCache = fresh; tokenCacheTime = Date.now(); }
  } finally { tokenCacheFetching = false; }
  return tokenCache;
}

// ─── MISE INTELLIGENTE ───────────────────────────────────────────────────────
function calculateMise(coin, strat) {
  let score = 0;
  const holders = coin.holder_count || 0;
  const replies  = coin.reply_count  || 0;
  if (holders >= 50) score += 2; else if (holders >= 30) score += 1;
  if (replies  >= 5) score += 2; else if (replies  >= 2) score += 1;
  if (coin.twitter && coin.website) score += 2;
  else if (coin.twitter || coin.website) score += 1;
  // score 0-6 → multiplicateur de mise
  const pct = score >= 5 ? 1.0 : score >= 3 ? 0.75 : 0.5;
  return {
    lamports: Math.round(strat.MISE_LAMPORTS * pct),
    usd:      Math.round(strat.MISE_USD      * pct),
    score,
    pct: Math.round(pct * 100),
  };
}

// ─── LIMITE JOURNALIERE ───────────────────────────────────────────────────────
function checkDailyReset() {
  const today = new Date().toDateString();
  if (today !== dailyLossDate) {
    dailyLossDate = today;
    dailyLossUSD  = 0;
    if (tradingPaused) {
      tradingPaused = false;
      sendTelegram('🌅 NOUVEAU JOUR — Trading reprend\n💰 Limite journaliere remise a zero ($' + MAX_DAILY_LOSS_USD + ')');
    }
  }
}

function addDailyLoss(amount) {
  dailyLossUSD += amount;
  if (dailyLossUSD >= MAX_DAILY_LOSS_USD && !tradingPaused) {
    tradingPaused = true;
    sendTelegram(
      '🛑 LIMITE JOURNALIERE ATTEINTE\n==================\n'
      + '💸 Pertes du jour : -$' + dailyLossUSD.toFixed(0) + '\n'
      + '🔒 Trading pause jusqu\'a demain minuit\n'
      + '📅 Reprend automatiquement demain'
    );
  }
}

async function getPumpCoin(mint) {
  const urls = [
    'https://frontend-api-v3.pump.fun/coins/' + mint,
    'https://frontend-api.pump.fun/coins/' + mint,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: PUMP_HEADERS });
      if (!r.ok) continue;
      return await r.json();
    } catch(e) {}
  }
  return null;
}

// ─── JITO / SWAP ──────────────────────────────────────────────────────────────
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

async function sellToken(mint, slippageBps = 500, sellPct = 100) {
  if (PAPER_MODE) return 'PAPER';
  try {
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
      myWallet.publicKey, { mint: new PublicKey(mint) }
    );
    if (!tokenAccounts.value.length) return null;
    const fullBalance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.amount;
    if (fullBalance === '0') return null;
    const balance = sellPct >= 100 ? fullBalance : String(Math.floor(Number(fullBalance) * sellPct / 100));
    if (balance === '0') return null;
    const qr = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=' + mint + '&outputMint=' + SOL + '&amount=' + balance + '&slippageBps=' + slippageBps);
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

// ─── COFFRE ───────────────────────────────────────────────────────────────────
async function getSolPrice() {
  try {
    const r = await fetch('https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112');
    const data = await r.json();
    return data?.data?.['So11111111111111111111111111111111111111112']?.price || 0;
  } catch(e) { return 0; }
}

function getTotalNet() {
  let gain = 0, loss = 0;
  for (const s of STRATEGIES) { gain += stats[s.id].totalGainUSD; loss += stats[s.id].totalLossUSD; }
  return gain - loss;
}

async function coffreTresorie() {
  if (cofrageEnCours) return;
  cofrageEnCours = true;
  try {
    if (!TREASURY_WALLET) {
      await sendTelegram('⚠️ COFFRE : configure TREASURY_WALLET sur Render !');
      cofrageEnCours = false; return;
    }
    const solPrice = await getSolPrice();
    if (!solPrice) { await sendTelegram('⚠️ COFFRE : impossible de recuperer le prix SOL'); cofrageEnCours = false; return; }
    const lamports = Math.round((COFFRE_AMOUNT_USD / solPrice) * 1e9);
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ recentBlockhash: blockhash, feePayer: myWallet.publicKey })
      .add(SystemProgram.transfer({ fromPubkey: myWallet.publicKey, toPubkey: new PublicKey(TREASURY_WALLET), lamports }));
    tx.sign(myWallet);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    for (const s of STRATEGIES) { stats[s.id].totalGainUSD = 0; stats[s.id].totalLossUSD = 0; }
    const solEnvoye = (lamports / 1e9).toFixed(3);
    await sendTelegram(
      '🏦 COFFRE AUTOMATIQUE\n==================\n'
      + '💰 $' + COFFRE_AMOUNT_USD + ' coffrés (' + solEnvoye + ' SOL @ $' + Math.round(solPrice) + ')\n'
      + '🔄 Nouveau cycle — stats remises a zero\n'
      + '🔗 https://solscan.io/tx/' + sig
    );
  } catch(e) { await sendTelegram('⚠️ COFFRE ECHEC : ' + e.message); }
  cofrageEnCours = false;
}

async function checkCoffre() {
  if (getTotalNet() >= COFFRE_TRIGGER_USD) await coffreTresorie();
}

// ─── RAPPORT ──────────────────────────────────────────────────────────────────
async function sendPublicReport(chatId) {
  let grandTotal = 0, grandWins = 0, grandGain = 0, grandLoss = 0;
  for (const s of STRATEGIES) {
    grandTotal += stats[s.id].total;
    grandWins  += stats[s.id].wins;
    grandGain  += stats[s.id].totalGainUSD;
    grandLoss  += stats[s.id].totalLossUSD;
  }
  const globalNet = grandGain - grandLoss;
  const globalWR  = grandTotal > 0 ? Math.round((grandWins / grandTotal) * 100) : 0;
  let msg = '📊 PERFORMANCE GHOSTCOPY\n==================\n';
  for (const strat of STRATEGIES) {
    const s = stats[strat.id];
    const wr  = s.total > 0 ? Math.round((s.wins / s.total) * 100) : 0;
    const net = s.totalGainUSD - s.totalLossUSD;
    msg += strat.emoji + ' ' + strat.name + ' — ' + s.total + ' trades | ' + wr + '% WR | ' + (net >= 0 ? '+' : '') + '$' + net.toFixed(0) + '\n';
  }
  msg += '==================\n';
  msg += '📈 Total : ' + grandTotal + ' trades | ' + globalWR + '% WR\n';
  msg += (globalNet >= 0 ? '✅' : '🔴') + ' NET : ' + (globalNet >= 0 ? '+' : '') + '$' + globalNet.toFixed(0) + '\n';
  msg += '==================\n💎 /payer pour acces illimite';
  await sendTo(chatId, msg);
}

async function sendSniperReport() {
  let msg = '📊 BILAN SNIPER\n==================\n';
  let grandTotal = 0, grandWins = 0, grandGain = 0, grandLoss = 0;

  for (const strat of STRATEGIES) {
    const s = stats[strat.id];
    const wr  = s.total > 0 ? Math.round((s.wins / s.total) * 100) : 0;
    const net = s.totalGainUSD - s.totalLossUSD;
    msg += strat.emoji + ' ' + strat.name + ' — $' + strat.MISE_USD + '/mise\n';
    msg += '  Trades : ' + s.total + ' | Wins : ' + s.wins + ' | Losses : ' + s.losses + ' | WR : ' + wr + '%\n';
    msg += '  TP : +' + strat.TP_LEVELS.join('/+') + '% | SL : -' + strat.SL_PCT + '%\n';
    msg += '  NET : ' + (net >= 0 ? '+' : '') + '$' + net.toFixed(0);
    if (s.bestToken) msg += ' | 🥇 +' + s.bestGainPct + '% (' + s.bestToken + ')';
    msg += '\n\n';
    grandTotal += s.total; grandWins += s.wins;
    grandGain  += s.totalGainUSD; grandLoss += s.totalLossUSD;
  }

  const globalNet = grandGain - grandLoss;
  const globalWR  = grandTotal > 0 ? Math.round((grandWins / grandTotal) * 100) : 0;
  let reco;
  if (globalWR >= 40 && globalNet > 0) reco = '💹 RENTABLE — Continue !';
  else if (globalWR >= 30) reco = '⚖️ PROCHE — Encore quelques trades';
  else reco = '⚠️ EN DESSOUS — Marche difficile';

  msg += '==================\n';
  msg += '📊 TOTAL : ' + grandTotal + ' trades | ' + globalWR + '% WR\n';
  msg += (globalNet >= 0 ? '✅' : '🔴') + ' NET : ' + (globalNet >= 0 ? '+' : '') + '$' + globalNet.toFixed(0) + '\n';
  msg += '==================\n' + reco;
  await sendTelegram(msg);
}

// ─── MONITORING POSITION ──────────────────────────────────────────────────────
async function monitorSnipe(mint, name, entryMC, buyTime, strat, miseUsd) {
  const st     = stats[strat.id];
  const prefix = strat.emoji + ' ' + strat.name;
  const MISE   = miseUsd || strat.MISE_USD; // mise reelle utilisee pour ce trade
  let consecutiveZeros = 0;
  let lastMC     = entryMC;
  let highestMC  = entryMC;
  let slMC       = Math.round(entryMC * (1 - strat.SL_PCT / 100));
  let trailActive = false;
  const TRAIL_ACTIVATION_PCT = strat.TRAIL_ACTIVATION_PCT || 15;
  const TRAIL_PCT            = strat.TRAIL_PCT            || 12;
  let tpIndex = 0;
  const tpMCs = strat.TP_LEVELS.map(pct => Math.round(entryMC * (1 + pct / 100)));

  const interval = setInterval(async () => {
    try {
      const coin = await getPumpCoin(mint);
      const mc   = coin ? Math.round(coin.usd_market_cap || 0) : 0;

      // RUG : MC = 0
      if (!mc) {
        consecutiveZeros++;
        if (consecutiveZeros >= 1) {
          clearInterval(interval);
          delete positions[strat.id][mint];
          st.losses++; st.totalLossUSD += MISE; addDailyLoss(MISE);
          trackRug(mint, name);
          const sig = await sellToken(mint, 3000);
          await broadcastTelegram(
            '💀 RUG [' + prefix + ']\n==================\n🪙 ' + name + '\n'
            + '📉 Perte totale : -$' + MISE + '\n'
            + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle')
          );
          if (st.total % 10 === 0) sendSniperReport();
          checkCoffre();
        }
        return;
      }
      consecutiveZeros = 0;

      // TIMEOUT
      if (Date.now() - buyTime > strat.MAX_HOLD_MS) {
        clearInterval(interval);
        const gainPct = Math.round((mc / entryMC - 1) * 100);
        const gainUSD = (gainPct / 100) * MISE;
        delete positions[strat.id][mint];
        if (gainUSD >= 0) { st.wins++; st.totalGainUSD += gainUSD; }
        else              { st.losses++; st.totalLossUSD += Math.abs(gainUSD); addDailyLoss(Math.abs(gainUSD)); }
        const sig = await sellToken(mint, 1000);
        const dureeMin = Math.round((Date.now() - buyTime) / 60000);
        await broadcastTelegram(
          '⏰ TIMEOUT [' + prefix + ']\n==================\n🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' | Sortie : $' + mc.toLocaleString() + '\n'
          + (gainPct >= 0 ? '💰 +' : '📉 ') + gainPct + '% (' + (gainUSD >= 0 ? '+' : '') + '$' + gainUSD.toFixed(0) + ')\n'
          + '⏱ Duree : ' + dureeMin + ' min\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle')
        );
        if (st.total % 10 === 0) sendSniperReport();
        checkCoffre();
        return;
      }

      // DUMP -30%
      const dropPct = lastMC > 0 ? Math.round((mc / lastMC - 1) * 100) : 0;
      lastMC = mc;
      if (dropPct <= -15) {
        clearInterval(interval);
        const gainPct  = Math.round((mc / entryMC - 1) * 100);
        const perteUSD = Math.abs((gainPct / 100) * MISE);
        st.losses++; st.totalLossUSD += perteUSD; addDailyLoss(perteUSD);
        trackRug(mint, name);
        delete positions[strat.id][mint];
        const sig = await sellToken(mint, 3000);
        const dureeMin = Math.round((Date.now() - buyTime) / 60000);
        await broadcastTelegram(
          '📉 DUMP -' + Math.abs(dropPct) + '% [' + prefix + ']\n==================\n🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' | Sortie : $' + mc.toLocaleString() + '\n'
          + '📉 Perte : -$' + perteUSD.toFixed(0) + ' | ' + dureeMin + ' min\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle')
        );
        if (st.total % 10 === 0) sendSniperReport();
        checkCoffre();
        return;
      }

      const gainPct  = Math.round((mc / entryMC - 1) * 100);
      const dureeMin = Math.round((Date.now() - buyTime) / 60000);

      // TRAILING STOP LOSS
      if (mc > highestMC) {
        highestMC = mc;
        // MOON : verrouillage SL a TRAIL_LOCK_MC (ex: $20k)
        if (strat.TRAIL_LOCK_MC && highestMC >= strat.TRAIL_LOCK_MC && slMC < strat.TRAIL_LOCK_MC) {
          slMC = strat.TRAIL_LOCK_MC;
          trailActive = true;
          sendTelegram('🔒 SL VERROUILLE [' + prefix + ']\n🪙 ' + name + '\n📈 MC : $' + mc.toLocaleString() + '\n🛑 SL fixe a $' + strat.TRAIL_LOCK_MC.toLocaleString() + ' — profit garanti !');
        }
        const gainFromEntry = (highestMC / entryMC - 1) * 100;
        if (gainFromEntry >= TRAIL_ACTIVATION_PCT) {
          const newTrailSL = Math.round(highestMC * (1 - TRAIL_PCT / 100));
          if (newTrailSL > slMC) {
            if (!trailActive) {
              trailActive = true;
              sendTelegram('🔒 TRAILING ACTIF [' + prefix + ']\n🪙 ' + name + '\n📈 Haut : $' + highestMC.toLocaleString() + '\n🛑 SL garanti : $' + newTrailSL.toLocaleString() + ' (' + Math.round((newTrailSL / entryMC - 1) * 100) + '% / entree)');
            }
            slMC = newTrailSL;
          }
        }
      }

      console.log('[' + strat.id.toUpperCase() + '] ' + name + ' | $' + mc.toLocaleString() + ' (' + (gainPct >= 0 ? '+' : '') + gainPct + '%) | SL $' + slMC.toLocaleString() + (trailActive ? ' 🔒' : '') + ' | ' + dureeMin + 'min');

      // TP_MC : vente totale quand MC atteint la cible (strategie MOON)
      if (strat.TP_MC && mc >= strat.TP_MC) {
        clearInterval(interval);
        const gainUSD = ((mc - entryMC) / entryMC) * MISE;
        st.wins++; st.totalGainUSD += gainUSD;
        delete positions[strat.id][mint];
        const sig = await sellToken(mint, 500, 100);
        await broadcastTelegram(
          '🌙 TP MOON $' + mc.toLocaleString() + ' [' + prefix + ']\n==================\n🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' → $' + mc.toLocaleString() + '\n'
          + '💰 +$' + gainUSD.toFixed(0) + ' (+' + Math.round((mc/entryMC-1)*100) + '%)\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle'),
          true
        );
        if (st.total % 10 === 0) sendSniperReport();
        checkCoffre();
        return;
      }

      // MULTI-TP
      while (tpIndex < strat.TP_LEVELS.length && mc >= tpMCs[tpIndex]) {
        const level  = strat.TP_LEVELS[tpIndex];
        const isLast = tpIndex === strat.TP_LEVELS.length - 1;
        const gainUSD = (level / 100) * MISE / strat.TP_LEVELS.length;
        st.totalGainUSD += gainUSD;
        if (tpIndex === 0) slMC = entryMC;
        if (level > st.bestGainPct) { st.bestGainPct = level; st.bestToken = name; }
        const sellPct = isLast ? 100 : Math.round(100 / (strat.TP_LEVELS.length - tpIndex));
        const sig = await sellToken(mint, 500, sellPct);
        await broadcastTelegram(
          '🏆 TP' + (tpIndex + 1) + '/' + strat.TP_LEVELS.length + ' +' + level + '% [' + prefix + ']\n==================\n🪙 ' + name + '\n'
          + '📊 MC : $' + mc.toLocaleString() + ' | Entree : $' + entryMC.toLocaleString() + '\n'
          + '💰 +$' + gainUSD.toFixed(0) + ' vendu\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle')
        );
        tpIndex++;
        if (isLast) {
          clearInterval(interval);
          st.wins++;
          delete positions[strat.id][mint];
          if (st.total % 10 === 0) sendSniperReport();
          checkCoffre();
          return;
        }
      }

      // SL / TRAILING SL / BREAK-EVEN
      if (mc <= slMC) {
        clearInterval(interval);
        const realGainPct = Math.round((mc / entryMC - 1) * 100);
        const realGainUSD = (realGainPct / 100) * MISE;
        if (trailActive || tpIndex > 0) {
          st.wins++;
          st.totalGainUSD += Math.max(0, realGainUSD);
        } else {
          st.losses++;
          st.totalLossUSD += (strat.SL_PCT / 100) * MISE;
          addDailyLoss((strat.SL_PCT / 100) * MISE);
        }
        delete positions[strat.id][mint];
        const sig = await sellToken(mint, 800, 100);
        const profitDeja = strat.TP_LEVELS.slice(0, tpIndex).reduce((acc, pct) => acc + (pct / 100) * MISE / strat.TP_LEVELS.length, 0);
        const label = trailActive ? '🔒 TRAILING SL +' + realGainPct + '%' : tpIndex > 0 ? '✅ BREAK-EVEN' : '🛑 SL -' + strat.SL_PCT + '%';
        await broadcastTelegram(
          label + ' [' + prefix + ']\n==================\n🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' | Haut : $' + highestMC.toLocaleString() + ' | Sortie : $' + mc.toLocaleString() + '\n'
          + (trailActive || tpIndex > 0 ? '💰 Profit : +$' + (profitDeja + Math.max(0, realGainUSD)).toFixed(0) : '💸 Perte : -$' + ((strat.SL_PCT / 100) * MISE).toFixed(0)) + '\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '⚠️ Vente manuelle')
        );
        if (st.total % 10 === 0) sendSniperReport();
        checkCoffre();
      }
    } catch(e) {}
  }, MONITOR_INTERVAL);
}

// ─── DCA SNIPE ────────────────────────────────────────────────────────────────
async function dcaSnipe(mint, name, entryMC, strat) {
  if (STRATEGIES.some(s => positions[s.id][mint])) return;
  if (Object.keys(positions[strat.id]).length >= strat.MAX_OPEN) return;
  positions[strat.id][mint] = { status: 'open', buyTime: Date.now(), sig: 'DCA', name };

  const st           = stats[strat.id];
  const STEP         = strat.DCA_STEP_USD;
  const MAX_ENTRIES  = strat.DCA_MAX_ENTRIES;
  const SELL_DROP    = strat.DCA_SELL_DROP;
  const SOL_PER_STEP = Math.round((STEP / SOL_PRICE) * 1e9); // lamports par entree

  let entries    = [{ mc: entryMC, usd: STEP }];
  let highestMC  = entryMC;
  let lastMC     = entryMC;
  let selling    = false;
  let soldCount  = 0;
  let totalGain  = 0;
  st.total++;
  sniped.add(mint);

  await broadcastTelegram(
    '🔵 [DCA] ENTREE 1/' + MAX_ENTRIES + '\n==================\n'
    + '🪙 ' + name + '\n'
    + '📊 MC : $' + entryMC.toLocaleString() + '\n'
    + '💰 Achat : $' + STEP + ' | Total max : $' + (STEP * MAX_ENTRIES),
    true
  );

  if (!PAPER_MODE) {
    // Premier achat reel
    try {
      const qr = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=' + SOL + '&outputMint=' + mint + '&amount=' + SOL_PER_STEP + '&slippageBps=2000');
      const q  = await qr.json();
      if (q.outAmount) {
        const sr = await fetch('https://api.jup.ag/swap/v1/swap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteResponse: q, userPublicKey: myWallet.publicKey.toString(), wrapAndUnwrapSol: true, prioritizationFeeLamports: JITO_FEE }) });
        const sd = await sr.json();
        if (sd.swapTransaction) {
          const buf = Buffer.from(sd.swapTransaction, 'base64');
          const vtx = VersionedTransaction.deserialize(buf);
          vtx.sign([myWallet]);
          await submitViaJito(vtx);
        }
      }
    } catch(e) { console.log('[DCA] Erreur achat 1 : ' + e.message); }
  }

  const interval = setInterval(async () => {
    try {
      const coin = await getPumpCoin(mint);
      const mc   = coin ? Math.round(coin.usd_market_cap || 0) : 0;

      // RUG
      if (!mc) {
        clearInterval(interval);
        delete positions[strat.id][mint];
        const totalInvested = entries.length * STEP;
        st.losses++; st.totalLossUSD += totalInvested; addDailyLoss(totalInvested);
        await broadcastTelegram('💀 RUG [DCA 🔵]\n🪙 ' + name + '\n💸 Perte : -$' + totalInvested, true);
        return;
      }

      if (mc > highestMC) highestMC = mc;

      // PHASE ACHAT : MC monte → nouvelle entree
      if (!selling && entries.length < MAX_ENTRIES && mc > lastMC) {
        entries.push({ mc, usd: STEP });
        const totalInvested = entries.length * STEP;
        await broadcastTelegram(
          '🔵 [DCA] ENTREE ' + entries.length + '/' + MAX_ENTRIES + '\n🪙 ' + name + '\n'
          + '💰 $' + STEP + ' @ $' + mc.toLocaleString() + ' MC | Total : $' + totalInvested,
          true
        );
        if (!PAPER_MODE) {
          try {
            const qr = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=' + SOL + '&outputMint=' + mint + '&amount=' + SOL_PER_STEP + '&slippageBps=2000');
            const q  = await qr.json();
            if (q.outAmount) {
              const sr = await fetch('https://api.jup.ag/swap/v1/swap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quoteResponse: q, userPublicKey: myWallet.publicKey.toString(), wrapAndUnwrapSol: true, prioritizationFeeLamports: JITO_FEE }) });
              const sd = await sr.json();
              if (sd.swapTransaction) {
                const buf = Buffer.from(sd.swapTransaction, 'base64');
                const vtx = VersionedTransaction.deserialize(buf);
                vtx.sign([myWallet]);
                await submitViaJito(vtx);
              }
            }
          } catch(e) { console.log('[DCA] Erreur achat ' + entries.length + ' : ' + e.message); }
        }
      }

      const avgEntry    = entries.reduce((s, e) => s + e.mc, 0) / entries.length;
      const gainPct     = (mc / avgEntry - 1) * 100;
      const dropFromHigh = (mc / highestMC - 1) * 100;

      // DECLENCHER VENTE : -5% depuis le haut ET en profit OU max entrees atteint en profit
      if (!selling && gainPct > 0 && (dropFromHigh <= -SELL_DROP || entries.length >= MAX_ENTRIES)) {
        selling = true;
        await broadcastTelegram(
          '🔄 [DCA] VENTE EN COURS\n🪙 ' + name + '\n'
          + '📊 Prix moyen : $' + Math.round(avgEntry).toLocaleString() + '\n'
          + '📈 MC actuel : $' + mc.toLocaleString() + ' (+' + gainPct.toFixed(1) + '%)\n'
          + '💰 Vente $' + STEP + '/sec...',
          true
        );
      }

      // SL DUR : MC sous premiere entree -10%
      const hardSL = entries[0].mc * (1 - strat.SL_PCT / 100);
      if (!selling && mc <= hardSL) {
        clearInterval(interval);
        delete positions[strat.id][mint];
        const totalInvested = entries.length * STEP;
        const perte = totalInvested * (strat.SL_PCT / 100);
        st.losses++; st.totalLossUSD += perte; addDailyLoss(perte);
        if (!PAPER_MODE) await sellToken(mint, 800, 100);
        await broadcastTelegram(
          '🛑 [DCA] SL -' + strat.SL_PCT + '%\n🪙 ' + name + '\n'
          + '📊 ' + entries.length + ' entrees | Total : $' + totalInvested + '\n'
          + '💸 Perte : -$' + perte.toFixed(0),
          true
        );
        return;
      }

      // PHASE VENTE : vend une entree par seconde
      if (selling && soldCount < entries.length) {
        const entry    = entries[soldCount];
        const gain     = (mc / entry.mc - 1) * STEP;
        totalGain     += gain;
        soldCount++;
        if (!PAPER_MODE) await sellToken(mint, 500, Math.round(100 / entries.length));
        if (soldCount === entries.length) {
          // Tout vendu
          clearInterval(interval);
          delete positions[strat.id][mint];
          const totalInvested = entries.length * STEP;
          if (totalGain >= 0) { st.wins++; st.totalGainUSD += totalGain; }
          else                { st.losses++; st.totalLossUSD += Math.abs(totalGain); addDailyLoss(Math.abs(totalGain)); }
          await broadcastTelegram(
            (totalGain >= 0 ? '✅' : '❌') + ' [DCA] TERMINE\n==================\n🪙 ' + name + '\n'
            + '📊 ' + entries.length + ' entrees | $' + totalInvested + ' investi\n'
            + '💰 Net : ' + (totalGain >= 0 ? '+' : '') + '$' + totalGain.toFixed(0) + '\n'
            + '📈 ROI : ' + (totalGain / totalInvested * 100).toFixed(1) + '%',
            true
          );
          checkCoffre();
        }
      }

      lastMC = mc;
    } catch(e) {}
  }, 1000);
}

// ─── ACHAT ────────────────────────────────────────────────────────────────────
async function snipe(mint, name, entryMC, strat, miseLamports, miseUsd, score) {
  if (tradingPaused) return;
  if (STRATEGIES.some(s => positions[s.id][mint])) return;
  if (Object.keys(positions[strat.id]).length >= strat.MAX_OPEN) return;
  positions[strat.id][mint] = { status: 'buying' };
  const st = stats[strat.id];
  const effectiveLamports = miseLamports || strat.MISE_LAMPORTS;
  const effectiveUsd      = miseUsd      || strat.MISE_USD;

  // ── MODE PAPER : simulation sans vrai achat ───────────────────────────────
  if (PAPER_MODE) {
    const buyTime = Date.now();
    positions[strat.id][mint] = { status: 'open', buyTime, sig: 'PAPER', name };
    st.total++;
    sniped.add(mint);
    const tpStr = strat.TP_LEVELS.map((tp, idx) => 'TP' + (idx + 1) + ' +' + tp + '%').join(' | ');
    await broadcastTelegram(
      '🎯 SNIPE [' + strat.emoji + ' ' + strat.name + ']\n==================\n'
      + '🪙 ' + name + '\n'
      + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n==================\n'
      + '💰 Mise : $' + effectiveUsd + '\n'
      + '📐 ' + tpStr + '\n'
      + '🛑 SL : -' + strat.SL_PCT + '%\n==================\n'
      + '📊 https://dexscreener.com/solana/' + mint,
      true
    );
    monitorSnipe(mint, name, entryMC, buyTime, strat, effectiveUsd);
    return;
  }

  // ── MODE REEL ─────────────────────────────────────────────────────────────
  for (let i = 1; i <= 3; i++) {
    try {
      const qr = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=' + SOL + '&outputMint=' + mint + '&amount=' + effectiveLamports + '&slippageBps=2000');
      const q  = await qr.json();
      if (!q.outAmount) {
        if (i === 3) { delete positions[strat.id][mint]; await sendTelegram('❌ ECHEC\n🪙 ' + name + '\nNon swappable'); }
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
      positions[strat.id][mint] = { status: 'open', buyTime, sig, name };
      st.total++;
      sniped.add(mint);

      const tpStr = strat.TP_LEVELS.map((tp, idx) => 'TP' + (idx + 1) + ' +' + tp + '%').join(' | ');
      await broadcastTelegram(
        '🎯 SNIPE [' + strat.emoji + ' ' + strat.name + ']\n==================\n'
        + '🪙 ' + name + '\n'
        + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n==================\n'
        + '💰 Mise : $' + effectiveUsd + '\n'
        + '📐 ' + tpStr + '\n'
        + '🛑 SL : -' + strat.SL_PCT + '% (-$' + (effectiveUsd * strat.SL_PCT / 100).toFixed(0) + ') → break-even apres TP1\n==================\n'
        + '🔗 https://solscan.io/tx/' + sig + '\n'
        + '📊 https://dexscreener.com/solana/' + mint,
        true
      );
      monitorSnipe(mint, name, entryMC, buyTime, strat, effectiveUsd);
      break;
    } catch(e) {
      console.log('Tentative ' + i + ' : ' + e.message);
      if (i === 3) delete positions[strat.id][mint];
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ─── WATCHLIST ────────────────────────────────────────────────────────────────
async function checkWatchlist(strat) {
  const entries = Object.entries(watchlist[strat.id]);
  if (!entries.length) return;
  for (const [mint, info] of entries) {
    if (sniped.has(mint) || STRATEGIES.some(s => positions[s.id][mint])) { delete watchlist[strat.id][mint]; continue; }
    if (Date.now() - info.addedAt > MAX_AGE_SEC * 1000) { delete watchlist[strat.id][mint]; continue; }
    try {
      const coin = await getPumpCoin(mint);
      const mc   = coin ? Math.round(coin.usd_market_cap || 0) : 0;
      if (!mc) { delete watchlist[strat.id][mint]; continue; }
      console.log('[WATCH/' + strat.id.toUpperCase() + '] ' + info.name + ' | $' + mc.toLocaleString() + ' → seuil $' + strat.MIN_MC.toLocaleString());
      if (mc >= strat.MIN_MC && mc <= strat.MAX_MC) {
        delete watchlist[strat.id][mint];
        if (Object.keys(positions[strat.id]).length < strat.MAX_OPEN) {
          console.log('[ENTRY/' + strat.id.toUpperCase() + '] ' + info.name + ' → ACHAT $' + mc.toLocaleString());
          if (strat.mode === 'dca') {
            await dcaSnipe(mint, info.name, mc, strat);
          } else {
            const mise = calculateMise(coin, strat);
            await snipe(mint, info.name, mc, strat, mise.lamports, mise.usd, mise.score);
          }
        }
      }
    } catch(e) {}
  }
}

// ─── SCAN ─────────────────────────────────────────────────────────────────────
async function scanPumpFun(strat) {
  try {
    const tokens = await getTokenCache();
    if (!tokens || tokens.length === 0) {
      console.log('[SCAN/' + strat.id.toUpperCase() + '] API injoignable — retry');
      return;
    }

    const st  = stats[strat.id];
    const now = Date.now() / 1000;
    let total = 0, tooYoung = 0, tooOld = 0, mcLow = 0, mcHigh = 0, inactive = 0, candidates = 0;

    for (const coin of tokens) {
      if (!coin.mint || sniped.has(coin.mint)) continue;
      if (STRATEGIES.some(s => positions[s.id][coin.mint])) continue;
      if (watchlist[strat.id][coin.mint]) continue;
      total++;

      const createdSec  = coin.created_timestamp > 1e12 ? coin.created_timestamp / 1000 : coin.created_timestamp;
      const ageSec      = now - createdSec;
      const mc          = Math.round(coin.usd_market_cap || 0);
      const lastTradeRaw = coin.last_trade_unix_time || 0;
      const lastTradeSec = lastTradeRaw > 1e12 ? now - (lastTradeRaw / 1000) : (lastTradeRaw > 0 ? now - lastTradeRaw : 0);
      const name        = coin.symbol || coin.name || coin.mint.slice(0, 8);

      if (ageSec < MIN_AGE_SEC)                                  { tooYoung++; continue; }
      if (ageSec > MAX_AGE_SEC)                                  { tooOld++;   continue; }
      if (coin.complete)                                         continue;
      if (lastTradeSec > MAX_LAST_TRADE_SEC && lastTradeRaw > 0) { inactive++;  continue; }
      if (coin.holder_count > 0 && coin.holder_count < strat.MIN_HOLDERS) { st.skipped++; continue; }

      // Blacklists anti-rug rapides (verification instantanee)
      if (rugNames.has(name.toLowerCase()))                      { st.skipped++; continue; }
      if (rugDevs.has(coin.creator))                             { st.skipped++; continue; }
      if (coin.twitter && rugTwitters.has((coin.twitter || '').toLowerCase())) { st.skipped++; continue; }

      // Filtres anti-rug par strategie
      if (strat.MIN_REPLY && (coin.reply_count || 0) < strat.MIN_REPLY)    { st.skipped++; continue; }
      if (strat.REQUIRE_SOCIAL && !coin.twitter && !coin.website)           { st.skipped++; continue; }

      if (mc >= strat.WATCH_MIN_MC && mc < strat.MIN_MC) {
        watchlist[strat.id][coin.mint] = { name, addedAt: Date.now() };
        console.log('[WATCH/' + strat.id.toUpperCase() + '] ' + name + ' | $' + mc.toLocaleString());
        continue;
      }

      if (mc < strat.MIN_MC)  { mcLow++;  continue; }
      if (mc > strat.MAX_MC)  { mcHigh++; continue; }

      candidates++;
      console.log('[' + strat.id.toUpperCase() + '] CANDIDAT ' + name + ' | $' + mc.toLocaleString() + ' | age ' + Math.round(ageSec) + 's');

      if (Object.keys(positions[strat.id]).length >= strat.MAX_OPEN) { st.skipped++; continue; }

      // Stocker les metadata du token pour tracking si rug
      if (coin.creator || coin.twitter) {
        tokenMeta[coin.mint] = { creator: coin.creator || null, twitter: coin.twitter || null };
      }

      // Check serial rugger (appel API uniquement pour les candidats finaux)
      if (coin.creator && await isSerialRugger(coin.creator)) {
        console.log('[SKIP/' + strat.id.toUpperCase() + '] ' + name + ' — dev serial rugger');
        st.skipped++; continue;
      }

      if (strat.mode === 'dca') {
        await dcaSnipe(coin.mint, name, mc, strat);
      } else {
        const mise = calculateMise(coin, strat);
        console.log('[MISE/' + strat.id.toUpperCase() + '] ' + name + ' | score ' + mise.score + ' → $' + mise.usd + ' (' + mise.pct + '%)');
        await snipe(coin.mint, name, mc, strat, mise.lamports, mise.usd, mise.score);
      }
      break;
    }

    console.log('[' + strat.id.toUpperCase() + '] ' + total + ' tokens | jeunes:' + tooYoung + ' vieux:' + tooOld + ' MC-:' + mcLow + ' MC+:' + mcHigh + ' inactifs:' + inactive + ' skips:' + st.skipped + ' watch:' + Object.keys(watchlist[strat.id]).length + ' → ' + candidates + ' candidat(s)');
  } catch(e) {
    console.log('[SCAN/' + strat.id.toUpperCase() + '] Erreur : ' + e.message);
  }
}

// ─── DEMARRAGE ────────────────────────────────────────────────────────────────
async function startSniper() {
  console.log('[SNIPER] v1 — 3 strategies');
  const lines = STRATEGIES.map(s =>
    s.emoji + ' ' + s.name + ' — $' + s.MISE_USD + '/mise | $' + s.MIN_MC.toLocaleString() + '-$' + s.MAX_MC.toLocaleString() + ' | TP +' + s.TP_LEVELS.join('/+') + '% | SL -' + s.SL_PCT + '% | ≥' + s.MIN_HOLDERS + ' holders'
  ).join('\n');
  await sendTelegram(
    '🎯 SNIPER v1 — 3 STRATEGIES\n'
    + '==================\n'
    + lines + '\n==================\n'
    + '💀 Rug detecte en 1s | ⏰ Timeout auto\n📉 Dump detecte : vente immediate\n⚡ Jito bundles actifs\n'
    + '==================\n'
    + '/bilan /positions /aide'
  );

  setInterval(() => checkDailyReset(), 60 * 1000);

  for (const strat of STRATEGIES) {
    setInterval(() => scanPumpFun(strat), strat.SCAN_INTERVAL);
    setInterval(() => checkWatchlist(strat), 3000);
    scanPumpFun(strat);
  }
  setInterval(() => pollTelegram(), 3000);
}

startSniper();
