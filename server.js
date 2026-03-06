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
  // CST = UTC-6, CDT = UTC-5. Railway runs UTC so we calculate CST offset
  const utcH   = now.getUTCHours();
  const utcM   = now.getUTCMinutes();
  // Approximate CST (UTC-6) — adjust to UTC-5 during daylight saving manually if needed
  const cstH   = (utcH - 6 + 24) % 24;
  const cstMin = utcM;
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

  const timeStr = `${String(cstH).padStart(2,'0')}:${String(cstMin).padStart(2,'0')} CST`;

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
        };

        console.log(`[Yahoo Options] ${yahooTicker} | GEX: ${(totalGex/1e6).toFixed(0)}M (${totalGex>0?'POSITIVE':'NEGATIVE'}) | Pin: $${gexPinLevel?.strike||'N/A'} | Zero Cross: $${gexZeroCross||'N/A'} | Max Pain: $${maxPainStrike} | P/C: ${pcRatio}`);
      }
    }

  } catch (err) {
    console.warn(`[Yahoo Finance] ${ticker}:`, err.message);
    results.error = err.message;
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
function scoreSignal({ rsi_now, rsi_prev, divergence, timeframe, signals, format }) {
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

  const total = conf + rsiPts + divPts + tfPts;
  const grade = total >= 80 ? 'A' : total >= 65 ? 'B' : total >= 50 ? 'C' : total >= 35 ? 'D' : 'F';
  const tier  = total >= 80 ? 'PREMIUM' : total >= 65 ? 'STRONG' : total >= 50 ? 'MODERATE' : total >= 35 ? 'WEAK' : 'NOISE';
  return { total, grade, tier, breakdown, divOpposes };
}


// ══════════════════════════════════════════════════════════════════════════
//  COMPOSITE SCORE — extends base 0-100 with dealer/market/timing context
//  Scores >100 = Grade S (all forces aligned)
//  Phase 1 item 7 — feeds Grade S detection in dashboard
// ══════════════════════════════════════════════════════════════════════════
function computeCompositeScore(baseScore, marketData, timeCtx, signals) {
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
    // Best windows: opening 30min or power hour
    if (timeCtx.phase.includes('OPENING') || timeCtx.phase.includes('POWER HOUR')) {
      bonus += 7; factors.push('Prime session window (+7)');
    } else if (timeCtx.phase.includes('EARLY SESSION') || timeCtx.phase.includes('MID-MORNING')) {
      bonus += 4; factors.push('Good session window (+4)');
    } else if (timeCtx.phase.includes('DEAD ZONE') || timeCtx.phase.includes('FINAL') || timeCtx.phase.includes('LAST')) {
      bonus -= 5; factors.push('Poor session window (-5)');
    }
    // Theta urgency penalty for 0DTE
    if (timeCtx.thetaUrgency === 'EXTREME') { bonus -= 3; factors.push('Extreme theta decay (-3)'); }
    if (timeCtx.thetaUrgency === 'CRITICAL') { bonus -= 8; factors.push('Critical theta decay (-8)'); }
  }

  const composite = baseScore + bonus;
  const isGradeS  = composite > 100;
  const grade =
    isGradeS          ? 'S' :
    composite >= 80   ? 'A' :
    composite >= 65   ? 'B' :
    composite >= 50   ? 'C' :
    composite >= 35   ? 'D' : 'F';

  return { composite, bonus, grade, isGradeS, factors };
}

// ══════════════════════════════════════════════════════════════════════════
//  ENGINE 2 — TRIPLE-BRAIN AI PROMPT
// ══════════════════════════════════════════════════════════════════════════
async function runTripleBrainAnalysis(payload, signals, quality, marketData, timeCtx, composite) {
  const { ticker, timeframe, price, high, low, barVolume,
          rsi_now, rsi_prev, divergence, context, liquidity,
          action, format, harsi_candle, harsi_prev } = payload;

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
  const vannaGreen = atmIV > 0 && atmIV <= 20 && (isBull ? true : true); // low IV = vanna neutral/helpful
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
Call Wall: ${opts.callWallAbove} | Put Wall: ${opts.putWallBelow}
Top GEX Strikes: ${opts.topGexStrikes}
P/C: ${opts.pcRatio} (${opts.pcContext}) | ATM IV: ${opts.atmIV} (${opts.ivContext})
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
${payload.htf_bias === 'bearish' && isBull ? '⚠ COUNTER-TREND: BUY signal vs bearish HTF cloud' : ''}
${payload.htf_bias === 'bullish' && !isBull && !isClose ? '⚠ COUNTER-TREND: SELL signal vs bullish HTF cloud' : ''}

SCORE
Base HRTC: ${quality.total}/100 (${quality.tier} ${quality.grade}) | Composite: ${composite.composite}/100 (Grade ${composite.grade})${composite.isGradeS ? ' 🌟 GRADE S — ALL FORCES ALIGNED' : ''}
Confluence: ${quality.breakdown.confluence.score}/35 | RSI: ${quality.breakdown.rsiStrength.score}/25 | Divergence: ${quality.breakdown.divergence.score}/20 | Timeframe: ${quality.breakdown.timeframe.score}/20
${composite.factors.length ? 'Composite factors: ' + composite.factors.join(', ') : ''}
${quality.divOpposes ? '⚠ DIVERGENCE OPPOSES SIGNAL — significant warning' : ''}
${composite.isGradeS ? '🌟 GRADE S: All dealer mechanics, market context, and technicals aligned simultaneously. Highest conviction setup.' : ''}

${marketSection}
${optionsSection}
${srSection}`;

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
    const composite = computeCompositeScore(quality.total, marketData, timeCtx, signals);
    const ai        = await runTripleBrainAnalysis(payload, signals, quality, marketData, timeCtx, composite);

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
