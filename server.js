/**
 * GCM HRTC AI Brain — Triple Engine Server v5
 *
 * Updated for GCM Heikin Ashi RSI Trend Cloud [QQQ] strategy webhook format
 * Webhook fields: action, ticker, price, high, low, volume, context, liquidity
 *
 * Engine 1 — HRTC Signal Quality Scorer (0–100)
 * Engine 2 — Liquidity Sandwich + built-in liquidity context from indicator
 * Engine 3 — Polygon.io Live Market Data
 *   → Volume conviction (bar volume vs Polygon daily volume)
 *   → Bid/ask spread (order book thinning)
 *   → VWAP positioning (institutional reference)
 *   → Block trade detection (dark pool proxy)
 *   → Liquidity Vacuum detection
 */

const express = require('express');
const cors    = require('cors');
const app     = express();

app.use(cors());
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET    || 'gcm-secret-change-me';
const PORT              = process.env.PORT              || 3000;


// ══════════════════════════════════════════════════════════════════════════
//  QQQ KEY S/R LEVEL MAP  (from QQQ Key S/R Levels v2 indicator)
//  Updated: March 2026
//  Used to give AI precise nearest support/resistance context on every signal
// ══════════════════════════════════════════════════════════════════════════
const QQQ_SR = {
  resistance: [
    { price: 637.01, label: '52W HIGH',        major: true  },
    { price: 635.77, label: 'Oct 29',           major: false },
    { price: 632.92, label: '',                 major: false },
    { price: 632.08, label: 'Nov 3',            major: false },
    { price: 629.07, label: '',                 major: false },
    { price: 628.09, label: '',                 major: false },
    { price: 626.60, label: 'Nov 5',            major: false },
    { price: 624.84, label: '',                 major: false },
    { price: 623.28, label: '',                 major: false },
    { price: 621.08, label: '',                 major: false },
    { price: 618.42, label: '',                 major: false },
    { price: 616.75, label: 'Feb 2026 Rejection', major: false },
    { price: 615.00, label: 'Range Equilibrium', major: false },
    { price: 613.18, label: 'Oct 10 High',      major: true  },
    { price: 611.54, label: '',                 major: false },
  ],
  support: [
    { price: 611.67, label: 'Nov 6',            major: false },
    { price: 610.58, label: '',                 major: false },
    { price: 609.74, label: 'Nov 7',            major: false },
    { price: 608.40, label: 'Nov 13',           major: false },
    { price: 607.71, label: '',                 major: false },
    { price: 606.08, label: 'Nov 13 Low',       major: false },
    { price: 605.49, label: '',                 major: false },
    { price: 603.93, label: '',                 major: false },
    { price: 603.25, label: '',                 major: false },
    { price: 602.00, label: 'HTF Demand Zone',  major: true  },
    { price: 600.37, label: '',                 major: false },
    { price: 600.00, label: 'PSYCHOLOGICAL',    major: true  },
    { price: 599.74, label: 'Oct 22 Low',       major: false },
    { price: 598.73, label: '',                 major: false },
    { price: 597.17, label: 'Nov 14 Low',       major: false },
    { price: 596.10, label: '',                 major: false },
    { price: 595.97, label: '',                 major: false },
    { price: 595.50, label: 'Oct 16 Low',       major: false },
    { price: 593.53, label: 'Volume Support',   major: true  },
    { price: 591.18, label: '',                 major: false },
    { price: 590.13, label: 'Oct 14 Low',       major: false },
    { price: 590.00, label: '',                 major: false },
    { price: 589.50, label: 'Oct 10 LOW - Major', major: true },
    { price: 589.05, label: 'Oct 10 Intraday',  major: false },
    { price: 586.66, label: '',                 major: false },
    { price: 584.37, label: 'Sep 17 Low',       major: false },
    { price: 584.08, label: '',                 major: false },
    { price: 582.00, label: 'Range Low',        major: false },
    { price: 580.70, label: '',                 major: false },
    { price: 578.87, label: '',                 major: false },
    { price: 578.55, label: 'Sep 10 Low',       major: false },
    { price: 577.08, label: '',                 major: false },
    { price: 576.06, label: '',                 major: false },
    { price: 575.23, label: '',                 major: false },
    { price: 572.61, label: 'Aug Low',          major: false },
    { price: 571.53, label: 'Sep 5 LOW - Major', major: true },
    { price: 565.62, label: '',                 major: false },
    { price: 550.00, label: 'Psychological',    major: false },
    { price: 540.81, label: 'Feb 25 ATH→Support', major: true },
    { price: 520.00, label: 'Dec 24',           major: false },
    { price: 511.23, label: 'Jan 2 25 Open',    major: false },
    { price: 500.00, label: 'PSYCHOLOGICAL',    major: true  },
    { price: 490.91, label: 'May Rally Top',    major: false },
    { price: 488.00, label: '61.8% Fib',        major: false },
    { price: 487.18, label: 'May Wave',         major: false },
    { price: 478.12, label: '',                 major: false },
    { price: 476.78, label: '',                 major: false },
    { price: 474.81, label: '',                 major: false },
    { price: 468.41, label: '',                 major: false },
    { price: 467.00, label: 'Mar Low',          major: false },
    { price: 462.43, label: '',                 major: false },
    { price: 450.00, label: 'Psychological',    major: false },
    { price: 443.14, label: 'Wave 1 Top',       major: false },
    { price: 428.00, label: 'Pivot/Wave 2',     major: false },
  ],
  critical: [
    { price: 404.44, label: 'Apr 9',            major: false },
    { price: 402.39, label: '52W LOW - Apr 7',  major: true  },
  ],
  // Cluster zones — price inside these = sandwiched between institutional levels
  zones: [
    { top: 637.01, bot: 635.77, type: 'resistance', label: '52W High cluster' },
    { top: 632.92, bot: 632.08, type: 'resistance', label: 'Nov 3 resistance cluster' },
    { top: 629.07, bot: 628.09, type: 'resistance', label: 'Resistance cluster' },
    { top: 616.75, bot: 615.00, type: 'resistance', label: 'Feb rejection / range equilibrium' },
    { top: 613.18, bot: 611.54, type: 'resistance', label: 'Oct High cluster' },
    { top: 611.67, bot: 610.58, type: 'support',    label: 'Nov 6 support cluster' },
    { top: 607.71, bot: 606.08, type: 'support',    label: 'Nov 13 support cluster' },
    { top: 602.00, bot: 600.00, type: 'support',    label: 'HTF Demand / Psychological $600' },
    { top: 597.17, bot: 595.50, type: 'support',    label: 'Nov 14–Oct 16 support cluster' },
    { top: 590.13, bot: 589.05, type: 'support',    label: 'Oct 14–10 Low cluster' },
    { top: 584.37, bot: 584.08, type: 'support',    label: 'Sep 17 support cluster' },
    { top: 578.87, bot: 578.55, type: 'support',    label: 'Sep 10 support cluster' },
    { top: 576.06, bot: 575.23, type: 'support',    label: 'Support cluster' },
  ]
};

// Compute nearest S/R levels for a given price
function getQQQContext(price) {
  const p = parseFloat(price);
  if (!p) return null;

  // Find nearest resistance above
  const resistAbove = QQQ_SR.resistance
    .filter(r => r.price > p)
    .sort((a,b) => a.price - b.price);

  // Find nearest support below
  const supportBelow = QQQ_SR.support
    .concat(QQQ_SR.critical)
    .filter(s => s.price < p)
    .sort((a,b) => b.price - a.price);

  const nearR = resistAbove[0] || null;
  const nearS = supportBelow[0] || null;
  const nextR = resistAbove[1] || null;
  const nextS = supportBelow[1] || null;

  // Find next major levels
  const majorR = resistAbove.find(r => r.major) || nearR;
  const majorS = supportBelow.find(s => s.major) || nearS;

  // Check if price is inside a cluster zone
  const inZone = QQQ_SR.zones.find(z => p >= z.bot && p <= z.top) || null;

  // Check if price is inside a cluster of minor levels (within $2)
  const nearbyR = resistAbove.filter(r => r.price - p < 2.0);
  const nearbyS = supportBelow.filter(s => p - s.price < 2.0);
  const clustered = (nearbyR.length > 1 || nearbyS.length > 1);

  const distToR = nearR ? (nearR.price - p).toFixed(2) : 'N/A';
  const distToS = nearS ? (p - nearS.price).toFixed(2) : 'N/A';
  const rsRatio = (nearR && nearS)
    ? ((nearR.price - p) / (p - nearS.price)).toFixed(2)
    : 'N/A';

  // Risk/reward context
  const rrContext = rsRatio !== 'N/A'
    ? parseFloat(rsRatio) < 0.5  ? 'Price much closer to resistance — unfavorable R/R for longs'
    : parseFloat(rsRatio) < 0.8  ? 'Resistance nearby — tight room to run for longs'
    : parseFloat(rsRatio) < 1.2  ? 'Balanced — equal distance to resistance and support'
    : parseFloat(rsRatio) < 2.0  ? 'Good room to run — resistance well above support'
    : 'Excellent R/R — price near support with significant room above'
    : 'N/A';

  return {
    nearR, nearS, nextR, nextS, majorR, majorS,
    distToR, distToS, rsRatio, rrContext,
    inZone, clustered, nearbyR, nearbyS,
    // Formatted strings for prompt
    nearRStr:  nearR ? `$${nearR.price} ${nearR.label ? '('+nearR.label+')' : ''} — ${distToR} pts away` : 'None identified',
    nearSStr:  nearS ? `$${nearS.price} ${nearS.label ? '('+nearS.label+')' : ''} — ${distToS} pts away` : 'None identified',
    majorRStr: majorR ? `$${majorR.price} (${majorR.label || 'Major resistance'})` : 'None identified',
    majorSStr: majorS ? `$${majorS.price} (${majorS.label || 'Major support'})` : 'None identified',
    zoneStr:   inZone ? `⚠ PRICE INSIDE CLUSTER ZONE: ${inZone.label} ($${inZone.bot}–$${inZone.top})` : null,
  };
}


// ══════════════════════════════════════════════════════════════════════════
//  TIME CONTEXT — CST market session awareness for 0DTE/1DTE analysis
// ══════════════════════════════════════════════════════════════════════════
function getTimeContext() {
  const now    = new Date();
  const utcH   = now.getUTCHours();
  const utcM   = now.getUTCMinutes();

  // ── DST-aware offset ──────────────────────────────────────────────────
  // US CDT (UTC-5): 2nd Sun Mar → 1st Sun Nov
  // US CST (UTC-6): 1st Sun Nov → 2nd Sun Mar
  // We calculate the exact DST boundaries for the current year so Railway
  // (which runs UTC) always uses the correct market-local hour.
  function nthSundayOfMonth(year, month, n) {
    // month: 0=Jan … 11=Dec
    const d = new Date(Date.UTC(year, month, 1));
    const day = d.getUTCDay(); // 0=Sun
    const first = day === 0 ? 1 : 8 - day;
    return new Date(Date.UTC(year, month, first + (n - 1) * 7));
  }
  const yr         = now.getUTCFullYear();
  const dstStart   = nthSundayOfMonth(yr, 2,  2); // 2nd Sun March (2:00am local = spring forward)
  const dstEnd     = nthSundayOfMonth(yr, 10, 1); // 1st Sun November (2:00am local = fall back)
  const isDST      = now >= dstStart && now < dstEnd;
  const utcOffset  = isDST ? -5 : -6;             // CDT = UTC-5, CST = UTC-6
  const localH     = ((utcH + utcOffset) + 24) % 24;
  const cstH       = localH;
  const cstMin     = utcM;
  const totalMin = cstH * 60 + cstMin;

  // Market open = 8:30 CST, close = 15:00 CST
  const OPEN  = 8  * 60 + 30;  // 8:30am CST
  const CLOSE = 15 * 60 + 0;   // 3:00pm CST (4pm EST)

  const minutesLeft   = Math.max(0, CLOSE - totalMin);
  const minutesIn     = Math.max(0, totalMin - OPEN);
  const isMarketHours = totalMin >= OPEN && totalMin < CLOSE;

  // Session phases
  const phase =
    totalMin < OPEN              ? 'PRE-MARKET'       :
    totalMin < OPEN + 30         ? 'OPENING (0-30min)' :
    totalMin < OPEN + 90         ? 'EARLY SESSION'    :
    totalMin < 11 * 60           ? 'MID-MORNING'      :
    totalMin < 13 * 60           ? 'DEAD ZONE (avoid)':
    totalMin < 13 * 60 + 30      ? 'EARLY AFTERNOON'  :
    totalMin < 14 * 60           ? 'MAX PAIN GRAVITY BUILDING' :
    totalMin < 14 * 60 + 30      ? 'POWER HOUR APPROACHING'   :
    totalMin < CLOSE - 30        ? 'POWER HOUR'        :
    totalMin < CLOSE - 10        ? 'FINAL 30 MIN — HIGH RISK' :
    totalMin < CLOSE             ? 'LAST 10 MIN — AVOID 0DTE' :
                                   'AFTER HOURS';

  // Theta urgency for 0DTE
  const thetaUrgency =
    !isMarketHours               ? 'N/A'     :
    minutesLeft > 300            ? 'LOW'     :  // >5hrs left
    minutesLeft > 180            ? 'MEDIUM'  :  // >3hrs
    minutesLeft > 90             ? 'HIGH'    :  // >1.5hrs
    minutesLeft > 30             ? 'EXTREME' :  // <1.5hrs
                                   'CRITICAL';  // <30min

  // Score penalty for time-weighted scoring (Phase 5 item 30)
  // After 2:30pm CST (14:30), require higher base score
  const requiresHighScore = totalMin >= 14 * 60 + 30;
  const minScoreFor0DTE   = requiresHighScore ? 80 : 65;

  // Max pain gravity multiplier — doubles after 1pm EST (12pm CST)
  const maxPainGravity = totalMin >= 12 * 60 ? '2x (strong)' : '1x (normal)';

  // Vanna/Charm risk assessment based on time
  // Charm accelerates after 2pm EST (1pm CST)
  const charmActive = totalMin >= 13 * 60;
  const charmRisk   = !isMarketHours ? 'N/A' :
    totalMin >= 14 * 60 + 30 ? 'EXTREME — dealer delta decay in final stretch' :
    totalMin >= 13 * 60      ? 'HIGH — charm pulling price toward pin/max pain' :
    totalMin >= 11 * 60 + 30 ? 'MODERATE' : 'LOW';

  const tzLabel = isDST ? 'CDT' : 'CST';
  const timeStr = `${String(cstH).padStart(2,'0')}:${String(cstMin).padStart(2,'0')} ${tzLabel}`;

  return {
    timeStr, phase, thetaUrgency, minutesLeft, minutesIn,
    isMarketHours, requiresHighScore, minScoreFor0DTE,
    maxPainGravity, charmActive, charmRisk,
    hoursLeft: (minutesLeft / 60).toFixed(1),
  };
}

// ── SSE broadcast ──────────────────────────────────────────────────────────
const clients = new Set();
function broadcast(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch (_) { clients.delete(res); }
  }
}
const signalHistory = [];

// ══════════════════════════════════════════════════════════════════════════
//  PHASE 5 — SESSION STRUCTURE STATE
// ══════════════════════════════════════════════════════════════════════════

// Opening Range — tracks first 30min high/low per ticker per trading day
// Resets at midnight UTC (well before 8:30am CST open)
const openingRanges = {};   // { 'QQQ': { high, low, established, date } }

function getOpeningRange(ticker) {
  const today = new Date().toISOString().slice(0,10); // YYYY-MM-DD
  const key   = ticker.toUpperCase();
  if (openingRanges[key]?.date !== today) {
    openingRanges[key] = { high: null, low: null, established: false, date: today, highs: [], lows: [] };
  }
  return openingRanges[key];
}

function updateOpeningRange(ticker, high, low, timeCtx) {
  const or = getOpeningRange(ticker);
  // Only collect data during the first 30 minutes (OPENING phase)
  if (!timeCtx.isMarketHours) return or;
  if (timeCtx.minutesIn <= 30) {
    if (high) or.highs.push(parseFloat(high));
    if (low)  or.lows.push(parseFloat(low));
    if (or.highs.length > 0 && or.lows.length > 0) {
      or.high = Math.max(...or.highs);
      or.low  = Math.min(...or.lows);
    }
  }
  // Mark as established once we're past the opening window
  if (timeCtx.minutesIn > 30 && or.high && or.low) {
    or.established = true;
  }
  return or;
}

function analyseOpeningRange(price, or, isBull) {
  if (!or.high || !or.low) return { context: 'Opening range not yet established', warning: null, bonus: 0 };
  const p    = parseFloat(price);
  const mid  = (or.high + or.low) / 2;
  const range = or.high - or.low;

  // Price position relative to ORB
  const aboveHigh = p > or.high;
  const belowLow  = p < or.low;
  const inRange   = !aboveHigh && !belowLow;
  const nearHigh  = Math.abs(p - or.high) < range * 0.1;
  const nearLow   = Math.abs(p - or.low)  < range * 0.1;

  // Bull trap: BUY signal fires below ORB low — momentum is down
  const bullTrap = isBull && belowLow;
  // Bear trap: SELL signal fires above ORB high — momentum is up
  const bearTrap = !isBull && aboveHigh;
  // Breakout confirmation: signal direction matches ORB break
  const breakoutConfirm = (isBull && aboveHigh) || (!isBull && belowLow);

  const context = aboveHigh
    ? `Price $${p.toFixed(2)} ABOVE ORB high $${or.high.toFixed(2)} — bullish breakout territory`
    : belowLow
    ? `Price $${p.toFixed(2)} BELOW ORB low $${or.low.toFixed(2)} — bearish breakdown territory`
    : nearHigh ? `Price $${p.toFixed(2)} testing ORB high $${or.high.toFixed(2)} — breakout attempt`
    : nearLow  ? `Price $${p.toFixed(2)} testing ORB low $${or.low.toFixed(2)} — breakdown attempt`
    : `Price $${p.toFixed(2)} inside ORB ($${or.low.toFixed(2)}–$${or.high.toFixed(2)}) — range-bound`;

  const warning = bullTrap
    ? `⚠ ORB BULL TRAP — buy signal below ORB low $${or.low.toFixed(2)}. Price momentum is DOWN. High failure rate for calls.`
    : bearTrap
    ? `⚠ ORB BEAR TRAP — sell signal above ORB high $${or.high.toFixed(2)}. Price momentum is UP. High failure rate for puts.`
    : null;

  const bonus = breakoutConfirm ? 8 : bullTrap || bearTrap ? -12 : inRange ? -3 : 0;
  const bonusLabel = breakoutConfirm ? 'ORB breakout confirms direction (+8)'
    : bullTrap || bearTrap ? 'ORB trap signal (-12)'
    : inRange ? 'Inside ORB range (-3)' : '';

  return {
    context, warning, bonus, bonusLabel,
    orbHigh: or.high.toFixed(2), orbLow: or.low.toFixed(2),
    established: or.established,
    aboveHigh, belowLow, inRange, breakoutConfirm, bullTrap, bearTrap
  };
}

// RVOL (Relative Volume) normalization by time of day
// QQQ typical intraday volume distribution (% of daily by 30-min bucket, CST)
// Bucket index 0 = 8:30–9:00, 1 = 9:00–9:30 … 12 = 15:00 (close)
const QQQ_TYPICAL_VOL_PCT = [
  0.18,  // 8:30–9:00  (opening rush — 18% of day in first 30min)
  0.12,  // 9:00–9:30
  0.08,  // 9:30–10:00
  0.07,  // 10:00–10:30
  0.06,  // 10:30–11:00
  0.05,  // 11:00–11:30
  0.04,  // 11:30–12:00
  0.04,  // 12:00–12:30
  0.04,  // 12:30–13:00  (dead zone)
  0.04,  // 13:00–13:30
  0.05,  // 13:30–14:00
  0.07,  // 14:00–14:30  (power hour ramp)
  0.11,  // 14:30–15:00  (closing rush)
];

function computeRVOL(barVolume, avgDailyVolume, minutesIn) {
  if (!barVolume || !avgDailyVolume || !minutesIn) return null;
  const bucketIdx = Math.min(Math.floor(minutesIn / 30), QQQ_TYPICAL_VOL_PCT.length - 1);
  const expectedPct = QQQ_TYPICAL_VOL_PCT[bucketIdx];
  const expectedBarVol = avgDailyVolume * expectedPct;
  if (!expectedBarVol) return null;
  const rvol = parseFloat(barVolume) / expectedBarVol;
  const rvolContext = rvol >= 3.0  ? `${rvol.toFixed(1)}x RVOL — EXTREME volume spike, institutional activity highly likely`
    : rvol >= 2.0  ? `${rvol.toFixed(1)}x RVOL — HIGH conviction, well above seasonal norm for this time of day`
    : rvol >= 1.3  ? `${rvol.toFixed(1)}x RVOL — Above average for this session window`
    : rvol >= 0.7  ? `${rvol.toFixed(1)}x RVOL — Normal volume for this time of day`
    : rvol >= 0.4  ? `${rvol.toFixed(1)}x RVOL — Below seasonal norm — thin conditions, move may not sustain`
    :                `${rvol.toFixed(1)}x RVOL — VERY LOW for this window — liquidity vacuum risk`;
  return { rvol: rvol.toFixed(2), rvolContext, expectedBarVol: Math.round(expectedBarVol) };
}

// Earnings / macro event check via Yahoo Finance earnings calendar
async function checkEarningsRisk(ticker) {
  try {
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=calendarEvents`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const res  = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
    clearTimeout(timer);
    const data = await res.json();
    const cal  = data?.quoteSummary?.result?.[0]?.calendarEvents;
    if (!cal) return null;

    const earningsDates = cal.earnings?.earningsDate || [];
    const now = Date.now() / 1000;
    const threeDays = 3 * 24 * 3600;
    const upcoming = earningsDates.filter(d => d.raw > now && d.raw < now + threeDays);
    const recent   = earningsDates.filter(d => d.raw < now && d.raw > now - threeDays);

    if (upcoming.length > 0) {
      const dt = new Date(upcoming[0].raw * 1000).toLocaleDateString('en-US',{month:'short',day:'numeric'});
      return { risk: 'HIGH', message: `🚨 EARNINGS IN ${Math.ceil((upcoming[0].raw-now)/86400)} DAYS (${dt}) — IV crush risk after print. Avoid holding 0DTE through earnings.` };
    }
    if (recent.length > 0) {
      const dt = new Date(recent[0].raw * 1000).toLocaleDateString('en-US',{month:'short',day:'numeric'});
      return { risk: 'LOW', message: `✅ Earnings just reported (${dt}) — post-earnings IV crush complete. Normal options pricing.` };
    }
    return { risk: 'NONE', message: 'No earnings event within 3-day window.' };
  } catch (_) {
    return null;
  }
}

// ══════════════════════════════════════════════════════════════════════════
//  NORMALISE WEBHOOK — handle both old and new indicator formats
// ══════════════════════════════════════════════════════════════════════════
function normalisePayload(body) {
  if (body.action) {
    const isBull = body.action === 'buy';
    return {
      ticker:       body.ticker,
      timeframe:    body.timeframe || '—',
      price:        parseFloat(body.price),
      high:         parseFloat(body.high)    || null,
      low:          parseFloat(body.low)     || null,
      barVolume:    parseFloat(body.volume)  || null,
      action:       body.action,
      context:      body.context             || '',
      liquidity:    body.liquidity           || '',
      // Use REAL RSI values from indicator if provided, else fall back to estimates
      rsi_now:      body.rsi_now  !== undefined ? parseFloat(body.rsi_now)  : (isBull ? 4  : -4),
      rsi_prev:     body.rsi_prev !== undefined ? parseFloat(body.rsi_prev) : (isBull ? -2 : 2),
      // New rich fields from optimised indicator
      htf1_rsi:     body.htf1_rsi !== undefined ? parseFloat(body.htf1_rsi) : null,
      harsi_candle: body.harsi_candle || (isBull ? 'bullish' : 'bearish'),
      harsi_prev:   body.harsi_prev   || (isBull ? 'bearish' : 'bullish'),
      divergence:   body.divergence   || 'none',
      htf_bias:     body.htf_bias     || null,
      obos:         body.obos         || 'neutral',
      // CVD fields from updated GCM+CVD indicator
      cvd:          body.cvd           !== undefined ? parseFloat(body.cvd)           : null,
      delta:        body.delta         !== undefined ? parseFloat(body.delta)         : null,
      cvd_bias:     body.cvd_bias      || null,
      cvd_strength: body.cvd_strength  !== undefined ? parseInt(body.cvd_strength)   : null,
      cvd_confirmed: body.cvd_confirmed !== undefined ? body.cvd_confirmed === true || body.cvd_confirmed === 'true' : false,
      isClose:      body.action === 'close',
      format:       'v5'
    };
  }
  return { ...body, format: 'legacy' };
}

// ══════════════════════════════════════════════════════════════════════════
//  ENGINE 3 — POLYGON.IO LIVE MARKET DATA
// ══════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════
//  ENGINE 3 — YAHOO FINANCE MARKET DATA + OPTIONS CHAIN
//  Replaces Polygon — no API key required, completely free
//  Fetches: quote, volume, bid/ask, price change + full options chain
// ══════════════════════════════════════════════════════════════════════════
async function fetchMarketData(ticker) {
  const results = {};

  const fetchWithTimeout = (url, ms = 6000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }).finally(() => clearTimeout(timer));
  };

  // Clean ticker for Yahoo — BTC/USD → BTC-USD
  const isCrypto = ['BTC','ETH','SOL','XRP','BNB','DOGE'].some(c => ticker.toUpperCase().includes(c));
  const yahooTicker = isCrypto
    ? ticker.replace('/', '-').replace('USDT','USD').toUpperCase()
    : ticker.toUpperCase();

  try {
    // ── 1. Quote — price, volume, bid/ask, day range ─────────────────────
    const quoteUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}?interval=1d&range=2d`;
    const quoteRes  = await fetchWithTimeout(quoteUrl);
    const quoteData = await quoteRes.json();
    const meta      = quoteData?.chart?.result?.[0]?.meta || null;

    if (meta) {
      const price       = meta.regularMarketPrice      || null;
      const prevClose   = meta.chartPreviousClose      || meta.previousClose || null;
      const dayHigh     = meta.regularMarketDayHigh    || null;
      const dayLow      = meta.regularMarketDayLow     || null;
      const open        = meta.regularMarketOpen       || null;
      const volume      = meta.regularMarketVolume     || null;
      const avgVolume   = meta.averageDailyVolume10Day || meta.averageDailyVolume3Month || null;
      const bid         = meta.bid  || null;
      const ask         = meta.ask  || null;
      const marketState = meta.marketState || 'CLOSED';

      // Volume analysis
      const volRatio   = (volume && avgVolume) ? volume / avgVolume : null;
      const volContext = volRatio === null ? 'N/A'
        : volRatio < 0.3  ? 'VERY LOW — strong liquidity vacuum risk'
        : volRatio < 0.6  ? 'LOW — thin market, move may not sustain'
        : volRatio < 0.9  ? 'BELOW AVERAGE'
        : volRatio < 1.2  ? 'AVERAGE'
        : volRatio < 2.0  ? 'ABOVE AVERAGE — conviction present'
        : 'HIGH — institutional activity likely';

      // Bid/ask spread
      const spread = (bid && ask && bid > 0)
        ? ((ask - bid) / bid * 100).toFixed(4) : null;
      const spreadContext = !spread ? 'N/A'
        : parseFloat(spread) > 0.1  ? 'WIDE — order book thinning, low depth'
        : parseFloat(spread) > 0.05 ? 'MODERATE — normal conditions'
        : 'TIGHT — deep order book, healthy liquidity';

      // Price change
      const priceChange = (price && prevClose)
        ? ((price - prevClose) / prevClose * 100).toFixed(2) : null;

      // Liquidity vacuum: big move on low volume
      const liqVacuum = (volRatio !== null && volRatio < 0.5
        && priceChange && Math.abs(parseFloat(priceChange)) > 0.5)
        ? `⚠ LIQUIDITY VACUUM — price moved ${priceChange}% on ${(volRatio*100).toFixed(0)}% of avg volume`
        : null;

      results.quote = {
        price, prevClose, dayHigh, dayLow, open,
        volume:       volume ? parseInt(volume).toLocaleString() : 'N/A',
        avgVolume:    avgVolume ? parseInt(avgVolume).toLocaleString() : 'N/A',
        volRatio:     volRatio ? (volRatio*100).toFixed(0)+'% of avg' : 'N/A',
        volContext,
        bid:          bid ? bid.toFixed(2) : 'N/A',
        ask:          ask ? ask.toFixed(2) : 'N/A',
        spread:       spread ? spread+'%' : 'N/A',
        spreadContext,
        priceChange:  priceChange ? priceChange+'%' : 'N/A',
        marketState,
        liqVacuum,
        gapContext: priceChange
          ? parseFloat(priceChange) > 2   ? `GAP UP ${priceChange}% — institutions may fade`
          : parseFloat(priceChange) < -2  ? `GAP DOWN ${priceChange}% — watch for institutional support`
          : `No significant gap (${priceChange}%)`
          : null,
      };
    }

    // ── 2. Options Chain — gamma walls, max pain, put/call ratio ─────────
    // Only for stocks/ETFs — skip crypto
    if (!isCrypto) {
      const optUrl = `https://query1.finance.yahoo.com/v7/finance/options/${yahooTicker}`;
      const optRes  = await fetchWithTimeout(optUrl);
      const optData = await optRes.json();
      const optResult = optData?.optionChain?.result?.[0] || null;

      if (optResult) {
        const currentPrice = optResult.quote?.regularMarketPrice || parseFloat(results.quote?.price) || 0;
        const calls = optResult.options?.[0]?.calls || [];
        const puts  = optResult.options?.[0]?.puts  || [];
        const expiryDates = optResult.expirationDates || [];

        // Find nearest expiry
        const now = Date.now() / 1000;
        const nearestExpiry = expiryDates.find(d => d > now) || expiryDates[0];
        const expiryDate = nearestExpiry
          ? new Date(nearestExpiry * 1000).toLocaleDateString('en-US', { month:'short', day:'numeric' })
          : 'N/A';

        // ATM strikes — within 2% of current price
        const atmRange = currentPrice * 0.02;
        const atmCalls = calls.filter(c => Math.abs((c.strike||0) - currentPrice) <= atmRange);
        const atmPuts  = puts.filter(p  => Math.abs((p.strike||0) - currentPrice) <= atmRange);

        // Max OI strikes — gamma walls
        const sortedCalls = [...calls].sort((a,b) => (b.openInterest||0) - (a.openInterest||0));
        const sortedPuts  = [...puts].sort((a,b)  => (b.openInterest||0) - (a.openInterest||0));

        const topCallWall = sortedCalls[0] || null;
        const topPutWall  = sortedPuts[0]  || null;
        const topCallWall2 = sortedCalls[1] || null;
        const topPutWall2  = sortedPuts[1]  || null;

        // Call wall above price (resistance) and put wall below (support)
        const callWallAbove = sortedCalls.filter(c => (c.strike||0) > currentPrice)[0] || topCallWall;
        const putWallBelow  = sortedPuts.filter(p  => (p.strike||0) < currentPrice)[0] || topPutWall;

        // Total OI for put/call ratio
        const totalCallOI = calls.reduce((s,c) => s + (c.openInterest||0), 0);
        const totalPutOI  = puts.reduce((s,p)  => s + (p.openInterest||0), 0);
        const pcRatio     = totalCallOI > 0 ? (totalPutOI / totalCallOI).toFixed(2) : 'N/A';
        const pcContext   = pcRatio === 'N/A' ? 'N/A'
          : parseFloat(pcRatio) > 1.5 ? 'BEARISH — heavy put buying, fear elevated'
          : parseFloat(pcRatio) > 1.0 ? 'SLIGHTLY BEARISH — more puts than calls'
          : parseFloat(pcRatio) > 0.7 ? 'NEUTRAL — balanced options flow'
          : parseFloat(pcRatio) > 0.5 ? 'SLIGHTLY BULLISH — call buying dominant'
          : 'BULLISH — heavy call buying, greed elevated';

        // Max pain — strike where most options expire worthless
        let maxPainStrike = null;
        let maxPainValue  = Infinity;
        const allStrikes = [...new Set([...calls, ...puts].map(o => o.strike).filter(Boolean))].sort((a,b) => a-b);
        for (const strike of allStrikes) {
          const callLoss = calls.reduce((s,c) => s + Math.max(0, strike - (c.strike||0)) * (c.openInterest||0), 0);
          const putLoss  = puts.reduce((s,p)  => s + Math.max(0, (p.strike||0) - strike) * (p.openInterest||0), 0);
          const total    = callLoss + putLoss;
          if (total < maxPainValue) { maxPainValue = total; maxPainStrike = strike; }
        }

        // IV from ATM options
        const atmIV = atmCalls[0]?.impliedVolatility || atmPuts[0]?.impliedVolatility || null;
        const ivContext = !atmIV ? 'N/A'
          : atmIV > 0.4  ? 'VERY HIGH IV — expensive options, large move expected'
          : atmIV > 0.25 ? 'HIGH IV — elevated uncertainty'
          : atmIV > 0.15 ? 'MODERATE IV — normal conditions'
          : 'LOW IV — calm market, small move expected';

        // Gamma flip zone — between highest put wall and call wall
        const gammaFlipZone = (callWallAbove && putWallBelow)
          ? `$${putWallBelow.strike}–$${callWallAbove.strike}`
          : 'N/A';

        // ── GEX (Gamma Exposure) Calculation ─────────────────────────────
        // GEX = OI × Gamma × 100 × spotPrice
        // Positive GEX = market makers long gamma = they BUY dips, SELL rips = price pinned
        // Negative GEX = market makers short gamma = they SELL dips, BUY rips = price accelerates
        //
        // We approximate gamma from IV and distance from spot using Black-Scholes gamma proxy:
        // Gamma ≈ PDF(d1) / (S × σ × √T)
        // For simplicity: gamma proxy = exp(-0.5 × ((strike-spot)/atmIV/spot)^2) / (spot × atmIV)

        const T = Math.max(1, (nearestExpiry - now) / (365 * 24 * 3600)); // time to expiry in years
        const ivForGex = atmIV || 0.20; // fallback 20% IV

        let totalGex      = 0;
        let gexByStrike   = {};
        let posGexStrikes = [];
        let negGexStrikes = [];

        for (const call of calls) {
          const K  = call.strike || 0;
          const oi = call.openInterest || 0;
          if (!K || !oi) continue;
          const d1    = (Math.log(currentPrice / K) + (0.5 * ivForGex * ivForGex * T)) / (ivForGex * Math.sqrt(T));
          const gamma = Math.exp(-0.5 * d1 * d1) / (Math.sqrt(2 * Math.PI) * currentPrice * ivForGex * Math.sqrt(T));
          const gex   = oi * gamma * 100 * currentPrice; // calls = positive GEX (dealers long)
          totalGex += gex;
          gexByStrike[K] = (gexByStrike[K] || 0) + gex;
        }

        for (const put of puts) {
          const K  = put.strike || 0;
          const oi = put.openInterest || 0;
          if (!K || !oi) continue;
          const d1    = (Math.log(currentPrice / K) + (0.5 * ivForGex * ivForGex * T)) / (ivForGex * Math.sqrt(T));
          const gamma = Math.exp(-0.5 * d1 * d1) / (Math.sqrt(2 * Math.PI) * currentPrice * ivForGex * Math.sqrt(T));
          const gex   = -(oi * gamma * 100 * currentPrice); // puts = negative GEX (dealers short)
          totalGex += gex;
          gexByStrike[K] = (gexByStrike[K] || 0) + gex;
        }

        // GEX zero cross — strike where GEX flips from positive to negative
        // This is the true gamma flip level — most important level in options
        const sortedGexStrikes = Object.entries(gexByStrike)
          .map(([k,g]) => ({ strike: parseFloat(k), gex: g }))
          .sort((a,b) => a.strike - b.strike);

        // Find strikes near current price with highest absolute GEX
        const nearStrikes = sortedGexStrikes.filter(s =>
          Math.abs(s.strike - currentPrice) <= currentPrice * 0.05 // within 5%
        );

        // GEX pin level = strike with highest positive GEX near spot (dealers most hedged here)
        const pinCandidates = nearStrikes.filter(s => s.gex > 0).sort((a,b) => b.gex - a.gex);
        const gexPinLevel   = pinCandidates[0] || null;

        // GEX zero cross — where total cumulative GEX flips sign
        let cumGex = 0;
        let gexZeroCross = null;
        for (const s of sortedGexStrikes) {
          const prevCum = cumGex;
          cumGex += s.gex;
          if (prevCum > 0 && cumGex <= 0 || prevCum < 0 && cumGex >= 0) {
            gexZeroCross = s.strike;
            break;
          }
        }

        // GEX regime
        const gexRegime = totalGex > 0
          ? 'POSITIVE GEX — dealers are long gamma. They BUY when price falls and SELL when price rises. Expect mean reversion, range-bound price action, and resistance at call walls.'
          : 'NEGATIVE GEX — dealers are short gamma. They SELL when price falls and BUY when price rises. Expect trend continuation, volatility expansion, and acceleration through key levels.';

        // Top GEX strikes — largest absolute exposure
        const topGexStrikes = [...sortedGexStrikes]
          .sort((a,b) => Math.abs(b.gex) - Math.abs(a.gex))
          .slice(0, 5)
          .map(s => `$${s.strike} (${s.gex > 0 ? '+' : ''}${(s.gex/1e6).toFixed(1)}M)`)
          .join(', ');

        // Price vs pin level
        const distToPin = gexPinLevel ? (currentPrice - gexPinLevel.strike).toFixed(2) : null;
        const pinContext = !gexPinLevel ? 'No clear pin level identified' :
          Math.abs(parseFloat(distToPin)) < 0.50 ? `⚠ PRICE AT GEX PIN $${gexPinLevel.strike} — strong magnetic pull, expect range-bound chop` :
          parseFloat(distToPin) > 0 ? `Price $${distToPin} ABOVE pin at $${gexPinLevel.strike} — gravity pulling back down` :
          `Price $${Math.abs(distToPin)} BELOW pin at $${gexPinLevel.strike} — gravity pulling up toward pin`;

        // ── PHASE 4 #24: Zero-Gamma Volatility Trigger ───────────────────
        const inChaosZone = gexZeroCross !== null && currentPrice < gexZeroCross;
        const zeroCrossContext = !gexZeroCross
          ? 'Zero-gamma level not identified'
          : inChaosZone
            ? `🚨 CHAOS ZONE — price $${currentPrice.toFixed(2)} is BELOW zero-gamma $${gexZeroCross}. Dealers short gamma, amplifying every move. Puts accelerate 2-3x. Bounces are dealer traps.`
            : `Stable zone — price $${currentPrice.toFixed(2)} above zero-gamma $${gexZeroCross}. Dealers long gamma, dampening volatility. Mean reversion favoured.`;

        // ── PHASE 4 #25: Net Delta Exposure ──────────────────────────────
        // Approximate Black-Scholes delta: call delta = N(d1), put delta = N(d1)-1
        const normCDF = z => {
          const a = [0.319381530,-0.356563782,1.781477937,-1.821255978,1.330274429];
          const t = 1/(1+0.2316419*Math.abs(z));
          let p = t*(a[0]+t*(a[1]+t*(a[2]+t*(a[3]+t*a[4]))));
          p *= 0.39894228*Math.exp(-0.5*z*z);
          return z >= 0 ? 1-p : p;
        };
        const ivND = atmIV || 0.20;
        const TND  = Math.max(0.0001, (nearestExpiry - now)/(365*24*3600));
        let totalNetDelta = 0;
        for (const c of calls) {
          const K = c.strike||0, oi = c.openInterest||0;
          if (!K||!oi) continue;
          const d1 = (Math.log(currentPrice/K) + 0.5*ivND*ivND*TND)/(ivND*Math.sqrt(TND));
          totalNetDelta += normCDF(d1)*oi*100;
        }
        for (const p of puts) {
          const K = p.strike||0, oi = p.openInterest||0;
          if (!K||!oi) continue;
          const d1 = (Math.log(currentPrice/K) + 0.5*ivND*ivND*TND)/(ivND*Math.sqrt(TND));
          totalNetDelta += (normCDF(d1)-1)*oi*100;
        }
        const netDeltaM = (totalNetDelta/1e6).toFixed(1);
        const netDeltaContext = totalNetDelta > 50e6
          ? `+${netDeltaM}M — HEAVY SYNTHETIC LONG. Call delta overhang forces dealers to short QQQ. Price rises = dealer buying pressure.`
          : totalNetDelta > 10e6
          ? `+${netDeltaM}M — Net long bias. Modest call-side overhang.`
          : totalNetDelta < -50e6
          ? `${netDeltaM}M — HEAVY SYNTHETIC SHORT. Put delta overhang forces dealers to long QQQ. Price drops = dealer selling amplifies.`
          : totalNetDelta < -10e6
          ? `${netDeltaM}M — Net short bias. Modest put-side overhang.`
          : `${parseFloat(netDeltaM)>=0?'+':''}${netDeltaM}M — Balanced. No dominant synthetic pressure.`;

        // ── PHASE 4 #26: Order Flow Imbalance (Volume/OI ratio) ──────────
        // Vol/OI > 2x on meaningful OI = fresh institutional positioning this session
        const callFlowHits = calls
          .filter(c => (c.openInterest||0) > 500 && (c.volume||0) > 0)
          .map(c => ({ strike:c.strike, ratio:(c.volume/c.openInterest), vol:c.volume, oi:c.openInterest }))
          .filter(c => c.ratio > 2)
          .sort((a,b) => b.ratio-a.ratio).slice(0,3);
        const putFlowHits = puts
          .filter(p => (p.openInterest||0) > 500 && (p.volume||0) > 0)
          .map(p => ({ strike:p.strike, ratio:(p.volume/p.openInterest), vol:p.volume, oi:p.openInterest }))
          .filter(p => p.ratio > 2)
          .sort((a,b) => b.ratio-a.ratio).slice(0,3);
        const callFlowStr = callFlowHits.length
          ? callFlowHits.map(c=>`$${c.strike}(${c.ratio.toFixed(1)}x)`).join(', ')
          : 'No unusual call flow';
        const putFlowStr = putFlowHits.length
          ? putFlowHits.map(p=>`$${p.strike}(${p.ratio.toFixed(1)}x)`).join(', ')
          : 'No unusual put flow';
        const totalCallFlowVol = callFlowHits.reduce((s,c)=>s+c.vol,0);
        const totalPutFlowVol  = putFlowHits.reduce((s,p)=>s+p.vol,0);
        const flowImbalance = (totalCallFlowVol+totalPutFlowVol) === 0 ? 'NEUTRAL — no unusual positioning'
          : totalCallFlowVol > totalPutFlowVol*2 ? 'AGGRESSIVE CALL BUYING — institutional directional long or squeeze play'
          : totalPutFlowVol  > totalCallFlowVol*2 ? 'AGGRESSIVE PUT BUYING — institutional hedge or directional short'
          : 'MIXED — both calls and puts seeing unusual flow';

        // ── PHASE 4 #27: Strike Clustering Pin Probability Score ─────────
        // Each force that converges on the same strike adds points
        const pinStrike = gexPinLevel?.strike || null;
        let pinScore = 0;
        const pinFactors = [];
        if (pinStrike) {
          pinScore += 30; pinFactors.push('GEX pin base (+30)');
          if (maxPainStrike && Math.abs(maxPainStrike-pinStrike) <= 1) {
            pinScore += 25; pinFactors.push(`Max pain $${maxPainStrike} confluent (+25)`);
          }
          const pinCallOI = calls.find(c=>c.strike===pinStrike)?.openInterest||0;
          const pinPutOI  = puts.find(p=>p.strike===pinStrike)?.openInterest||0;
          const pinTotalOI = pinCallOI+pinPutOI;
          if (pinTotalOI > 10000)      { pinScore += 20; pinFactors.push(`High OI ${pinTotalOI.toLocaleString()} at pin (+20)`); }
          else if (pinTotalOI > 3000)  { pinScore += 10; pinFactors.push(`Moderate OI at pin (+10)`); }
          if (pinStrike % 5 === 0)     { pinScore += 15; pinFactors.push('Round $5 strike (+15)'); }
          else if (pinStrike % 1 === 0){ pinScore +=  5; pinFactors.push('Whole dollar strike (+5)'); }
          if (callWallAbove?.strike && putWallBelow?.strike) {
            if (pinStrike >= putWallBelow.strike && pinStrike <= callWallAbove.strike) {
              pinScore += 10; pinFactors.push('Bracketed by OI walls (+10)');
            }
          }
        }
        pinScore = Math.min(100, pinScore);
        const pinScoreContext = pinScore >= 80
          ? `🔴 EXTREME PIN (${pinScore}/100) — multiple forces at $${pinStrike}. 0DTE options near this strike bleed theta regardless of direction. Trade strikes AWAY from pin.`
          : pinScore >= 60 ? `⚠ HIGH PIN (${pinScore}/100) — strong gravity at $${pinStrike}. Avoid ATM entries near this level.`
          : pinScore >= 40 ? `MODERATE PIN (${pinScore}/100) at $${pinStrike}. Monitor for magnetic pull.`
          : pinScore >  0  ? `LOW PIN (${pinScore}/100) — GEX factor only. Directional moves likely.`
          : 'NO PIN — no GEX pin identified. Directional moves can extend freely.';

        results.options = {
          expiry:         expiryDate,
          currentPrice:   currentPrice.toFixed(2),
          // Gamma walls (OI-based)
          callWallAbove:  callWallAbove  ? `$${callWallAbove.strike} (OI: ${(callWallAbove.openInterest||0).toLocaleString()})` : 'N/A',
          putWallBelow:   putWallBelow   ? `$${putWallBelow.strike} (OI: ${(putWallBelow.openInterest||0).toLocaleString()})`  : 'N/A',
          topCallWall:    topCallWall    ? `$${topCallWall.strike} (OI: ${(topCallWall.openInterest||0).toLocaleString()})`    : 'N/A',
          topPutWall:     topPutWall     ? `$${topPutWall.strike} (OI: ${(topPutWall.openInterest||0).toLocaleString()})`     : 'N/A',
          topCallWall2:   topCallWall2   ? `$${topCallWall2.strike} (OI: ${(topCallWall2.openInterest||0).toLocaleString()})` : 'N/A',
          topPutWall2:    topPutWall2    ? `$${topPutWall2.strike} (OI: ${(topPutWall2.openInterest||0).toLocaleString()})`   : 'N/A',
          gammaFlipZone,
          maxPain:        maxPainStrike ? `$${maxPainStrike}` : 'N/A',
          totalCallOI:    totalCallOI.toLocaleString(),
          totalPutOI:     totalPutOI.toLocaleString(),
          pcRatio,
          pcContext,
          // ATM straddle prices for expected move calculation
          atmCallPrice:   atmCalls[0]?.lastPrice?.toFixed(2) || '0',
          atmPutPrice:    atmPuts[0]?.lastPrice?.toFixed(2)  || '0',
          atmIV:          atmIV ? (atmIV * 100).toFixed(1)+'%' : 'N/A',
          ivContext,
          // GEX fields
          gexRegime,
          gexPinLevel:    gexPinLevel ? `$${gexPinLevel.strike} (GEX: +${(gexPinLevel.gex/1e6).toFixed(1)}M)` : 'N/A',
          gexZeroCross:   gexZeroCross ? `$${gexZeroCross}` : 'N/A',
          pinContext,
          topGexStrikes,
          totalGex:       `${totalGex > 0 ? '+' : ''}${(totalGex/1e6).toFixed(0)}M`,
          gexPositive:    totalGex > 0,
          // Phase 4 fields
          inChaosZone,
          zeroCrossContext,
          netDelta:       `${parseFloat(netDeltaM)>=0?'+':''}${netDeltaM}M`,
          netDeltaContext,
          callFlow:       callFlowStr,
          putFlow:        putFlowStr,
          flowImbalance,
          pinScore,
          pinScoreContext,
          pinFactors:     pinFactors.join(' | ') || 'N/A',
        };

        console.log(`[Phase4] ZeroGamma:$${gexZeroCross||'N/A'}${inChaosZone?' 🚨CHAOS':''} | NetDelta:${netDeltaM}M | Flow:${flowImbalance.split(' ')[0]} | Pin:${pinScore}/100`);
      }
    }

  } catch (err) {
    console.warn(`[Yahoo Finance] ${ticker}:`, err.message);
    results.error = err.message;
  }

  // ── ENGINE 4 — CORRELATED ASSETS + VIX SHIELD ─────────────────────────
  // Fetch NVDA, AAPL, SPY, TNX, VIX, VIX1D in parallel
  // All free via Yahoo Finance — no API key required
  // These run independently so a single failure doesn't block the main data
  try {
    const correlTickers = {
      NVDA:  'NVDA',
      AAPL:  'AAPL',
      SPY:   'SPY',
      TNX:   '%5ETNX',   // 10-Year Treasury Yield
      VIX:   '%5EVIX',   // 30-day VIX
      VIX1D: '%5EVIX1D', // 1-day VIX (0DTE specific)
    };

    const correlFetches = Object.entries(correlTickers).map(async ([name, sym]) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=2d`;
        const res = await fetchWithTimeout(url, 5000);
        const data = await res.json();
        const m = data?.chart?.result?.[0]?.meta || null;
        if (!m) return [name, null];
        const price     = m.regularMarketPrice    || null;
        const prevClose = m.chartPreviousClose    || m.previousClose || null;
        const change    = (price && prevClose) ? ((price - prevClose) / prevClose * 100) : null;
        return [name, { price, prevClose, change: change ? parseFloat(change.toFixed(2)) : null }];
      } catch (_) { return [name, null]; }
    });

    const correlResults = await Promise.all(correlFetches);
    const correl = Object.fromEntries(correlResults);

    // ── Correlation analysis ───────────────────────────────────────────
    const nvda  = correl.NVDA;
    const aapl  = correl.AAPL;
    const spy   = correl.SPY;
    const tnx   = correl.TNX;
    const vix   = correl.VIX;
    const vix1d = correl.VIX1D;

    // QQQ vs SPY divergence — if SPY making new low while QQQ bounces, bounce is suspect
    const qqq    = results.quote;
    const qqqChg = qqq?.priceChange ? parseFloat(qqq.priceChange.replace('%','')) : null;
    const spyChg = spy?.change;
    const spyDiv = (qqqChg !== null && spyChg !== null)
      ? Math.abs(qqqChg - spyChg) > 0.5
        ? qqqChg > spyChg
          ? `⚠ QQQ outperforming SPY by ${(qqqChg-spyChg).toFixed(1)}% — divergence, QQQ move may not be broad-based`
          : `⚠ QQQ underperforming SPY by ${(spyChg-qqqChg).toFixed(1)}% — tech sector lagging`
        : `QQQ/SPY tracking closely (${qqqChg > 0 ? '+' : ''}${qqqChg}% vs ${spyChg > 0 ? '+' : ''}${spyChg}%)`
      : 'N/A';

    // TNX impact on QQQ — yields rising hurts tech
    const tnxImpact = !tnx?.change ? 'N/A'
      : tnx.change > 2   ? `⚠ TNX RIPPING +${tnx.change}% — yields surging, STRONG headwind for QQQ longs. Reduce bull conviction 30%.`
      : tnx.change > 1   ? `⚠ TNX +${tnx.change}% — yields rising, headwind for QQQ longs. Reduce bull conviction 20%.`
      : tnx.change > 0.5 ? `TNX +${tnx.change}% — mild yield pressure, monitor`
      : tnx.change < -1  ? `✅ TNX ${tnx.change}% — yields falling, tailwind for QQQ`
      : `TNX ${tnx.change > 0 ? '+' : ''}${tnx.change}% — neutral yield environment`;

    // NVDA drag — QQQ is heavily NVDA weighted
    const nvdaImpact = !nvda?.change ? 'N/A'
      : nvda.change < -3 ? `⚠ NVDA ${nvda.change}% — major QQQ component crashing. Bull signals are TRAPS.`
      : nvda.change < -1.5 ? `⚠ NVDA ${nvda.change}% — weight drag on QQQ, reduce bull conviction`
      : nvda.change > 3  ? `✅ NVDA +${nvda.change}% — mega-cap fuel for QQQ rally`
      : nvda.change > 1  ? `✅ NVDA +${nvda.change}% — positive NVDA supporting QQQ`
      : `NVDA ${nvda.change > 0 ? '+' : ''}${nvda.change}% — neutral contribution`;

    // AAPL drag
    const aaplImpact = !aapl?.change ? 'N/A'
      : aapl.change < -2 ? `⚠ AAPL ${aapl.change}% — largest QQQ weight falling`
      : aapl.change > 2  ? `✅ AAPL +${aapl.change}% — largest weight supporting rally`
      : `AAPL ${aapl.change > 0 ? '+' : ''}${aapl.change}%`;

    // VIX regime analysis
    const vixVal   = vix?.price   || null;
    const vix1dVal = vix1d?.price || null;
    const vixChg   = vix?.change  || null;

    // Vanna tail: VIX falling + price rising = dealers unhedging short puts = mechanical buying
    // Divergence trap: VIX rising + price rising = borrowed time
    const vixSignal = !vixVal ? 'N/A'
      : vixVal > 30  ? `EXTREME FEAR (VIX ${vixVal}) — market in panic regime, 0DTE calls are lottery tickets`
      : vixVal > 20  ? `ELEVATED VIX (${vixVal}) — uncertainty high, options expensive`
      : vixVal > 15  ? `MODERATE VIX (${vixVal}) — normal conditions`
      : `LOW VIX (${vixVal}) — complacency, cheap options but moves can surprise`;

    const vixVsPrice = !vixChg || !qqqChg ? 'N/A'
      : vixChg < -1 && qqqChg > 0  ? `✅ VANNA TAIL — VIX falling (${vixChg}%) + QQQ rising = dealers forced to buy. HIGH CONVICTION bull.`
      : vixChg > 1  && qqqChg > 0  ? `⚠ DIVERGENCE TRAP — VIX rising (${vixChg}%) + QQQ rising = unsustainable. Exit longs.`
      : vixChg > 1  && qqqChg < 0  ? `✅ VIX/price aligned bearish — ${vixChg}% VIX rise confirms downside`
      : vixChg < -1 && qqqChg < 0  ? `⚠ VIX falling but QQQ falling — unusual, potential bear trap`
      : `VIX ${vixChg > 0 ? '+' : ''}${vixChg}% — neutral relative to price action`;

    // VIX1D vs VIX — 0DTE specific danger signal
    const vix1dWarning = !vix1dVal || !vixVal ? 'N/A'
      : vix1dVal > vixVal * 1.1
        ? `⚠ VIX1D (${vix1dVal}) > VIX (${vixVal}) — 0DTE market pricing EXTREME near-term danger. Reduce call sizing 50%.`
        : vix1dVal < vixVal * 0.9
        ? `✅ VIX1D (${vix1dVal}) < VIX (${vixVal}) — near-term calmer than 30-day avg. 0DTE conditions favorable.`
        : `VIX1D ${vix1dVal} ≈ VIX ${vixVal} — near-term vol in line with 30-day average`;

    // VIX panic regime — if VIX moved >5% in session, ignore technicals
    const vixPanic = vixChg && Math.abs(vixChg) > 5
      ? `🚨 VIX PANIC REGIME — VIX moved ${vixChg > 0 ? '+' : ''}${vixChg}% today. Ignore all technical signals. Market in chaos mode.`
      : null;

    results.correlations = {
      raw: { nvda, aapl, spy, tnx, vix, vix1d },
      nvdaImpact,
      aaplImpact,
      spyDiv,
      tnxImpact,
      vixSignal,
      vixVsPrice,
      vix1dWarning,
      vixPanic,
      vixVal:   vixVal   ? vixVal.toFixed(2)   : 'N/A',
      vix1dVal: vix1dVal ? vix1dVal.toFixed(2) : 'N/A',
      tnxVal:   tnx?.price ? tnx.price.toFixed(2)+'%' : 'N/A',
      nvdaChg:  nvda?.change !== null ? (nvda.change > 0 ? '+' : '')+nvda.change+'%' : 'N/A',
      aaplChg:  aapl?.change !== null ? (aapl.change > 0 ? '+' : '')+aapl.change+'%' : 'N/A',
      spyChg:   spy?.change  !== null ? (spy.change  > 0 ? '+' : '')+spy.change+'%'  : 'N/A',
      tnxChg:   tnx?.change  !== null ? (tnx.change  > 0 ? '+' : '')+tnx.change+'%'  : 'N/A',
      vixChg:   vixChg !== null ? (vixChg > 0 ? '+' : '')+vixChg+'%' : 'N/A',
    };

    console.log(`[Correlations] NVDA:${results.correlations.nvdaChg} AAPL:${results.correlations.aaplChg} SPY:${results.correlations.spyChg} TNX:${results.correlations.tnxChg} VIX:${results.correlations.vixVal}(${results.correlations.vixChg}) VIX1D:${results.correlations.vix1dVal}`);

  } catch (err) {
    console.warn('[Correlations]', err.message);
    results.correlations = null;
  }

  // ── VOLATILITY SKEW — OTM put IV vs OTM call IV ────────────────────────
  // Negative skew = puts more expensive than calls = institutional hedging fear
  try {
    if (results.options && !isCrypto) {
      const optUrl2 = `https://query1.finance.yahoo.com/v7/finance/options/${yahooTicker}`;
      const optRes2 = await fetchWithTimeout(optUrl2, 5000);
      const optData2 = await optRes2.json();
      const optResult2 = optData2?.optionChain?.result?.[0] || null;

      if (optResult2) {
        const calls2 = optResult2.options?.[0]?.calls || [];
        const puts2  = optResult2.options?.[0]?.puts  || [];
        const cp2    = optResult2.quote?.regularMarketPrice || parseFloat(results.quote?.price) || 0;

        // Find 5% OTM call and put
        const otmCallTarget = cp2 * 1.05;
        const otmPutTarget  = cp2 * 0.95;

        const otmCall = calls2
          .filter(c => c.strike && c.impliedVolatility)
          .sort((a,b) => Math.abs(a.strike - otmCallTarget) - Math.abs(b.strike - otmCallTarget))[0];
        const otmPut = puts2
          .filter(p => p.strike && p.impliedVolatility)
          .sort((a,b) => Math.abs(a.strike - otmPutTarget) - Math.abs(b.strike - otmPutTarget))[0];

        if (otmCall && otmPut) {
          const callIV = otmCall.impliedVolatility;
          const putIV  = otmPut.impliedVolatility;
          const skew   = ((putIV - callIV) / callIV * 100).toFixed(1);
          const skewContext = parseFloat(skew) > 30
            ? `⚠ HEAVY NEGATIVE SKEW (${skew}%) — puts ${skew}% more expensive than calls. Institutional crash hedging. STRONG headwind for calls.`
            : parseFloat(skew) > 15
            ? `NEGATIVE SKEW (${skew}%) — protective put buying elevated. Mild headwind for calls.`
            : parseFloat(skew) > -5
            ? `NEUTRAL SKEW (${skew}%) — balanced options market`
            : `POSITIVE SKEW (${skew}%) — calls more expensive, unusual, potential squeeze setup`;

          results.options.skew = {
            callIV: (callIV * 100).toFixed(1) + '%',
            putIV:  (putIV  * 100).toFixed(1) + '%',
            skewPct: skew + '%',
            skewContext,
            callStrike: otmCall.strike,
            putStrike:  otmPut.strike,
          };
          console.log(`[Skew] 5% OTM Call IV: ${(callIV*100).toFixed(1)}% | Put IV: ${(putIV*100).toFixed(1)}% | Skew: ${skew}%`);
        }
      }
    }
  } catch (err) {
    console.warn('[Skew]', err.message);
  }

  return results;
}

// ══════════════════════════════════════════════════════════════════════════
//  ENGINE 1A — HRTC SIGNAL LOGIC
// ══════════════════════════════════════════════════════════════════════════
function computeSignals({ rsi_now, rsi_prev, harsi_candle, harsi_prev, divergence, action }) {
  // If we have a direct action from the strategy, trust it
  if (action === 'buy')   return { rsiRising:true,  rsiBull:true,  rsiBear:false, harsiBull:true,  harsiBear:false, overallBull:true,  overallBear:false };
  if (action === 'sell')  return { rsiRising:false, rsiBull:false, rsiBear:true,  harsiBull:false, harsiBear:true,  overallBull:false, overallBear:true  };
  if (action === 'close') return { rsiRising:false, rsiBull:false, rsiBear:false, harsiBull:false, harsiBear:false, overallBull:false, overallBear:false, isClose:true };

  const rsiRising    = parseFloat(rsi_now)  >= parseFloat(rsi_prev);
  const prevPositive = parseFloat(rsi_prev) >= 0;
  const rsiBull      = rsiRising  && !prevPositive;
  const rsiBear      = !rsiRising && prevPositive;
  const harsiBull    = harsi_candle === 'bullish' && harsi_prev === 'bearish';
  const harsiBear    = harsi_candle === 'bearish' && harsi_prev === 'bullish';
  const overallBull  = harsiBull || rsiBull || (rsiRising  && divergence === 'bull');
  const overallBear  = harsiBear || rsiBear || (!rsiRising && divergence === 'bear');
  return { rsiRising, rsiBull, rsiBear, harsiBull, harsiBear, overallBull, overallBear };
}

// ══════════════════════════════════════════════════════════════════════════
//  ENGINE 1B — SIGNAL QUALITY SCORER (0–100)
//  Strategy signals get a base quality boost since they've already passed
//  HTF filter, momentum filter, and OB/OS filter before firing
// ══════════════════════════════════════════════════════════════════════════
function scoreSignal({ rsi_now, rsi_prev, divergence, timeframe, signals, format,
                        cvd_bias, cvd_strength, cvd_confirmed }) {
  const rsiVal = parseFloat(rsi_now);
  const rsiAbs = Math.abs(rsiVal);
  const isBull = signals.overallBull;
  const breakdown = {};

  // Confluence — strategy signals get full confluence since filters already passed
  let conf = 0;
  const isStrategy = format === 'v5';
  if (isStrategy) {
    conf = 35; // HTF confirmed + momentum filtered + signal fired = full confluence
  } else {
    const harsiFlip = signals.harsiBull || signals.harsiBear;
    const rsiFlip   = signals.rsiBull   || signals.rsiBear;
    const dirMatch  = (isBull && signals.rsiRising) || (!isBull && !signals.rsiRising);
    if (harsiFlip)            conf += 15;
    if (rsiFlip)              conf += 10;
    if (dirMatch)             conf += 5;
    if (harsiFlip && rsiFlip) conf += 5;
  }
  breakdown.confluence = { score: conf, max: 35,
    items: isStrategy
      ? [{ label: 'Strategy signal: HTF + momentum + OB/OS filters passed', pts: 35, hit: true }]
      : [
          { label: 'HARSI candle flip',       pts: (signals.harsiBull||signals.harsiBear) ? 15 : 0, hit: signals.harsiBull||signals.harsiBear },
          { label: 'RSI zero-cross flip',     pts: (signals.rsiBull||signals.rsiBear)     ? 10 : 0, hit: signals.rsiBull||signals.rsiBear     },
          { label: 'RSI direction aligned',   pts: ((isBull&&signals.rsiRising)||(!isBull&&!signals.rsiRising)) ? 5 : 0, hit: true },
        ]
  };

  let rsiPts = rsiAbs >= 25 ? 22 : rsiAbs >= 15 ? 17 : rsiAbs >= 5 ? 11 : 4;
  const delta  = Math.abs(rsiVal - parseFloat(rsi_prev));
  const mBonus = delta >= 5 ? 3 : delta >= 2 ? 1 : 0;
  rsiPts = Math.min(25, rsiPts + mBonus);
  const strength = rsiAbs >= 25 ? 'Very Strong' : rsiAbs >= 15 ? 'Strong' : rsiAbs >= 5 ? 'Medium' : 'Weak';
  breakdown.rsiStrength = { score: rsiPts, max: 25,
    items: [
      { label: `Momentum ${strength} (|RSI| = ${rsiAbs.toFixed(1)})`, pts: rsiPts - mBonus, hit: true },
      { label: `Acceleration bonus (Δ${delta.toFixed(1)})`,           pts: mBonus,          hit: mBonus > 0 },
    ]
  };

  const divConfirms = (divergence === 'bull' && isBull) || (divergence === 'bear' && !isBull);
  const divOpposes  = (divergence === 'bull' && !isBull) || (divergence === 'bear' && isBull);
  const divPts      = divConfirms ? 20 : 0;
  breakdown.divergence = { score: divPts, max: 20, warning: divOpposes,
    items: [!divergence || divergence === 'none'
      ? { label: 'No divergence', pts: 0, hit: false }
      : divConfirms
        ? { label: `${divergence} div confirms`, pts: 20, hit: true }
        : { label: `${divergence} div OPPOSES ⚠`, pts: 0, hit: false, warn: true }
    ]
  };

  const tfMap = {
    '1m':3,'2m':4,'3m':5,'5m':7,'10m':9,'15m':12,'30m':14,
    '45m':15,'1H':16,'2H':17,'3H':17,'4H':18,'6H':18,
    '8H':19,'12H':19,'1D':20,'3D':20,'1W':20,'1M':20
  };
  const tf    = (timeframe||'').replace('min','m').replace('hour','H').replace('day','D');
  const tfPts = tfMap[tf] || tfMap[timeframe] || 10;
  const tfLbl = tfPts >= 18 ? 'High (daily+)' : tfPts >= 14 ? 'Medium-High' : tfPts >= 10 ? 'Medium' : 'Low (noisy)';
  breakdown.timeframe = { score: tfPts, max: 20,
    items: [{ label: `${timeframe} — ${tfLbl}`, pts: tfPts, hit: tfPts >= 12 }]
  };

  // ── CVD Confirmation (max +15, bonus on top of 100-pt base) ──────────
  // Treated as a bonus dimension rather than replacing an existing category
  // so it can push high-conviction aligned signals above 100 → Grade S territory
  let cvdPts = 0;
  const cvdItems = [];
  if (cvd_confirmed) {
    cvdPts += 10;
    cvdItems.push({ label: 'CVD gate confirmed (RSI + CVD direction aligned)', pts: 10, hit: true });
  }
  if (cvd_bias === 'STRONG_BUY'  && signals.overallBull) { cvdPts += 5; cvdItems.push({ label: 'CVD STRONG_BUY bias matches bull signal', pts: 5, hit: true }); }
  if (cvd_bias === 'STRONG_SELL' && signals.overallBear)  { cvdPts += 5; cvdItems.push({ label: 'CVD STRONG_SELL bias matches bear signal', pts: 5, hit: true }); }
  if (cvd_strength !== null && cvd_strength >= 70) { cvdPts += 3; cvdItems.push({ label: `CVD strength ${cvd_strength}/100 (high)`, pts: 3, hit: true }); }
  // Penalise conflicting CVD
  if (!cvd_confirmed && cvd_bias && (
    (signals.overallBull && (cvd_bias === 'STRONG_SELL' || cvd_bias === 'WEAK_SELL')) ||
    (signals.overallBear && (cvd_bias === 'STRONG_BUY'  || cvd_bias === 'WEAK_BUY'))
  )) {
    cvdPts -= 8;
    cvdItems.push({ label: `CVD bias ${cvd_bias} OPPOSES signal direction`, pts: -8, hit: false, warn: true });
  }
  breakdown.cvd = { score: cvdPts, max: 15, items: cvdItems.length ? cvdItems : [{ label: 'No CVD data', pts: 0, hit: false }] };

  const total = conf + rsiPts + divPts + tfPts + Math.max(0, cvdPts); // negative CVD penalty applied below
  const totalWithPenalty = conf + rsiPts + divPts + tfPts + cvdPts;
  const finalTotal = totalWithPenalty;
  const grade = finalTotal >= 80 ? 'A' : finalTotal >= 65 ? 'B' : finalTotal >= 50 ? 'C' : finalTotal >= 35 ? 'D' : 'F';
  const tier  = finalTotal >= 80 ? 'PREMIUM' : finalTotal >= 65 ? 'STRONG' : finalTotal >= 50 ? 'MODERATE' : finalTotal >= 35 ? 'WEAK' : 'NOISE';
  return { total: finalTotal, grade, tier, breakdown, divOpposes };
}


// ══════════════════════════════════════════════════════════════════════════
//  COMPOSITE SCORE — extends base 0-100 with dealer/market/timing context
//  Scores >100 = Grade S (all forces aligned)
//  Phase 1 item 7 — feeds Grade S detection in dashboard
// ══════════════════════════════════════════════════════════════════════════
function computeCompositeScore(baseScore, marketData, timeCtx, signals, orbCtx, rvolData) {
  const opts  = marketData?.options || null;
  const quote = marketData?.quote   || null;
  const isBull = signals.overallBull;
  let bonus = 0;
  const factors = [];

  // ── Dealer Flow (max +15) ──────────────────────────────────────────────
  if (opts) {
    // GEX regime aligned with signal direction
    const gexAligned = opts.gexPositive === false; // negative GEX = trending = good for directional
    if (gexAligned) { bonus += 5; factors.push('GEX negative regime (+5 trending)'); }

    // Price above/below gamma flip (zero cross) supports direction
    const zeroCross = parseFloat((opts.gexZeroCross||'0').replace('$',''));
    const price     = parseFloat(opts.currentPrice);
    const flipAligned = isBull ? price > zeroCross : price < zeroCross;
    if (zeroCross && flipAligned) { bonus += 5; factors.push('Price beyond gamma flip (+5)'); }

    // P/C ratio supports direction
    const pc = parseFloat(opts.pcRatio);
    const pcAligned = isBull ? pc < 0.8 : pc > 1.2;
    if (!isNaN(pc) && pcAligned) { bonus += 5; factors.push('P/C ratio aligned (+5)'); }

    // Phase 4: Chaos zone
    if (opts.inChaosZone) {
      if (!isBull) { bonus += 8;  factors.push('Chaos zone — puts accelerate (+8)'); }
      else         { bonus -= 10; factors.push('Chaos zone — calls fight dealers (-10)'); }
    }

    // Phase 4: Net delta overhang aligns with direction
    const ndVal = parseFloat((opts.netDelta||'0').replace(/[+M]/g,''));
    if  (isBull && ndVal >  50) { bonus += 5; factors.push('Heavy synthetic long overhang (+5)'); }
    if (!isBull && ndVal < -50) { bonus += 5; factors.push('Heavy synthetic short overhang (+5)'); }

    // Phase 4: Order flow imbalance confirmation or opposition
    if  (isBull && opts.flowImbalance?.includes('AGGRESSIVE CALL')) { bonus += 7; factors.push('Aggressive call flow confirms bull (+7)'); }
    if (!isBull && opts.flowImbalance?.includes('AGGRESSIVE PUT'))  { bonus += 7; factors.push('Aggressive put flow confirms bear (+7)'); }
    if  (isBull && opts.flowImbalance?.includes('AGGRESSIVE PUT'))  { bonus -= 6; factors.push('Aggressive put flow opposes bull (-6)'); }
    if (!isBull && opts.flowImbalance?.includes('AGGRESSIVE CALL')) { bonus -= 6; factors.push('Aggressive call flow opposes bear (-6)'); }

    // Phase 4: High pin probability = bad for 0DTE directional trades
    if      (opts.pinScore >= 80) { bonus -= 10; factors.push(`Extreme pin ${opts.pinScore}/100 (-10)`); }
    else if (opts.pinScore >= 60) { bonus -= 5;  factors.push(`High pin ${opts.pinScore}/100 (-5)`); }
  }

  // ── Market Context (max +10) ───────────────────────────────────────────
  if (quote) {
    // Volume above average
    const volR = parseFloat((quote.volRatio||'0').replace('%','').replace(' of avg',''));
    if (volR >= 120) { bonus += 5; factors.push('Volume 120%+ of avg (+5)'); }
    else if (volR >= 100) { bonus += 2; factors.push('Volume at avg (+2)'); }

    // No liquidity vacuum
    if (!quote.liqVacuum) { bonus += 3; factors.push('No liquidity vacuum (+3)'); }
    // Tight spread
    const sp = parseFloat((quote.spread||'999').replace('%',''));
    if (sp <= 0.05) { bonus += 2; factors.push('Tight spread (+2)'); }
  }

  // ── Session Timing (max +10) ───────────────────────────────────────────
  if (timeCtx.isMarketHours) {
    if (timeCtx.phase.includes('OPENING') || timeCtx.phase.includes('POWER HOUR')) {
      bonus += 7; factors.push('Prime session window (+7)');
    } else if (timeCtx.phase.includes('EARLY SESSION') || timeCtx.phase.includes('MID-MORNING')) {
      bonus += 4; factors.push('Good session window (+4)');
    } else if (timeCtx.phase.includes('DEAD ZONE') || timeCtx.phase.includes('FINAL') || timeCtx.phase.includes('LAST')) {
      bonus -= 5; factors.push('Poor session window (-5)');
    }
    if (timeCtx.thetaUrgency === 'EXTREME') { bonus -= 3; factors.push('Extreme theta decay (-3)'); }
    if (timeCtx.thetaUrgency === 'CRITICAL') { bonus -= 8; factors.push('Critical theta decay (-8)'); }
  }

  // ── Correlation & VIX Filters (can override to AVOID) ─────────────────
  const corr = marketData?.correlations || null;
  let correlOverride = false;
  if (corr) {
    // VIX panic — hard override
    if (corr.vixPanic) {
      bonus -= 50; factors.push('VIX PANIC REGIME (-50 override)');
      correlOverride = true;
    }
    // Vanna tail — bull conviction boost
    if (isBull && corr.vixVsPrice?.includes('VANNA TAIL')) {
      bonus += 8; factors.push('Vanna tail confirmed (+8)');
    }
    // Divergence trap — bull penalty
    if (isBull && corr.vixVsPrice?.includes('DIVERGENCE TRAP')) {
      bonus -= 10; factors.push('VIX divergence trap (-10)');
    }
    // VIX1D > VIX — near-term danger
    if (corr.vix1dWarning?.includes('EXTREME near-term')) {
      bonus -= 8; factors.push('VIX1D > VIX near-term danger (-8)');
    }
    // TNX headwind for bulls
    if (isBull) {
      if (corr.tnxImpact?.includes('RIPPING')) { bonus -= 12; factors.push('TNX ripping (-12 bull headwind)'); }
      else if (corr.tnxImpact?.includes('yields rising')) { bonus -= 6; factors.push('TNX rising (-6 bull headwind)'); }
      else if (corr.tnxImpact?.includes('tailwind')) { bonus += 4; factors.push('TNX falling (+4 bull tailwind)'); }
    }
    // NVDA drag on bulls
    if (isBull && corr.nvdaImpact?.includes('TRAP')) { bonus -= 10; factors.push('NVDA crashing (-10 bull trap)'); }
    else if (isBull && corr.nvdaImpact?.includes('fuel')) { bonus += 5; factors.push('NVDA surging (+5 bull fuel)'); }
    // Negative skew warning for calls
    if (isBull && opts?.skew?.skewContext?.includes('HEAVY NEGATIVE')) {
      bonus -= 8; factors.push('Heavy negative skew (-8 call headwind)');
    }
    // SPY confirmation for bulls
    if (isBull && corr.spyDiv?.includes('tracking closely') &&
        corr.raw?.spy?.change > 0) {
      bonus += 3; factors.push('SPY confirming (+3)');
    }
  }

  // ── Phase 5: Opening Range Bonus/Penalty ──────────────────────────────
  if (orbCtx) {
    if (orbCtx.bonus !== 0) {
      bonus += orbCtx.bonus;
      if (orbCtx.bonusLabel) factors.push(orbCtx.bonusLabel);
    }
    // Hard override for trap signals — correlOverride blocks Grade S
    if (orbCtx.bullTrap || orbCtx.bearTrap) correlOverride = true;
  }

  // ── Phase 5: RVOL time-normalized bonus/penalty ───────────────────────
  if (rvolData) {
    const rv = parseFloat(rvolData.rvol);
    if      (rv >= 3.0) { bonus += 8;  factors.push(`RVOL ${rvolData.rvol}x extreme (+8)`); }
    else if (rv >= 2.0) { bonus += 5;  factors.push(`RVOL ${rvolData.rvol}x high (+5)`); }
    else if (rv >= 1.3) { bonus += 2;  factors.push(`RVOL ${rvolData.rvol}x above avg (+2)`); }
    else if (rv < 0.4)  { bonus -= 6;  factors.push(`RVOL ${rvolData.rvol}x very low (-6)`); }
    else if (rv < 0.7)  { bonus -= 3;  factors.push(`RVOL ${rvolData.rvol}x below avg (-3)`); }
  }

  const composite = baseScore + bonus;
  const isGradeS  = composite > 100 && !correlOverride;
  const grade =
    composite <= 0     ? 'F' :
    isGradeS           ? 'S' :
    composite >= 80    ? 'A' :
    composite >= 65    ? 'B' :
    composite >= 50    ? 'C' :
    composite >= 35    ? 'D' : 'F';

  return { composite: Math.max(0, composite), bonus, grade, isGradeS, factors, correlOverride };
}

// ══════════════════════════════════════════════════════════════════════════
//  ENGINE 2 — TRIPLE-BRAIN AI PROMPT
// ══════════════════════════════════════════════════════════════════════════
async function runTripleBrainAnalysis(payload, signals, quality, marketData, timeCtx, composite, orbCtx, rvolData, earningsRisk) {
  const { ticker, timeframe, price, high, low, barVolume,
          rsi_now, rsi_prev, divergence, context, liquidity,
          action, format, harsi_candle, harsi_prev,
          cvd, delta, cvd_bias, cvd_strength, cvd_confirmed } = payload;

  const isBull      = signals.overallBull;
  const isClose     = action === 'close';
  const actionLabel = isClose ? 'EXIT/CLOSE' : isBull ? 'BUY CALL' : 'BUY PUT';
  const rsiStd      = (parseFloat(rsi_now) + 50).toFixed(1);
  const isStrategy  = format === 'v5';
  const q           = marketData?.quote   || null;
  const opts        = marketData?.options || null;

  const barRange  = (high && low) ? `$${low} – $${high} (range: $${(high-low).toFixed(2)})` : 'N/A';
  const barVolCtx = barVolume ? `${parseInt(barVolume).toLocaleString()} (this bar)` : 'N/A';

  // Detect asset
  const isQQQ    = (ticker||'').toUpperCase().includes('QQQ');
  const isCrypto = ['BTC','ETH','SOL','XRP'].some(c => (ticker||'').toUpperCase().includes(c));

  // S/R context
  const srCtx = isQQQ ? getQQQContext(price) : null;

  // ── Vanna/Charm assessment ─────────────────────────────────────────────
  const atmIV = parseFloat((opts?.atmIV||'0').replace('%',''));
  // Vanna risk: IV elevated (>20%) = dealer unhedging risk if IV drops
  const vannaRisk = atmIV > 30 ? 'HIGH — IV elevated, if IV drops dealers will unhedge, creating headwinds' :
                    atmIV > 20 ? 'MODERATE — IV above normal, monitor for IV crush' :
                    atmIV > 0  ? 'LOW — IV normal, vanna impact minimal' : 'N/A';
  // Vanna is helpful for bulls when IV is low (dealers don't need to unhedge)
  // Vanna is helpful for bears when IV is high (dealer unhedging creates selling pressure)
  const vannaGreen = isBull
    ? (atmIV > 0 && atmIV <= 20)   // low IV = vanna neutral/supportive for calls
    : (atmIV > 20);                 // high IV = dealer unhedging adds selling tailwind for puts
  const charmGreen = timeCtx.charmActive && opts && (
    // Charm is green for bulls when put OI > call OI (dealers buy back short stock hedges)
    isBull ? parseFloat(opts.pcRatio||'0') > 1.0 : parseFloat(opts.pcRatio||'0') < 0.8
  );
  const vannacharmStatus = `Vanna: ${vannaRisk} | Charm: ${timeCtx.charmRisk}${charmGreen ? ' ✅ working WITH position' : timeCtx.charmActive ? ' ⚠ monitor direction' : ''}`;

  // ── Expected move vs actual ────────────────────────────────────────────
  let expectedMoveSection = '';
  if (opts && q) {
    // ATM straddle = nearest call IV × underlying × sqrt(T/365) × 0.4 (simplified)
    // Better: use ATM call + ATM put last price if available
    const atmCallPrice = parseFloat(opts.atmCallPrice||'0');
    const atmPutPrice  = parseFloat(opts.atmPutPrice||'0');
    const expectedMove = (atmCallPrice + atmPutPrice) > 0
      ? (atmCallPrice + atmPutPrice).toFixed(2)
      : atmIV > 0 ? (q.price * (atmIV/100) * Math.sqrt(1/252) * 1.25).toFixed(2) : null;

    const actualMove = q.price && q.prevClose
      ? Math.abs(q.price - q.prevClose).toFixed(2) : null;
    const movePct = expectedMove && actualMove
      ? ((parseFloat(actualMove) / parseFloat(expectedMove)) * 100).toFixed(0) : null;

    if (expectedMove) {
      const moveWarning = movePct && parseInt(movePct) > 80
        ? `⚠ GAS TANK ${movePct}% USED — only $${(parseFloat(expectedMove)-parseFloat(actualMove)).toFixed(2)} of expected move remaining`
        : movePct ? `Gas tank ${movePct}% used — $${(parseFloat(expectedMove)-parseFloat(actualMove||0)).toFixed(2)} remaining` : '';
      expectedMoveSection = `Expected Daily Move: ±$${expectedMove} | Actual Move: $${actualMove||'N/A'} | ${moveWarning}`;
    }
  }

  // ── Build prompt sections ──────────────────────────────────────────────
  const corr = marketData?.correlations || null;

  // ── Correlation section for prompt ──────────────────────────────────────
  const correlSection = corr ? `
CROSS-ASSET CORRELATIONS
${corr.vixPanic ? corr.vixPanic + '\n' : ''}VIX: ${corr.vixVal} (${corr.vixChg}) — ${corr.vixSignal}
VIX1D: ${corr.vix1dVal} — ${corr.vix1dWarning}
VIX vs Price: ${corr.vixVsPrice}
TNX (10Y Yield): ${corr.tnxVal} (${corr.tnxChg}) — ${corr.tnxImpact}
NVDA: ${corr.nvdaChg} — ${corr.nvdaImpact}
AAPL: ${corr.aaplChg} — ${corr.aaplImpact}
SPY: ${corr.spyChg} — ${corr.spyDiv}` : '';

  // ── Skew section for prompt ──────────────────────────────────────────────
  const skewSection = opts?.skew ? `
VOLATILITY SKEW (5% OTM)
Call IV ($${opts.skew.callStrike}): ${opts.skew.callIV} | Put IV ($${opts.skew.putStrike}): ${opts.skew.putIV}
Skew: ${opts.skew.skewPct} — ${opts.skew.skewContext}` : '';

  const marketSection = q ? `
MARKET DATA
Price: $${q.price?.toFixed(2)||price} [${q.marketState||'CLOSED'}] | Range: $${q.dayLow?.toFixed(2)||'N/A'}–$${q.dayHigh?.toFixed(2)||'N/A'} | Open: $${q.open?.toFixed(2)||'N/A'}
Volume: ${q.volume} vs avg ${q.avgVolume} (${q.volRatio}) — ${q.volContext}
Bid/Ask: $${q.bid}/$${q.ask} | Spread: ${q.spread} — ${q.spreadContext}
${q.liqVacuum || '✓ No liquidity vacuum'}
${q.gapContext||''}
${expectedMoveSection}` : 'Market data unavailable';

  const optionsSection = opts ? `
OPTIONS & GEX [Exp: ${opts.expiry}]
Max Pain: ${opts.maxPain} | Gravity: ${timeCtx.maxPainGravity}
GEX Regime: ${opts.gexRegime}
GEX Pin: ${opts.gexPinLevel} | Zero Cross: ${opts.gexZeroCross} | ${opts.pinContext}
Zero-Gamma Trigger: ${opts.zeroCrossContext}
Call Wall: ${opts.callWallAbove} | Put Wall: ${opts.putWallBelow}
Top GEX Strikes: ${opts.topGexStrikes}
P/C: ${opts.pcRatio} (${opts.pcContext}) | ATM IV: ${opts.atmIV} (${opts.ivContext})
Net Delta Exposure: ${opts.netDelta} — ${opts.netDeltaContext}
Order Flow Imbalance: ${opts.flowImbalance}
  Unusual Call Flow: ${opts.callFlow}
  Unusual Put Flow:  ${opts.putFlow}
Pin Probability: ${opts.pinScoreContext}
  Contributing Factors: ${opts.pinFactors}
${vannacharmStatus}` : '';

  const srSection = srCtx ? `
S/R LEVELS
${srCtx.zoneStr || '✓ Price not in cluster zone'}
Resistance: ${srCtx.nearRStr} | Support: ${srCtx.nearSStr}
R/S Ratio: ${srCtx.rsRatio} → ${srCtx.rrContext}
Major R: ${srCtx.majorRStr} | Major S: ${srCtx.majorSStr}
${srCtx.clustered ? '⚠ DENSE CLUSTER — multiple levels within $2' : ''}` : '';

  // ── SYSTEM PROMPT ──────────────────────────────────────────────────────
  const systemPrompt = `You are the GCM HRTC Tactical Options Brain — a risk manager at an institutional trading desk specializing in QQQ 0DTE and 1DTE options. You are obsessed with theta decay and gamma exposure. You do not give financial advice; you provide high-conviction mathematical analysis of market microstructure and dealer positioning.

CORE RULES:
- If Score < 65: be extremely skeptical. Most signals at this level are noise.
- If Score > 85 or Grade S: be aggressive but warn of melt-up/melt-down traps.
- Always lead with GEX and dealer positioning before technicals.
- For 0DTE: theta is the enemy. Every minute costs premium. Only ACTIONABLE when conviction is high.
- For 1DTE: more runway but overnight gap risk. Flag if signal fires near close.
- DECISION must be exactly one of: ACTIONABLE / WAIT / AVOID

FRAMEWORK F — PHASE 4 OPTIONS INTELLIGENCE (apply every signal):
10. CHAOS ZONE: If price is below the zero-gamma level — puts accelerate 2-3x, calls fight dealer selling. Only recommend puts or AVOID for calls. State explicitly.
11. NET DELTA OVERHANG: Heavy negative net delta (< -50M) = synthetic short overhang caps rallies. Heavy positive (> +50M) = dealer dip-buying supports longs. Always factor this in.
12. ORDER FLOW IMBALANCE: Vol/OI > 2x at meaningful OI = fresh institutional positioning TODAY. Aggressive call buying confirms bull. Aggressive put buying = institutional hedge or short — red flag for calls.
13. PIN PROBABILITY ≥80: 0DTE options near pin strike will lose to theta even if direction is correct. Explicitly recommend strike AWAY from pin or state WAIT for pin break.
14. GAS TANK: If >80% of daily expected move already realised, flag as near-exhaustion. Reduce conviction for continuation trades and say how much move remains.

FRAMEWORK E — VIX SHIELD & CORRELATION FILTERS (apply before finalising DECISION):
1. VIX PANIC: If VIX moved >5% today — override everything. Output AVOID regardless of technicals. Market in chaos mode.
2. VIX1D > VIX: Near-term danger elevated. Reduce any call sizing recommendation by 50%. Flag explicitly.
3. VANNA TAIL: VIX falling + price rising = dealers mechanically buying (unhedging short puts). Upgrade bull conviction.
4. DIVERGENCE TRAP: VIX rising + price rising = unsustainable. Downgrade bull conviction. Warn to exit longs.
5. TNX > +1%: Strong headwind for QQQ longs. Reduce bull conviction 20%. Flag in analysis.
6. TNX > +2%: Severe headwind. Do not recommend ACTIONABLE for calls unless all other frameworks are exceptional.
7. NVDA < -3%: QQQ bull signals are likely traps. Flag as high-risk counter-trend entry.
8. NEGATIVE SKEW > 30%: Institutional crash hedging detected. Downgrade any call recommendation.
9. SPY DIVERGENCE: If QQQ and SPY diverging >0.5%, flag the move as potentially non-broad-based.

FRAMEWORK G — PHASE 5 SESSION STRUCTURE (apply every signal):
15. OPENING RANGE BREAKOUT: If established ORB exists and signal fires BELOW ORB low (bull) or ABOVE ORB high (bear) — flag as trap. Momentum opposes signal. High failure rate.
16. ORB CONFIRMATION: Signal direction matching ORB breakout = institutional confirmation. Upgrade conviction.
17. RVOL TIME-NORMALIZED: RVOL < 0.5x for this time window = thin market, moves may not sustain. RVOL > 2x = institutional conviction. Always reference RVOL in your analysis.
18. EARNINGS RISK: If earnings within 3 days, IV crush risk is severe. Flag and recommend smaller size or AVOID for overnight 1DTE.
19. TIME-WEIGHTED MINIMUM: After 2:30pm CST, composite score must be ≥80 for ACTIONABLE on 0DTE. Below this = WAIT regardless of technicals.

OUTPUT FORMAT — follow this exactly, no deviations:

SIGNAL: [BUY CALL / BUY PUT / EXIT] [suggested strike] @ $[price] | Score: [composite]/100 | [time CST] | [timeframe]

DIRECTION
[2-3 sentences: RSI momentum, HTF cloud alignment, OB/OS context. State conviction level clearly.]

GEX & PIN
- GEX: [total] | [POSITIVE pin mode / NEGATIVE trending mode]
- Critical: Pin $[level] | Flip $[level] | Call Wall $[level] | Put Wall $[level]
- Dealer Logic: [One sentence on how dealers will hedge this move.]
- Vanna/Charm: [status — working for or against position]

STRIKE GUIDANCE
- Target: $[strike] (~[delta] delta) — [why this strike]
- Avoid: $[strikes] — [reason: pin zone / theta trap / call wall]
- Theta Warning: [LOW / MEDIUM / HIGH / EXTREME / CRITICAL]

MAX PAIN & GRAVITY
- Max Pain: $[level] | Gravity: [strength]
- [One sentence: is price moving toward or away from max pain?]

IV & PREMIUM
- ATM IV: [%] | [CHEAP / FAIR / EXPENSIVE]
- P/C Flow: [interpretation]

LEVELS
- R: $[level] ([label]) | S: $[level] ([label]) | R/S: [ratio]
- [One note on volume or liquidity]

DECISION: [ACTIONABLE / WAIT / AVOID]
- ENTRY: [specific trigger + volume requirement]
- INVALIDATION: $[underlying level] — est. [X]% loss on premium
- 0DTE TACTIC: [time-based rule, e.g. "Exit by 2:00pm CST if target not reached"]
- 1DTE TACTIC: [overnight consideration, e.g. "Hold through open if above $X, exit pre-market otherwise"]`;

  // ── USER PROMPT ────────────────────────────────────────────────────────
  const userPrompt = `Analyze this QQQ options signal:

SESSION CONTEXT
Time: ${timeCtx.timeStr} | Phase: ${timeCtx.phase} | ${timeCtx.minutesLeft}min to close
Theta Urgency (0DTE): ${timeCtx.thetaUrgency} | Min Score Required: ${timeCtx.minScoreFor0DTE}/100
Max Pain Gravity: ${timeCtx.maxPainGravity} | Charm Risk: ${timeCtx.charmRisk}

SIGNAL
Ticker: ${ticker} | Action: ${actionLabel} | Price: $${price}
Timeframe: ${timeframe} | RSI: ${rsi_now} (prev: ${rsi_prev}) | HTF Bias: ${payload.htf_bias||'unknown'}
HARSI: ${harsi_candle} (was ${harsi_prev}) | Divergence: ${divergence||'none'} | OB/OS: ${payload.obos||'neutral'}
Signal: ${context} | Liquidity Tag: ${liquidity||'N/A'}
CVD: ${cvd !== null ? `${cvd > 0 ? '+' : ''}${cvd?.toFixed(0)} session | Delta: ${delta > 0 ? '+' : ''}${delta?.toFixed(0)} bar | Bias: ${cvd_bias||'N/A'} | Strength: ${cvd_strength??'N/A'}/100 | Gate: ${cvd_confirmed ? '✅ confirmed' : '⚠ not confirmed'}` : 'CVD data unavailable'}
${cvd_bias === 'STRONG_BUY'  && !signals.overallBull ? '⚠ CVD STRONG_BUY conflicts with BEAR signal — order flow divergence' : ''}
${cvd_bias === 'STRONG_SELL' && signals.overallBull  ? '⚠ CVD STRONG_SELL conflicts with BULL signal — order flow divergence' : ''}
${payload.htf_bias === 'bearish' && isBull ? '⚠ COUNTER-TREND: BUY signal vs bearish HTF cloud' : ''}
${payload.htf_bias === 'bullish' && !isBull && !isClose ? '⚠ COUNTER-TREND: SELL signal vs bullish HTF cloud' : ''}

SCORE
Base HRTC: ${quality.total}/100 (${quality.tier} ${quality.grade}) | Composite: ${composite.composite}/100 (Grade ${composite.grade})${composite.isGradeS ? ' 🌟 GRADE S — ALL FORCES ALIGNED' : ''}
Confluence: ${quality.breakdown.confluence.score}/35 | RSI: ${quality.breakdown.rsiStrength.score}/25 | Divergence: ${quality.breakdown.divergence.score}/20 | Timeframe: ${quality.breakdown.timeframe.score}/20
${composite.factors.length ? 'Composite factors: ' + composite.factors.join(', ') : ''}
${quality.divOpposes ? '⚠ DIVERGENCE OPPOSES SIGNAL — significant warning' : ''}
${composite.isGradeS ? '🌟 GRADE S: All dealer mechanics, market context, and technicals aligned simultaneously. Highest conviction setup.' : ''}

${marketSection}
${correlSection}
${skewSection}
${optionsSection}
${srSection}

OPENING RANGE BREAKOUT
${orbCtx?.established
  ? `ORB: $${orbCtx.orbLow}–$${orbCtx.orbHigh} (established)
Status: ${orbCtx.context}
${orbCtx.warning || '✓ Signal aligned with ORB structure'}`
  : orbCtx?.orbHigh
  ? `ORB forming: High $${orbCtx.orbHigh} / Low $${orbCtx.orbLow} (first 30min still in progress)`
  : 'ORB not yet established (pre-market or opening window)'}

SESSION INTELLIGENCE
RVOL: ${rvolData ? rvolData.rvolContext : 'N/A — bar volume not available'}
Earnings Risk: ${earningsRisk?.message || 'Not checked'}
Time-weighted min score: ${timeCtx.minScoreFor0DTE}/100 ${timeCtx.requiresHighScore ? '⚠ ELEVATED — after 2:30pm CST' : '(standard)'}
${orbCtx?.bullTrap ? '🚨 ORB BULL TRAP DETECTED — BUY below ORB low. AVOID calls.' : ''}
${orbCtx?.bearTrap ? '🚨 ORB BEAR TRAP DETECTED — SELL above ORB high. AVOID puts.' : ''}
${earningsRisk?.risk === 'HIGH' ? '🚨 ' + earningsRisk.message : ''}`;

  // ── API CALL WITH STREAMING ────────────────────────────────────────────
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1200,
      system:     systemPrompt,
      stream:     false, // we use SSE for dashboard streaming separately
      messages:   [{ role: 'user', content: userPrompt }]
    })
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.content?.map(b => b.text || '').join('') || '';

  const verdictMatch = text.match(/DECISION:\s*(ACTIONABLE|WAIT|AVOID)/i);
  const sizeMatch    = text.match(/POSITION SIZING:\s*(FULL|REDUCED|SKIP)/i) ||
                       text.match(/SIZE:\s*(FULL|REDUCED|SKIP)/i);
  const verdict      = verdictMatch ? verdictMatch[1].toUpperCase() : 'WAIT';
  const sizing       = sizeMatch    ? sizeMatch[1].toUpperCase()    : 'REDUCED';

  // Extract Vanna/Charm status for dashboard indicator
  const vannaCharmForDash = {
    vannaRisk,
    vannaGreen: atmIV > 0 && atmIV <= 20,
    charmGreen,
    charmRisk: timeCtx.charmRisk,
    charmActive: timeCtx.charmActive,
  };

  return { text, verdict, sizing, vannaCharmForDash, composite, timeCtx };
}


// ══════════════════════════════════════════════════════════════════════════
//  ROUTES
// ══════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) =>
  res.json({ status: 'GCM HRTC Triple Brain v5 online', clients: clients.size, signals: signalHistory.length }));

app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.add(res);
  res.write(`data: ${JSON.stringify({ type: 'history', signals: signalHistory })}\n\n`);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

app.get('/history', (req, res) => res.json(signalHistory));

// ── /market — live correlated asset snapshot (polled by dashboard every 60s) ──
app.get('/market', async (req, res) => {
  try {
    const tickers = { QQQ:'QQQ', NVDA:'NVDA', AAPL:'AAPL', SPY:'SPY', TNX:'%5ETNX', VIX:'%5EVIX', VIX1D:'%5EVIX1D' };
    const fetchQ = async (sym) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=2d`,
          { signal: controller.signal, headers: { 'User-Agent': 'Mozilla/5.0' } });
        clearTimeout(timer);
        const d = await r.json();
        const m = d?.chart?.result?.[0]?.meta || null;
        if (!m) return null;
        const price   = m.regularMarketPrice  || null;
        const prev    = m.chartPreviousClose  || m.previousClose || null;
        const change  = price && prev ? ((price - prev) / prev * 100) : null;
        const chg52wH = m.fiftyTwoWeekHigh ? ((price - m.fiftyTwoWeekHigh) / m.fiftyTwoWeekHigh * 100) : null;
        return { price, prev, change: change ? parseFloat(change.toFixed(2)) : null,
                 chg52wH: chg52wH ? parseFloat(chg52wH.toFixed(1)) : null };
      } catch (_) { clearTimeout(timer); return null; }
    };
    const results = await Promise.all(Object.entries(tickers).map(async ([k,v]) => [k, await fetchQ(v)]));
    const data = Object.fromEntries(results);
    const timeCtx = getTimeContext();
    res.json({ data, timeCtx, ts: Date.now() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/webhook', async (req, res) => {
  const raw = req.body;

  // Support both JSON body and plain string body (TradingView sometimes sends string)
  let body = raw;
  if (typeof raw === 'string') {
    try { body = JSON.parse(raw); } catch (_) { return res.status(400).json({ error: 'Invalid JSON' }); }
  }

  if (body.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  console.log(`[Webhook v5] ${body.ticker} ${body.action} @ $${body.price}`);
  res.json({ received: true });

  broadcast({ type: 'processing', ticker: body.ticker, timeframe: body.timeframe, ts: Date.now() });

  try {
    const payload    = normalisePayload(body);
    const signals    = computeSignals(payload);
    const quality    = scoreSignal({ ...payload, signals });
    const marketData = await fetchMarketData(payload.ticker);

    console.log(`[Yahoo] Vol: ${marketData?.quote?.volRatio||'N/A'} | Spread: ${marketData?.quote?.spread||'N/A'} | VWAP: ${marketData?.quote?.price||'N/A'}`);

    const timeCtx   = getTimeContext();

    // ── Phase 5: Opening Range ───────────────────────────────────────────
    updateOpeningRange(payload.ticker, payload.high, payload.low, timeCtx);
    const orb    = getOpeningRange(payload.ticker);
    const orbCtx = analyseOpeningRange(payload.price, orb, signals.overallBull);

    // ── Phase 5: RVOL normalization ──────────────────────────────────────
    const avgDailyVol = marketData?.quote?.avgVolume
      ? parseInt((marketData.quote.avgVolume||'0').replace(/,/g,'')) : null;
    const rvolData = computeRVOL(payload.barVolume || payload.volume, avgDailyVol, timeCtx.minutesIn);

    // ── Phase 5: Earnings risk check ─────────────────────────────────────
    const earningsRisk = await checkEarningsRisk(payload.ticker);

    const composite = computeCompositeScore(quality.total, marketData, timeCtx, signals, orbCtx, rvolData);
    const ai        = await runTripleBrainAnalysis(payload, signals, quality, marketData, timeCtx, composite, orbCtx, rvolData, earningsRisk);

    console.log(`[Score] Base: ${quality.total} | Composite: ${composite.composite} | Grade: ${composite.grade}${composite.isGradeS ? ' 🌟 GRADE S' : ''} | Vanna: ${ai.vannaCharmForDash?.vannaRisk?.split(' ')[0]||'N/A'} | Charm: ${timeCtx.charmRisk}`);

    const record = {
      type: 'signal', id: Date.now(),
      ticker:    payload.ticker,
      timeframe: payload.timeframe,
      price:     payload.price,
      high:      payload.high,
      low:       payload.low,
      barVolume: payload.barVolume,
      action:    payload.action,
      context:   payload.context,
      liquidity: payload.liquidity,
      rsi_now:   parseFloat(payload.rsi_now),
      rsi_prev:  parseFloat(payload.rsi_prev),
      divergence: payload.divergence,
      signals, quality, marketData,
      composite: ai.composite,
      timeCtx:   ai.timeCtx,
      vannaCharm: ai.vannaCharmForDash,
      isGradeS:  composite.isGradeS,
      analysis: ai.text,
      verdict:  ai.verdict,
      sizing:   ai.sizing,
      orbCtx,
      rvolData,
      earningsRisk,
      ts: Date.now()
    };

    signalHistory.unshift(record);
    if (signalHistory.length > 50) signalHistory.pop();
    broadcast(record);

    console.log(`[Done] ${payload.ticker} ${payload.action} | ${quality.total}/100 ${quality.tier} | ${ai.verdict} | ${ai.sizing}`);
  } catch (err) {
    console.error('[Error]', err.message);
    broadcast({ type: 'error', message: err.message, ts: Date.now() });
  }
});

app.listen(PORT, () => console.log(`GCM HRTC Triple Brain v5 on port ${PORT}`));
