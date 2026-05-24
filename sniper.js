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


// CONSTANTES GLOBALES
const SOL_PRICE        = parseFloat(process.env.SOL_PRICE || '170');
const JITO_FEE         = 500000;
const JITO_TIP         = 1000000;
const MONITOR_INTERVAL = 1000;
const MIN_AGE_SEC      = 30;   // token doit avoir au moins 30s d existence
const MAX_AGE_SEC      = 300;  // pas plus de 5 min (apres c est mort)
const MAX_LAST_TRADE_SEC = 60; // trade recent < 60s (token actif)

// ─── STRATEGIES ──────────────────────────────────────────────────────────────
const STRATEGIES = [
  {
    id: 'sniper', emoji: '🎯', name: 'SNIPER',
    configId: 'v2', // incremente a chaque changement de reglages : v1, v2, v3...
    MISE_LAMPORTS: 1764706000, MISE_USD: 300,
    TP_LEVELS: [20, 50, 100],
    SL_PCT: 20,
    SL_MC: 0,
    MIN_MC: 9000, MAX_MC: 11000, WATCH_MIN_MC: 7000,
    MIN_HOLDERS: 30, MAX_OPEN: 2,
    MAX_HOLD_MS: 15 * 60 * 1000, SCAN_INTERVAL: 3000,
    MIN_REPLY: 3,
    REQUIRE_TWITTER: false,
    GRADUATED_ONLY: false,
    TRAIL_ACTIVATION_PCT: 20, TRAIL_PCT: 10,
    CONFIRM_SEC: 5,
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

// ─── HISTORIQUE DES TRADES ────────────────────────────────────────────────────
const TRADES_FILE = './trades.json';
let tradeHistory = [];
try { tradeHistory = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8')); } catch(e) { tradeHistory = []; }

function logTrade(data) {
  tradeHistory.push(data);
  try { fs.writeFileSync(TRADES_FILE, JSON.stringify(tradeHistory, null, 2)); } catch(e) {}
}

let subscribers = {};
try { subscribers = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf8')); } catch(e) { subscribers = {}; }
function saveSubscribers() {
  try { fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(subscribers, null, 2)); } catch(e) {}
}

// ─── ETAT PAR STRATEGIE ───────────────────────────────────────────────────────
const positions = {};
const watchlist  = {};
for (const s of STRATEGIES) { positions[s.id] = {}; watchlist[s.id] = {}; }
const stats = {};
for (const s of STRATEGIES) {
  stats[s.id] = { total: 0, wins: 0, losses: 0, skipped: 0,
                  totalGainUSD: 0, totalLossUSD: 0, bestGainPct: 0, bestToken: '' };
}
const sniped = new Set(); // partage entre strategies : evite double achat

// ─── ANTI-RUG ─────────────────────────────────────────────────────────────────
const rugDevs     = new Set();
const rugNames    = new Set();
const rugTwitters = new Set();

// Mots cles associes aux rugs (recherche dans le nom du token)
const RUG_KEYWORDS = ['elon','trump','doge','shib','inu','safe','moon','1000x','100x','gem','based','chad','pepe','wojak','bonk','floki','baby','mini','meta','ai','gpt','claim','airdrop','presale'];

function hasRugKeyword(name) {
  const n = name.toLowerCase();
  return RUG_KEYWORDS.some(k => n.includes(k));
}
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
        if (isAdmin) helpMsg += '\n==================\n👑 ADMIN\n/bilan — Rapport complet\n/analyse — Analyse des performances\n/positions — Positions ouvertes\n/users — Abonnes\n/activer [id] — Acces illimite\n/trial [id] [n] — Donner N snipes\n/desactiver [id] — Couper acces';
        await sendTo(chatId, helpMsg);

      } else if (isAdmin) {
        if (cmd === '/bilan') {
          await sendSniperReport();
        } else if (cmd === '/analyse') {
          await sendAnalyse();
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

// ─── DEXSCREENER API ─────────────────────────────────────────────────────────
let dexProfileCache = [];
let dexProfileCacheTime = 0;
const DEX_PROFILE_TTL = 15000;

async function fetchDex(url) {
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    return await r.json();
  } catch(e) { return null; }
}

async function getDexPair(mint) {
  const data = await fetchDex('https://api.dexscreener.com/latest/dex/tokens/' + mint);
  if (!data?.pairs?.length) return null;
  return data.pairs.find(p => p.dexId === 'pumpfun')
      || data.pairs.find(p => p.dexId === 'raydium')
      || data.pairs[0];
}

async function getLatestDexProfiles() {
  if (Date.now() - dexProfileCacheTime < DEX_PROFILE_TTL) return dexProfileCache;
  const data = await fetchDex('https://api.dexscreener.com/token-profiles/latest/v1');
  if (!Array.isArray(data)) return dexProfileCache;
  dexProfileCache = data.filter(t => t.chainId === 'solana').map(t => t.tokenAddress);
  dexProfileCacheTime = Date.now();
  return dexProfileCache;
}

async function getDexBatch(addresses) {
  if (!addresses.length) return [];
  const chunk = addresses.slice(0, 30).join(',');
  const data = await fetchDex('https://api.dexscreener.com/latest/dex/tokens/' + chunk);
  return data?.pairs || [];
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

// ─── ANALYSE ─────────────────────────────────────────────────────────────────
async function sendAnalyse() {
  if (tradeHistory.length < 5) {
    await sendTelegram('📊 Pas encore assez de trades (' + tradeHistory.length + '/5 minimum).');
    return;
  }
  const trades = tradeHistory;
  const total  = trades.length;
  const wins   = trades.filter(t => t.gainUSD > 0).length;
  const wr     = Math.round((wins / total) * 100);
  const netUSD = trades.reduce((s, t) => s + t.gainUSD, 0);
  const ev     = (netUSD / total).toFixed(1);

  // Repartition des sorties
  const byOutcome = {};
  for (const t of trades) { byOutcome[t.outcome] = (byOutcome[t.outcome] || 0) + 1; }
  const outcomeStr = Object.entries(byOutcome).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => k + ':' + v).join(' | ');

  // Analyse par heure (top 3 meilleures heures)
  const byHour = {};
  for (const t of trades) {
    if (!byHour[t.hour]) byHour[t.hour] = { total: 0, net: 0 };
    byHour[t.hour].total++;
    byHour[t.hour].net += t.gainUSD;
  }
  const topHours = Object.entries(byHour)
    .filter(([, v]) => v.total >= 2)
    .sort((a, b) => (b[1].net / b[1].total) - (a[1].net / a[1].total))
    .slice(0, 3)
    .map(([h, v]) => h + 'h(' + (v.net >= 0 ? '+' : '') + Math.round(v.net / v.total) + '$/t)')
    .join(' ');

  // Analyse par holders
  const byHolders = { low: { total: 0, net: 0 }, mid: { total: 0, net: 0 }, high: { total: 0, net: 0 } };
  for (const t of trades) {
    const k = t.holders < 15 ? 'low' : t.holders < 30 ? 'mid' : 'high';
    byHolders[k].total++;
    byHolders[k].net += t.gainUSD;
  }
  const holdersStr = Object.entries(byHolders)
    .filter(([, v]) => v.total > 0)
    .map(([k, v]) => {
      const label = k === 'low' ? '<15h' : k === 'mid' ? '15-30h' : '>30h';
      return label + ':' + (v.net >= 0 ? '+' : '') + Math.round(v.net / v.total) + '$/t';
    }).join(' | ');

  // Duree moyenne win vs loss
  const winsData  = trades.filter(t => t.gainUSD > 0);
  const lossData  = trades.filter(t => t.gainUSD < 0);
  const avgWinDur = winsData.length > 0 ? Math.round(winsData.reduce((s, t) => s + t.durationMin, 0) / winsData.length) : 0;
  const avgLosDur = lossData.length > 0 ? Math.round(lossData.reduce((s, t) => s + t.durationMin, 0) / lossData.length) : 0;
  const avgWin    = winsData.length > 0 ? Math.round(winsData.reduce((s, t) => s + t.gainUSD, 0) / winsData.length) : 0;
  const avgLoss   = lossData.length > 0 ? Math.round(Math.abs(lossData.reduce((s, t) => s + t.gainUSD, 0)) / lossData.length) : 0;

  let msg = '📊 ANALYSE — ' + total + ' TRADES\n==================\n';
  msg += '📈 ' + wins + ' wins / ' + (total - wins) + ' losses | ' + wr + '% WR\n';
  msg += (netUSD >= 0 ? '✅' : '📉') + ' NET : ' + (netUSD >= 0 ? '+' : '') + '$' + Math.round(netUSD) + ' | EV : ' + (parseFloat(ev) >= 0 ? '+' : '') + ev + '$/trade\n';
  msg += '==================\n';
  msg += '🎯 Sorties : ' + outcomeStr + '\n';
  msg += '⏱ Win avg : ' + avgWinDur + 'min (+$' + avgWin + ') | Loss avg : ' + avgLosDur + 'min (-$' + avgLoss + ')\n';
  msg += '==================\n';
  if (topHours) msg += '🕐 Meilleures heures : ' + topHours + '\n';
  if (holdersStr) msg += '👥 Holders : ' + holdersStr + '\n';
  msg += '==================\n';

  // Recommandations automatiques
  const rugs  = trades.filter(t => t.outcome === 'rug').length;
  const dumps = trades.filter(t => t.outcome === 'dump').length;
  msg += '💡 RECOMMANDATIONS\n';
  if (rugs / total > 0.3)  msg += '• ' + Math.round(rugs / total * 100) + '% de rugs — augmenter MIN_HOLDERS\n';
  if (dumps / total > 0.2) msg += '• ' + Math.round(dumps / total * 100) + '% de dumps — verifier les entrees\n';
  if (wr < 35) msg += '• WR < 35% — filtres trop laxistes, serrer les conditions\n';
  if (avgWin < avgLoss) msg += '• Gain moyen (+$' + avgWin + ') < Perte moyenne (-$' + avgLoss + ') — TP trop tot ou SL trop serré\n';
  if (wr >= 40 && parseFloat(ev) > 0) msg += '• Config rentable ! Continuer ainsi\n';

  await sendTelegram(msg);
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
  msg += '📈 ' + grandTotal + ' trades | ' + globalWR + '% WR\n';
  msg += (globalNet >= 0 ? '✅' : '📉') + ' NET : ' + (globalNet >= 0 ? '+' : '') + '$' + globalNet.toFixed(0) + '\n';
  msg += '==================\n💎 /payer pour acces illimite';
  await sendTo(chatId, msg);
}

function stratConfigLine(s) {
  const slInfo = s.SL_MC ? 'SL $' + s.SL_MC.toLocaleString() + ' MC' : 'SL -' + s.SL_PCT + '%';
  const twitter = s.REQUIRE_TWITTER ? ' | Twitter ✅' : '';
  const mode = s.GRADUATED_ONLY ? '🎓 TOKENS GRADUES (rug impossible)\n' : '';
  return '⚙️ CONFIG ACTIVE\n'
    + mode
    + '  Zone : $' + s.MIN_MC.toLocaleString() + ' – $' + s.MAX_MC.toLocaleString() + ' MC\n'
    + '  Mise : $' + s.MISE_USD + ' | TP +' + s.TP_LEVELS.join('/+') + '% | ' + slInfo + '\n'
    + '  Holders ≥' + s.MIN_HOLDERS + twitter + '\n'
    + '  Confirm : ' + s.CONFIRM_SEC + 's | Max hold : ' + (s.MAX_HOLD_MS / 60000) + 'min';
}

async function sendSniperReport() {
  let grandTotal = 0, grandWins = 0, grandGain = 0, grandLoss = 0;
  for (const strat of STRATEGIES) {
    const s = stats[strat.id];
    grandTotal += s.total; grandWins += s.wins;
    grandGain  += s.totalGainUSD; grandLoss += s.totalLossUSD;
  }
  const globalNet = grandGain - grandLoss;
  const globalWR  = grandTotal > 0 ? Math.round((grandWins / grandTotal) * 100) : 0;

  let msg = '📊 BILAN GHOSTCOPY\n==================\n';
  for (const strat of STRATEGIES) {
    const s   = stats[strat.id];
    const wr  = s.total > 0 ? Math.round((s.wins / s.total) * 100) : 0;
    const net = s.totalGainUSD - s.totalLossUSD;
    msg += strat.emoji + ' ' + strat.name + '\n';
    msg += '  ' + s.total + ' trades | ✅ ' + s.wins + ' | ❌ ' + s.losses + ' | ' + wr + '% WR\n';
    msg += '  NET : ' + (net >= 0 ? '+' : '') + '$' + net.toFixed(0);
    if (s.bestToken) msg += ' | 🏆 +' + s.bestGainPct + '% ' + s.bestToken;
    msg += '\n';
  }
  msg += '==================\n';
  msg += '📈 ' + grandTotal + ' trades | ' + globalWR + '% WR\n';
  msg += (globalNet >= 0 ? '✅' : '📉') + ' NET : ' + (globalNet >= 0 ? '+' : '') + '$' + globalNet.toFixed(0) + '\n';
  msg += '==================\n';
  for (const strat of STRATEGIES) msg += stratConfigLine(strat) + '\n';
  await sendTelegram(msg);
}

// ─── MONITORING POSITION ──────────────────────────────────────────────────────
async function monitorSnipe(mint, name, entryMC, buyTime, strat, miseUsd, meta = {}) {
  const st     = stats[strat.id];
  const prefix = strat.emoji + ' ' + strat.name;
  const MISE   = miseUsd || strat.MISE_USD;
  const entryHour = new Date().getHours();
  let consecutiveZeros = 0;
  let lastMC     = entryMC;
  let highestMC  = entryMC;
  let slMC       = strat.SL_MC ? strat.SL_MC : Math.round(entryMC * (1 - strat.SL_PCT / 100));
  let trailActive = false;
  const TRAIL_ACTIVATION_PCT = strat.TRAIL_ACTIVATION_PCT || 15;
  const TRAIL_PCT            = strat.TRAIL_PCT            || 12;
  let tpIndex = 0;
  const tpMCs = strat.TP_LEVELS.map(pct => Math.round(entryMC * (1 + pct / 100)));

  const pollMs = strat.GRADUATED_ONLY ? 5000 : MONITOR_INTERVAL;
  const interval = setInterval(async () => {
    try {
      let mc;
      if (strat.GRADUATED_ONLY) {
        const pair = await getDexPair(mint);
        mc = pair ? Math.round(pair.fdv || pair.marketCap || 0) : 0;
      } else {
        const coin = await getPumpCoin(mint);
        mc = coin ? Math.round(coin.usd_market_cap || 0) : 0;
      }

      // RUG : MC tombe a 0
      if (!mc) {
        consecutiveZeros++;
        if (consecutiveZeros >= 1) {
          clearInterval(interval);
          delete positions[strat.id][mint];
          st.losses++; st.totalLossUSD += MISE;
          logTrade({ date: new Date().toISOString(), name, mint, strategy: strat.id, configId: strat.configId || 'v0', entryMC, exitMC: 0, durationMin: Math.round((Date.now() - buyTime) / 60000), outcome: 'rug', tpsHit: tpIndex, gainUSD: -MISE, gainPct: -100, mise: MISE, holders: meta.holders || 0, replies: meta.replies || 0, ageSec: meta.ageSec || 0, hour: entryHour });
          trackRug(mint, name);
          await sellToken(mint, 3000);
          await broadcastTelegram(
            '💀 RUG — ' + prefix + '\n==================\n'
            + '🪙 ' + name + '\n'
            + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n'
            + '💸 Perte : -$' + MISE
          );
          if (st.total % 5 === 0) sendSniperReport();
        }
        return;
      }
      consecutiveZeros = 0;

      const gainPct  = Math.round((mc / entryMC - 1) * 100);
      const dureeMin = Math.round((Date.now() - buyTime) / 60000);

      // TIMEOUT
      if (Date.now() - buyTime > strat.MAX_HOLD_MS) {
        clearInterval(interval);
        const gainUSD = (gainPct / 100) * MISE;
        delete positions[strat.id][mint];
        if (gainUSD >= 0) { st.wins++; st.totalGainUSD += gainUSD; }
        else              { st.losses++; st.totalLossUSD += Math.abs(gainUSD); }
        logTrade({ date: new Date().toISOString(), name, mint, strategy: strat.id, configId: strat.configId || 'v0', entryMC, exitMC: mc, durationMin: dureeMin, outcome: 'timeout', tpsHit: tpIndex, gainUSD: Math.round(gainUSD), gainPct, mise: MISE, holders: meta.holders || 0, replies: meta.replies || 0, ageSec: meta.ageSec || 0, hour: entryHour });
        const sig = await sellToken(mint, 1000);
        await broadcastTelegram(
          '⏰ TIMEOUT — ' + prefix + '\n==================\n'
          + '🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' | Sortie : $' + mc.toLocaleString() + '\n'
          + (gainPct >= 0 ? '💰 +' : '📉 ') + gainPct + '% (' + (gainUSD >= 0 ? '+' : '') + '$' + gainUSD.toFixed(0) + ')\n'
          + '⏱ ' + dureeMin + ' min\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '')
        );
        if (st.total % 5 === 0) sendSniperReport();
        return;
      }

      // DUMP -15% en 1 seconde
      const dropPct = lastMC > 0 ? Math.round((mc / lastMC - 1) * 100) : 0;
      lastMC = mc;
      if (dropPct <= -15) {
        clearInterval(interval);
        const perteUSD = Math.abs((gainPct / 100) * MISE);
        st.losses++; st.totalLossUSD += perteUSD;
        logTrade({ date: new Date().toISOString(), name, mint, strategy: strat.id, configId: strat.configId || 'v0', entryMC, exitMC: mc, durationMin: dureeMin, outcome: 'dump', tpsHit: tpIndex, gainUSD: -Math.round(perteUSD), gainPct, mise: MISE, holders: meta.holders || 0, replies: meta.replies || 0, ageSec: meta.ageSec || 0, hour: entryHour });
        trackRug(mint, name);
        delete positions[strat.id][mint];
        const sig = await sellToken(mint, 3000);
        await broadcastTelegram(
          '📉 DUMP -' + Math.abs(dropPct) + '% — ' + prefix + '\n==================\n'
          + '🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' | Sortie : $' + mc.toLocaleString() + '\n'
          + '💸 Perte : -$' + perteUSD.toFixed(0) + ' | ' + dureeMin + ' min\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '')
        );
        if (st.total % 5 === 0) sendSniperReport();
        return;
      }

      // TRAILING STOP LOSS
      if (mc > highestMC) {
        highestMC = mc;
        const gainFromEntry = (highestMC / entryMC - 1) * 100;
        if (gainFromEntry >= TRAIL_ACTIVATION_PCT) {
          const newTrailSL = Math.round(highestMC * (1 - TRAIL_PCT / 100));
          if (newTrailSL > slMC) {
            if (!trailActive) {
              trailActive = true;
              sendTelegram(
                '🔒 TRAILING ACTIF — ' + prefix + '\n==================\n'
                + '🪙 ' + name + '\n'
                + '📈 Pic : $' + highestMC.toLocaleString() + ' (+' + Math.round(gainFromEntry) + '%)\n'
                + '🛑 SL garanti : $' + newTrailSL.toLocaleString()
              );
            }
            slMC = newTrailSL;
          }
        }
      }

      console.log('[' + strat.id.toUpperCase() + '] ' + name + ' | $' + mc.toLocaleString() + ' (' + (gainPct >= 0 ? '+' : '') + gainPct + '%) | SL $' + slMC.toLocaleString() + (trailActive ? ' 🔒' : '') + ' | ' + dureeMin + 'min');

      // MULTI-TP : vente partielle a chaque niveau
      while (tpIndex < strat.TP_LEVELS.length && mc >= tpMCs[tpIndex]) {
        const level  = strat.TP_LEVELS[tpIndex];
        const isLast = tpIndex === strat.TP_LEVELS.length - 1;
        const gainUSD = (level / 100) * MISE / strat.TP_LEVELS.length;
        st.totalGainUSD += gainUSD;
        if (tpIndex === 0) slMC = entryMC; // break-even apres TP1
        if (level > st.bestGainPct) { st.bestGainPct = level; st.bestToken = name; }
        const sellPct = isLast ? 100 : Math.round(100 / (strat.TP_LEVELS.length - tpIndex));
        const sig = await sellToken(mint, 500, sellPct);
        const remaining = isLast ? 0 : (strat.TP_LEVELS.length - tpIndex - 1);
        await broadcastTelegram(
          '✅ TP' + (tpIndex + 1) + ' +' + level + '% — ' + prefix + '\n==================\n'
          + '🪙 ' + name + '\n'
          + '📊 MC : $' + mc.toLocaleString() + ' | Entree : $' + entryMC.toLocaleString() + '\n'
          + '💰 +$' + gainUSD.toFixed(0) + ' encaisse\n'
          + (isLast ? '🏁 Position fermee' : '🎯 ' + remaining + ' TP restant(s) | SL deplace a l\'entree\n'
            + (sig ? '🔗 https://solscan.io/tx/' + sig : ''))
        );
        tpIndex++;
        if (isLast) {
          clearInterval(interval);
          st.wins++;
          const totalPnl = strat.TP_LEVELS.reduce((acc, pct) => acc + (pct / 100) * MISE / strat.TP_LEVELS.length, 0);
          logTrade({ date: new Date().toISOString(), name, mint, strategy: strat.id, configId: strat.configId || 'v0', entryMC, exitMC: mc, durationMin: dureeMin, outcome: 'tp_full', tpsHit: strat.TP_LEVELS.length, gainUSD: Math.round(totalPnl), gainPct: strat.TP_LEVELS[strat.TP_LEVELS.length - 1], mise: MISE, holders: meta.holders || 0, replies: meta.replies || 0, ageSec: meta.ageSec || 0, hour: entryHour });
          delete positions[strat.id][mint];
          if (st.total % 5 === 0) sendSniperReport();
          return;
        }
      }

      // SL / TRAILING SL / BREAK-EVEN
      if (mc <= slMC) {
        clearInterval(interval);
        const realGainPct = Math.round((mc / entryMC - 1) * 100);
        const realGainUSD = (realGainPct / 100) * MISE;
        const profitDeja  = strat.TP_LEVELS.slice(0, tpIndex).reduce((acc, pct) => acc + (pct / 100) * MISE / strat.TP_LEVELS.length, 0);
        const totalProfit = profitDeja + Math.max(0, realGainUSD);
        if (trailActive || tpIndex > 0) {
          st.wins++;
          st.totalGainUSD += Math.max(0, realGainUSD);
        } else {
          const slLoss = Math.abs(realGainUSD);
          st.losses++;
          st.totalLossUSD += slLoss;
        }
        const outcome = trailActive ? 'trailing_sl' : tpIndex > 0 ? 'breakeven' : 'sl';
        logTrade({ date: new Date().toISOString(), name, mint, strategy: strat.id, configId: strat.configId || 'v0', entryMC, exitMC: mc, durationMin: dureeMin, outcome, tpsHit: tpIndex, gainUSD: Math.round(trailActive || tpIndex > 0 ? totalProfit : -Math.abs(realGainUSD)), gainPct: realGainPct, mise: MISE, holders: meta.holders || 0, replies: meta.replies || 0, ageSec: meta.ageSec || 0, hour: entryHour });
        delete positions[strat.id][mint];
        const sig = await sellToken(mint, 800, 100);
        const label = trailActive ? '🔒 TRAILING SL +' + realGainPct + '%'
                    : tpIndex > 0 ? '✅ BREAK-EVEN'
                    : '🛑 STOP LOSS';
        await broadcastTelegram(
          label + ' — ' + prefix + '\n==================\n'
          + '🪙 ' + name + '\n'
          + '📊 Entree : $' + entryMC.toLocaleString() + ' | Pic : $' + highestMC.toLocaleString() + ' | Sortie : $' + mc.toLocaleString() + '\n'
          + (trailActive || tpIndex > 0
            ? '💰 Profit total : +$' + totalProfit.toFixed(0)
            : '💸 Perte : -$' + Math.abs(realGainUSD).toFixed(0)) + '\n'
          + (sig ? '🔗 https://solscan.io/tx/' + sig : '')
        );
        if (st.total % 5 === 0) sendSniperReport();
      }
    } catch(e) {}
  }, pollMs);
}


// ─── ACHAT ────────────────────────────────────────────────────────────────────
async function snipe(mint, name, entryMC, strat, miseLamports, miseUsd, score, meta = {}) {
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
    const tpLines = strat.TP_LEVELS.map((tp, idx) => {
      const tpMC = Math.round(entryMC * (1 + tp / 100));
      return '  TP' + (idx + 1) + ' +' + tp + '% → $' + tpMC.toLocaleString();
    }).join('\n');
    const slInfo = strat.SL_MC ? '$' + strat.SL_MC.toLocaleString() + ' MC' : '-' + strat.SL_PCT + '%';
    await broadcastTelegram(
      '🎯 SNIPE — ' + strat.name + '\n==================\n'
      + '🪙 ' + name + '\n'
      + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n'
      + '💰 Mise : $' + effectiveUsd + '\n==================\n'
      + tpLines + '\n'
      + '🛑 SL : ' + slInfo + '\n==================\n'
      + '📊 https://dexscreener.com/solana/' + mint,
      true
    );
    monitorSnipe(mint, name, entryMC, buyTime, strat, effectiveUsd, meta);
    return;
  }

  // ── MODE REEL ─────────────────────────────────────────────────────────────
  for (let i = 1; i <= 3; i++) {
    try {
      const qr = await fetch('https://api.jup.ag/swap/v1/quote?inputMint=' + SOL + '&outputMint=' + mint + '&amount=' + effectiveLamports + '&slippageBps=2000');
      const q  = await qr.json();
      if (!q.outAmount) {
        if (i === 3) { delete positions[strat.id][mint]; await sendTelegram('❌ ' + name + ' — swap impossible'); }
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

      const tpLines = strat.TP_LEVELS.map((tp, idx) => {
        const tpMC = Math.round(entryMC * (1 + tp / 100));
        return '  TP' + (idx + 1) + ' +' + tp + '% → $' + tpMC.toLocaleString();
      }).join('\n');
      const slInfo = strat.SL_MC ? '$' + strat.SL_MC.toLocaleString() + ' MC' : '-' + strat.SL_PCT + '%';
      await broadcastTelegram(
        '🎯 SNIPE — ' + strat.name + '\n==================\n'
        + '🪙 ' + name + '\n'
        + '📊 Entree : $' + entryMC.toLocaleString() + ' MC\n'
        + '💰 Mise : $' + effectiveUsd + '\n==================\n'
        + tpLines + '\n'
        + '🛑 SL : ' + slInfo + '\n==================\n'
        + '🔗 https://solscan.io/tx/' + sig + '\n'
        + '📊 https://dexscreener.com/solana/' + mint,
        true
      );
      monitorSnipe(mint, name, entryMC, buyTime, strat, effectiveUsd, meta);
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
          const coinMeta = { holders: coin.holder_count || 0, replies: coin.reply_count || 0, ageSec: 0, hour: new Date().getHours() };
          await snipe(mint, info.name, mc, strat, strat.MISE_LAMPORTS, strat.MISE_USD, 0, coinMeta);
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

      if (strat.GRADUATED_ONLY) {
        // Mode tokens gradues : on veut uniquement les complete=true (rug impossible)
        if (!coin.complete) continue;
      } else {
        // Mode bonding curve : tokens frais non gradues
        if (ageSec < MIN_AGE_SEC)  { tooYoung++; continue; }
        if (ageSec > MAX_AGE_SEC)  { tooOld++;   continue; }
        if (coin.complete)         continue;
      }
      if (lastTradeSec > MAX_LAST_TRADE_SEC && lastTradeRaw > 0) { inactive++;  continue; }

      // MC check EN PREMIER — evite de filtrer des tokens hors zone inutilement
      if (mc >= strat.WATCH_MIN_MC && mc < strat.MIN_MC) {
        watchlist[strat.id][coin.mint] = { name, addedAt: Date.now() };
        continue;
      }
      if (mc < strat.MIN_MC)  { mcLow++;  continue; }
      if (mc > strat.MAX_MC)  { mcHigh++; continue; }

      // Qualite (appliquee uniquement aux tokens dans la zone de prix)
      if (strat.MIN_HOLDERS > 0 && coin.holder_count > 0 && coin.holder_count < strat.MIN_HOLDERS) { st.skipped++; continue; }
      if (strat.MIN_REPLY   > 0 && (coin.reply_count || 0) < strat.MIN_REPLY)                      { st.skipped++; continue; }
      if (strat.REQUIRE_TWITTER && !coin.twitter)                                                    { st.skipped++; continue; }

      // Blacklists anti-rug rapides
      if (rugNames.has(name.toLowerCase()))                                                         { st.skipped++; continue; }
      if (rugDevs.has(coin.creator))                                                                { st.skipped++; continue; }
      if (coin.twitter && rugTwitters.has((coin.twitter || '').toLowerCase()))                      { st.skipped++; continue; }

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

      // Confirmation : attendre CONFIRM_SEC secondes et re-verifier que le MC tient ET monte
      if (strat.CONFIRM_SEC) {
        const mcAtDetection = mc;
        await new Promise(r => setTimeout(r, strat.CONFIRM_SEC * 1000));
        if (sniped.has(coin.mint) || STRATEGIES.some(s => positions[s.id][coin.mint])) continue;
        const fresh = await getPumpCoin(coin.mint);
        const freshMC = fresh ? Math.round(fresh.usd_market_cap || 0) : 0;
        if (!freshMC || freshMC < strat.MIN_MC || freshMC > strat.MAX_MC * 1.3) {
          console.log('[SKIP/' + strat.id.toUpperCase() + '] ' + name + ' — confirmation echouee ($' + freshMC.toLocaleString() + ')');
          st.skipped++; continue;
        }
        // Filtre momentum : on n achete que si le MC monte activement (+3% minimum)
        if (freshMC < mcAtDetection * 1.03) {
          console.log('[SKIP/' + strat.id.toUpperCase() + '] ' + name + ' — momentum insuffisant ($' + mcAtDetection.toLocaleString() + ' → $' + freshMC.toLocaleString() + ')');
          st.skipped++; continue;
        }
        const trend = freshMC >= mcAtDetection ? '↑' : '→';
        console.log('[CONFIRM/' + strat.id.toUpperCase() + '] ' + name + ' — $' + mcAtDetection.toLocaleString() + ' ' + trend + ' $' + freshMC.toLocaleString() + ' OK');
      }

      const coinMeta = { holders: coin.holder_count || 0, replies: coin.reply_count || 0, ageSec: Math.round(ageSec), hour: new Date().getHours() };
      await snipe(coin.mint, name, mc, strat, strat.MISE_LAMPORTS, strat.MISE_USD, 0, coinMeta);
      break;
    }

    console.log('[' + strat.id.toUpperCase() + '] ' + total + ' tokens | jeunes:' + tooYoung + ' vieux:' + tooOld + ' MC-:' + mcLow + ' MC+:' + mcHigh + ' inactifs:' + inactive + ' skips:' + st.skipped + ' watch:' + Object.keys(watchlist[strat.id]).length + ' → ' + candidates + ' candidat(s)');
  } catch(e) {
    console.log('[SCAN/' + strat.id.toUpperCase() + '] Erreur : ' + e.message);
  }
}

// ─── SCAN DEXSCREENER (tokens gradues) ───────────────────────────────────────
async function scanDexScreener(strat) {
  try {
    const st = stats[strat.id];
    const addresses = await getLatestDexProfiles();
    if (!addresses.length) { console.log('[DEX] Aucun profil disponible'); return; }

    const pairs = await getDexBatch(addresses);
    const seen  = new Set();
    let candidates = 0;

    for (const pair of pairs) {
      if (pair.chainId !== 'solana') continue;
      const mint = pair.baseToken?.address;
      if (!mint || seen.has(mint)) continue;
      seen.add(mint);

      if (sniped.has(mint)) continue;
      if (STRATEGIES.some(s => positions[s.id][mint])) continue;

      const mc        = Math.round(pair.fdv || pair.marketCap || 0);
      const liquidity = pair.liquidity?.usd || 0;
      const pairAgeMs = pair.pairCreatedAt ? Date.now() - pair.pairCreatedAt : 99999999;
      const name      = pair.baseToken?.symbol || mint.slice(0, 8);

      if (mc < strat.MIN_MC || mc > strat.MAX_MC)                         continue;
      if (liquidity < 3000)                                                continue;
      if (pairAgeMs > 2 * 60 * 60 * 1000)                                 continue; // max 2h depuis creation
      if (strat.GRADUATED_ONLY && pair.dexId !== 'pumpfun' && pair.dexId !== 'raydium') continue;
      if (rugNames.has(name.toLowerCase()))                                { st.skipped++; continue; }

      candidates++;
      console.log('[DEX] CANDIDAT ' + name + ' | $' + mc.toLocaleString() + ' MC | $' + Math.round(liquidity).toLocaleString() + ' liq | ' + pair.dexId + ' | ' + Math.round(pairAgeMs / 60000) + 'min');

      if (Object.keys(positions[strat.id]).length >= strat.MAX_OPEN) { st.skipped++; continue; }

      // Confirmation + filtre momentum
      if (strat.CONFIRM_SEC) {
        const mcAtDetection = mc;
        await new Promise(r => setTimeout(r, strat.CONFIRM_SEC * 1000));
        if (sniped.has(mint) || STRATEGIES.some(s => positions[s.id][mint])) continue;
        const freshPair = await getDexPair(mint);
        const freshMC   = freshPair ? Math.round(freshPair.fdv || freshPair.marketCap || 0) : 0;
        if (!freshMC || freshMC < strat.MIN_MC || freshMC > strat.MAX_MC * 1.3) {
          console.log('[SKIP/DEX] ' + name + ' — confirmation echouee ($' + freshMC.toLocaleString() + ')');
          st.skipped++; continue;
        }
        if (freshMC < mcAtDetection * 0.97) {
          console.log('[SKIP/DEX] ' + name + ' — momentum negatif ($' + mcAtDetection.toLocaleString() + ' → $' + freshMC.toLocaleString() + ')');
          st.skipped++; continue;
        }
        console.log('[CONFIRM/DEX] ' + name + ' — $' + mcAtDetection.toLocaleString() + ' → $' + freshMC.toLocaleString() + ' OK');
      }

      const coinMeta = { holders: pair.info?.holders || 0, replies: 0, ageSec: Math.round(pairAgeMs / 1000), hour: new Date().getHours() };
      await snipe(mint, name, mc, strat, strat.MISE_LAMPORTS, strat.MISE_USD, 0, coinMeta);
      break;
    }

    console.log('[DEX] ' + pairs.length + ' paires Solana | ' + candidates + ' candidat(s) | skips:' + st.skipped);
  } catch(e) {
    console.log('[DEX] Erreur : ' + e.message);
  }
}

// ─── DEMARRAGE ────────────────────────────────────────────────────────────────
async function startSniper() {
  const configLines = STRATEGIES.map(s => stratConfigLine(s)).join('\n');
  await sendTelegram(
    '🎯 GHOSTCOPY SNIPER\n==================\n'
    + configLines + '\n==================\n'
    + '✅ Actif | Scan toutes les ' + (STRATEGIES[0].SCAN_INTERVAL / 1000) + 's\n'
    + '/statut /bilan /aide'
  );

  for (const strat of STRATEGIES) {
    if (strat.GRADUATED_ONLY) {
      setInterval(() => scanDexScreener(strat), strat.SCAN_INTERVAL);
      scanDexScreener(strat);
    } else {
      setInterval(() => scanPumpFun(strat), strat.SCAN_INTERVAL);
      setInterval(() => checkWatchlist(strat), 3000);
      scanPumpFun(strat);
    }
  }
  setInterval(() => pollTelegram(), 3000);
}

startSniper();
