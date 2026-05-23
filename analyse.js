// analyse.js — analyse les performances du bot a partir de trades.json
// Usage : node analyse.js
const fs = require('fs');

const TRADES_FILE = './trades.json';
if (!fs.existsSync(TRADES_FILE)) {
  console.log('Aucun fichier trades.json trouve. Lance le bot et fais quelques trades dabord.');
  process.exit(0);
}

const trades = JSON.parse(fs.readFileSync(TRADES_FILE, 'utf8'));
if (trades.length === 0) {
  console.log('Aucun trade enregistre.');
  process.exit(0);
}

const total  = trades.length;
const wins   = trades.filter(t => t.gainUSD > 0).length;
const losses = trades.filter(t => t.gainUSD < 0).length;
const wr     = ((wins / total) * 100).toFixed(1);
const netUSD = trades.reduce((s, t) => s + t.gainUSD, 0);
const ev     = (netUSD / total).toFixed(2);

const winsData = trades.filter(t => t.gainUSD > 0);
const lossData = trades.filter(t => t.gainUSD < 0);
const avgWin   = winsData.length > 0 ? (winsData.reduce((s, t) => s + t.gainUSD, 0) / winsData.length).toFixed(0) : 0;
const avgLoss  = lossData.length > 0 ? Math.abs(lossData.reduce((s, t) => s + t.gainUSD, 0) / lossData.length).toFixed(0) : 0;
const avgWinDur = winsData.length > 0 ? (winsData.reduce((s, t) => s + t.durationMin, 0) / winsData.length).toFixed(1) : 0;
const avgLosDur = lossData.length > 0 ? (lossData.reduce((s, t) => s + t.durationMin, 0) / lossData.length).toFixed(1) : 0;

// ── REPARTITION DES SORTIES
const byOutcome = {};
for (const t of trades) byOutcome[t.outcome] = (byOutcome[t.outcome] || 0) + 1;

// ── PAR HEURE
const byHour = {};
for (const t of trades) {
  if (!byHour[t.hour]) byHour[t.hour] = { total: 0, wins: 0, net: 0 };
  byHour[t.hour].total++;
  byHour[t.hour].net += t.gainUSD;
  if (t.gainUSD > 0) byHour[t.hour].wins++;
}

// ── PAR NOMBRE DE HOLDERS
const holderBuckets = [
  { label: '< 15 holders',   min: 0,  max: 14  },
  { label: '15-30 holders',  min: 15, max: 29  },
  { label: '30-50 holders',  min: 30, max: 49  },
  { label: '50+ holders',    min: 50, max: 9999 },
];
const byHolders = holderBuckets.map(b => {
  const bucket = trades.filter(t => t.holders >= b.min && t.holders <= b.max);
  const bWins  = bucket.filter(t => t.gainUSD > 0).length;
  const bNet   = bucket.reduce((s, t) => s + t.gainUSD, 0);
  return { label: b.label, total: bucket.length, wins: bWins, net: bNet };
});

// ── PAR NOMBRE DE REPLIES
const replyBuckets = [
  { label: '0 replies',   min: 0, max: 0  },
  { label: '1 reply',     min: 1, max: 1  },
  { label: '2-5 replies', min: 2, max: 5  },
  { label: '6+ replies',  min: 6, max: 999 },
];
const byReplies = replyBuckets.map(b => {
  const bucket = trades.filter(t => t.replies >= b.min && t.replies <= b.max);
  const bWins  = bucket.filter(t => t.gainUSD > 0).length;
  const bNet   = bucket.reduce((s, t) => s + t.gainUSD, 0);
  return { label: b.label, total: bucket.length, wins: bWins, net: bNet };
});

// ── PAR AGE DU TOKEN A L ENTREE
const ageBuckets = [
  { label: '< 30s',     min: 0,   max: 29  },
  { label: '30-60s',    min: 30,  max: 59  },
  { label: '1-2 min',   min: 60,  max: 119 },
  { label: '2-5 min',   min: 120, max: 299 },
];
const byAge = ageBuckets.map(b => {
  const bucket = trades.filter(t => t.ageSec >= b.min && t.ageSec <= b.max);
  const bWins  = bucket.filter(t => t.gainUSD > 0).length;
  const bNet   = bucket.reduce((s, t) => s + t.gainUSD, 0);
  return { label: b.label, total: bucket.length, wins: bWins, net: bNet };
});

// ═══════════════════════════════════════════════════════════════
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('                   ANALYSE DES PERFORMANCES');
console.log('═══════════════════════════════════════════════════════════════\n');

console.log('GLOBAL');
console.log('  Trades : ' + total + '  |  Wins : ' + wins + '  |  Losses : ' + losses + '  |  WR : ' + wr + '%');
console.log('  NET : ' + (netUSD >= 0 ? '+' : '') + '$' + Math.round(netUSD) + '  |  EV/trade : ' + (parseFloat(ev) >= 0 ? '+' : '') + '$' + ev);
console.log('  Avg win : +$' + avgWin + ' (' + avgWinDur + 'min)  |  Avg loss : -$' + avgLoss + ' (' + avgLosDur + 'min)\n');

console.log('SORTIES');
for (const [outcome, count] of Object.entries(byOutcome).sort((a, b) => b[1] - a[1])) {
  const pct = Math.round((count / total) * 100);
  const bar = '█'.repeat(Math.round(pct / 5));
  console.log('  ' + outcome.padEnd(14) + ' ' + String(count).padStart(3) + ' (' + String(pct).padStart(2) + '%)  ' + bar);
}

console.log('\nPAR HEURE D ENTREE');
const sortedHours = Object.entries(byHour).sort((a, b) => parseInt(a[0]) - parseInt(b[0]));
for (const [h, d] of sortedHours) {
  const hWr  = Math.round((d.wins / d.total) * 100);
  const evH  = (d.net / d.total).toFixed(0);
  const sign = parseFloat(evH) >= 0 ? '+' : '';
  console.log('  ' + String(h).padStart(2) + 'h  ' + String(d.total).padStart(3) + ' trades | ' + String(hWr).padStart(3) + '% WR | EV ' + sign + '$' + evH + '/t');
}

console.log('\nPAR HOLDERS A L ENTREE');
for (const b of byHolders) {
  if (b.total === 0) continue;
  const bWr  = Math.round((b.wins / b.total) * 100);
  const evB  = (b.net / b.total).toFixed(0);
  const sign = parseFloat(evB) >= 0 ? '+' : '';
  console.log('  ' + b.label.padEnd(16) + ' ' + String(b.total).padStart(3) + ' trades | ' + String(bWr).padStart(3) + '% WR | EV ' + sign + '$' + evB + '/t');
}

console.log('\nPAR REPLIES A L ENTREE');
for (const b of byReplies) {
  if (b.total === 0) continue;
  const bWr  = Math.round((b.wins / b.total) * 100);
  const evB  = (b.net / b.total).toFixed(0);
  const sign = parseFloat(evB) >= 0 ? '+' : '';
  console.log('  ' + b.label.padEnd(16) + ' ' + String(b.total).padStart(3) + ' trades | ' + String(bWr).padStart(3) + '% WR | EV ' + sign + '$' + evB + '/t');
}

console.log('\nPAR AGE DU TOKEN A L ENTREE');
for (const b of byAge) {
  if (b.total === 0) continue;
  const bWr  = Math.round((b.wins / b.total) * 100);
  const evB  = (b.net / b.total).toFixed(0);
  const sign = parseFloat(evB) >= 0 ? '+' : '';
  console.log('  ' + b.label.padEnd(16) + ' ' + String(b.total).padStart(3) + ' trades | ' + String(bWr).padStart(3) + '% WR | EV ' + sign + '$' + evB + '/t');
}

// ── RECOMMANDATIONS
console.log('\n═══════════════════════════════════════════════════════════════');
console.log('RECOMMANDATIONS');
const rugs   = (byOutcome['rug'] || 0);
const dumps  = (byOutcome['dump'] || 0);
const rugPct = Math.round((rugs / total) * 100);
const dmpPct = Math.round((dumps / total) * 100);
let hasReco  = false;

if (rugPct > 30)  { console.log('  ⚠️  ' + rugPct + '% de rugs → augmenter MIN_HOLDERS (actuellement 15, essaie 20+)'); hasReco = true; }
if (dmpPct > 20)  { console.log('  ⚠️  ' + dmpPct + '% de dumps → les tokens chutent avant SL, entry trop tard'); hasReco = true; }
if (parseFloat(wr) < 35) { console.log('  ⚠️  WR ' + wr + '% < 35% → filtres insuffisants, tokens de mauvaise qualite'); hasReco = true; }
if (parseFloat(avgWin) < parseFloat(avgLoss)) {
  console.log('  ⚠️  Avg win (+$' + avgWin + ') < avg loss (-$' + avgLoss + ') → les TPs se declenchent trop tot');
  hasReco = true;
}

// Meilleure heure
const bestHour = sortedHours.filter(([, d]) => d.total >= 3).sort((a, b) => (b[1].net / b[1].total) - (a[1].net / a[1].total))[0];
if (bestHour) { console.log('  ✅ Meilleure heure : ' + bestHour[0] + 'h (EV ' + (bestHour[1].net / bestHour[1].total).toFixed(0) + '$/trade)'); hasReco = true; }

// Meilleure tranche holders
const bestH = byHolders.filter(b => b.total >= 3).sort((a, b) => (b.net / b.total) - (a.net / a.total))[0];
if (bestH) { console.log('  ✅ Meilleure tranche holders : ' + bestH.label + ' (EV ' + (bestH.net / bestH.total).toFixed(0) + '$/trade)'); hasReco = true; }

if (parseFloat(wr) >= 40 && parseFloat(ev) > 0) { console.log('  🏆 Config rentable ! EV positive et WR >= 40%. Continue !'); hasReco = true; }
if (!hasReco) console.log('  Pas assez de donnees pour des recommandations precises.');

console.log('═══════════════════════════════════════════════════════════════\n');
