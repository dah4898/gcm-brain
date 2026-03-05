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
const POLYGON_API_KEY   = process.env.POLYGON_API_KEY   || '';
const PORT              = process.env.PORT              || 3000;

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
  // New format from GCM HRTC Strategy
  if (body.action) {
    const isBull = body.action === 'buy';
    const isBear = body.action === 'sell';
    return {
      ticker:       body.ticker,
      timeframe:    body.timeframe || '—',
      price:        parseFloat(body.price),
      high:         parseFloat(body.high)   || null,
      low:          parseFloat(body.low)    || null,
      barVolume:    parseFloat(body.volume) || null,
      action:       body.action,
      context:      body.context   || '',
      liquidity:    body.liquidity || '',
      // Map to internal signal format
      harsi_candle: isBull ? 'bullish' : 'bearish',
      harsi_prev:   isBull ? 'bearish' : 'bullish',
      rsi_now:      isBull ? 4  : -4,
      rsi_prev:     isBull ? -2 : 2,
      divergence:   'none',
      isClose:      body.action === 'close',
      format:       'v5'
    };
  }
  // Legacy format — pass through unchanged
  return { ...body, format: 'legacy' };
}

// ══════════════════════════════════════════════════════════════════════════
//  ENGINE 3 — POLYGON.IO LIVE MARKET DATA
// ══════════════════════════════════════════════════════════════════════════
async function fetchPolygonData(ticker) {
  const isCrypto = ['BTC','ETH','SOL','XRP','BNB','DOGE','ADA'].some(c => ticker.includes(c))
                || ticker.includes('/');

  let polyTicker = ticker.replace('/', '').replace('-','').toUpperCase();
  if (isCrypto) polyTicker = 'X:' + polyTicker.replace('USDT','USD');

  const results = {};

  try {
    // Snapshot
    const snapUrl = isCrypto
      ? `https://api.polygon.io/v2/snapshot/locale/global/markets/crypto/tickers/${polyTicker}?apiKey=${POLYGON_API_KEY}`
      : `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${polyTicker}?apiKey=${POLYGON_API_KEY}`;

    const snapRes  = await fetch(snapUrl);
    const snapData = await snapRes.json();
    const snap     = snapData?.ticker || snapData?.results?.[0] || null;

    if (snap) {
      const day  = snap.day     || {};
      const prev = snap.prevDay || {};

      const todayVol = day.v  || 0;
      const prevVol  = prev.v || 0;
      const volRatio = prevVol > 0 ? todayVol / prevVol : null;
      const volContext = volRatio === null ? 'N/A'
        : volRatio < 0.3  ? 'VERY LOW — strong liquidity vacuum risk'
        : volRatio < 0.6  ? 'LOW — thin market, move may not sustain'
        : volRatio < 0.9  ? 'BELOW AVERAGE'
        : volRatio < 1.2  ? 'AVERAGE'
        : volRatio < 2.0  ? 'ABOVE AVERAGE — conviction present'
        : 'HIGH — institutional activity likely';

      const bid    = snap.lastQuote?.P || snap.lastQuote?.bp || 0;
      const ask    = snap.lastQuote?.p || snap.lastQuote?.ap || 0;
      const spread = (bid && ask) ? ((ask - bid) / bid * 100).toFixed(4) : null;
      const spreadContext = !spread ? 'N/A'
        : parseFloat(spread) > 0.1  ? 'WIDE — order book thinning, low depth'
        : parseFloat(spread) > 0.05 ? 'MODERATE — normal conditions'
        : 'TIGHT — deep order book, healthy liquidity';

      const vwap      = day.vw || null;
      const lastPrice = snap.lastTrade?.p || day.c || null;
      const vwapContext = (!vwap || !lastPrice) ? 'N/A'
        : lastPrice > vwap * 1.005 ? `ABOVE VWAP $${vwap?.toFixed(2)} — bullish institutional bias`
        : lastPrice < vwap * 0.995 ? `BELOW VWAP $${vwap?.toFixed(2)} — bearish institutional bias`
        : `AT VWAP $${vwap?.toFixed(2)} — key decision zone`;

      const priceChange = (lastPrice && prev.c)
        ? ((lastPrice - prev.c) / prev.c * 100).toFixed(2) : null;

      const liqVacuum = (volRatio !== null && volRatio < 0.5
        && priceChange && Math.abs(parseFloat(priceChange)) > 0.5)
        ? `⚠ LIQUIDITY VACUUM — price moved ${priceChange}% on ${(volRatio*100).toFixed(0)}% of normal volume`
        : null;

      results.snapshot = {
        lastPrice, vwap: vwap?.toFixed(2),
        todayVol: todayVol.toLocaleString(),
        prevVol:  prevVol.toLocaleString(),
        volRatio: volRatio ? (volRatio*100).toFixed(0)+'% of yesterday' : 'N/A',
        volContext, spreadContext, vwapContext,
        spread: spread ? spread+'%' : 'N/A',
        bid: bid || 'N/A', ask: ask || 'N/A',
        priceChange: priceChange ? priceChange+'%' : 'N/A',
        open:  day.o?.toFixed(2) || 'N/A',
        high:  day.h?.toFixed(2) || 'N/A',
        low:   day.l?.toFixed(2) || 'N/A',
        liqVacuum,
      };

      results.gapContext = priceChange
        ? parseFloat(priceChange) > 2  ? `GAP UP ${priceChange}% — institutions may fade`
        : parseFloat(priceChange) < -2 ? `GAP DOWN ${priceChange}% — watch for support`
        : `No significant gap (${priceChange}%)`
        : null;
    }

    // Block trade scan (stocks only)
    if (!isCrypto) {
      const tRes  = await fetch(`https://api.polygon.io/v3/trades/${polyTicker}?limit=50&apiKey=${POLYGON_API_KEY}`);
      const tData = await tRes.json();
      const trades = tData?.results || [];
      if (trades.length > 0) {
        const sizes  = trades.map(t => t.size || 0);
        const avg    = sizes.reduce((a,b) => a+b, 0) / sizes.length;
        const blocks = trades.filter(t => (t.size||0) > avg * 5);
        results.trades = {
          avgTradeSize:    Math.round(avg).toLocaleString(),
          largestTrade:    Math.max(...sizes).toLocaleString(),
          blockTradeCount: blocks.length,
          blockContext: blocks.length > 3
            ? `⚠ ${blocks.length} BLOCK TRADES detected — institutional activity`
            : blocks.length > 0
            ? `${blocks.length} large trade(s) — monitor for accumulation/distribution`
            : 'No significant block trades — retail flow dominant',
        };
      }
    }
  } catch (err) {
    console.warn(`[Polygon] ${ticker}:`, err.message);
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
//  ENGINE 2 — TRIPLE-BRAIN AI PROMPT
// ══════════════════════════════════════════════════════════════════════════
async function runTripleBrainAnalysis(payload, signals, quality, marketData) {
  const { ticker, timeframe, price, high, low, barVolume,
          rsi_now, rsi_prev, divergence, context, liquidity,
          action, format } = payload;

  const isBull     = signals.overallBull;
  const isClose    = action === 'close';
  const actionLabel = isClose ? 'EXIT/CLOSE' : isBull ? 'BUY' : 'SELL';
  const rsiStd     = (parseFloat(rsi_now) + 50).toFixed(1);
  const isStrategy = format === 'v5';
  const snap       = marketData?.snapshot;
  const trades     = marketData?.trades;

  // Bar range context
  const barRange = (high && low) ? `$${low} – $${high} (range: $${(high-low).toFixed(2)})` : 'N/A';
  const barVolCtx = barVolume
    ? `${parseInt(barVolume).toLocaleString()} (this bar)`
    : 'N/A';

  const marketSection = snap ? `
╔═══════════════════════════════════════╗
  LIVE MARKET DATA (Polygon.io)
╚═══════════════════════════════════════╝
Last Price:     $${snap.lastPrice || price}
Today's Range:  $${snap.low} – $${snap.high}  |  Open: $${snap.open}
Bar Range:      ${barRange}
Bar Volume:     ${barVolCtx}
Price Change:   ${snap.priceChange} vs yesterday  ${marketData.gapContext ? '→ ' + marketData.gapContext : ''}

VOLUME:
Daily Volume:   ${snap.todayVol} (${snap.volRatio})
Assessment:     ${snap.volContext}
${snap.liqVacuum ? snap.liqVacuum : '✓ No liquidity vacuum detected'}

ORDER BOOK:
Bid/Ask Spread: ${snap.spread} — ${snap.spreadContext}

VWAP:           ${snap.vwapContext}

${trades ? `BLOCK TRADES (last 50):
Avg Trade Size: ${trades.avgTradeSize}
Largest Trade:  ${trades.largestTrade}
${trades.blockContext}` : ''}
` : `Market data unavailable${marketData?.error ? ': ' + marketData.error : ''}`;

  // Detect asset type for QQQ-specific reasoning
  const isQQQ    = (ticker||'').toUpperCase() === 'QQQ' || (ticker||'').toUpperCase().includes('QQQ');
  const isCrypto = ['BTC','ETH','SOL','XRP'].some(c => (ticker||'').toUpperCase().includes(c));
  const assetType = isQQQ ? 'QQQ (Nasdaq-100 ETF)' : isCrypto ? 'Crypto' : 'Equity/ETF';

  const assetContext = isQQQ ? `
ASSET CONTEXT — QQQ (Nasdaq-100 ETF):
- Market hours 9:30am–4:00pm EST only. Best signals in opening hour and power hour (3–4pm).
- Avoid the 12:00–2:00pm dead zone — thin liquidity, unreliable reversals.
- Key psychological levels are whole dollars ($480, $485, $490, $500) and half dollars ($482.50 etc).
- VWAP is the primary institutional execution benchmark for QQQ. Above VWAP = bull bias, below = bear bias.
- Dark pool block prints on QQQ are highly significant — large ETF blocks often precede moves by 15–30 min.
- QQQ options create gamma walls at round dollar strikes. These act as magnets AND hard resistance/support.
- SPY/QQQ correlation is tight — a signal conflicting with SPY macro direction is lower conviction.
- Opening range breakout (first 30 min high/low) is a key institutional reference level for the session.
` : isCrypto ? `
ASSET CONTEXT — Crypto (24/7 market):
- No market hours — low-liquidity overnight sessions produce unreliable signals.
- Key psychological levels are large round numbers ($100K, $95K, $90K for BTC).
- Block trade data not available via Polygon for crypto.
` : `
ASSET CONTEXT — Equity/ETF:
- Market hours 9:30am–4:00pm EST.
- Respect whole dollar and 50-cent psychological levels.
- VWAP is the primary institutional benchmark.
`;

  const prompt = `You are a triple-engine trading analyst specializing in ${assetType}. A signal just fired from the GCM Heikin Ashi RSI Trend Cloud strategy. Run all three frameworks then deliver a final verdict.
${assetContext}

╔═══════════════════════════════════════╗
  SIGNAL INPUT
╚═══════════════════════════════════════╝
Ticker:         ${ticker}
Action:         ${actionLabel}
Price:          $${price}
Bar Range:      ${barRange}
Bar Volume:     ${barVolCtx}
Timeframe:      ${timeframe}
RSI (0-centered): ${rsi_now} (std: ~${rsiStd})  |  Prev: ${rsi_prev}
Divergence:     ${divergence || 'none'}
Signal Context: ${context}
Liquidity Tag:  ${liquidity || 'N/A'}
${isStrategy ? '✅ Strategy-grade signal: HTF confirmation + momentum filter + OB/OS filter all passed before this fired' : ''}

╔═══════════════════════════════════════╗
  QUALITY SCORE: ${quality.total}/100 — ${quality.tier} (${quality.grade})
╚═══════════════════════════════════════╝
Confluence ${quality.breakdown.confluence.score}/35 | RSI ${quality.breakdown.rsiStrength.score}/25 | Divergence ${quality.breakdown.divergence.score}/20 | Timeframe ${quality.breakdown.timeframe.score}/20
${quality.divOpposes ? '⚠ DIVERGENCE OPPOSES SIGNAL' : ''}
${marketSection}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FRAMEWORK A — HRTC SIGNAL EVALUATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${isClose
  ? `This is an EXIT signal. Evaluate whether closing the position now is the right call based on RSI momentum and current market structure.`
  : `Evaluate this ${actionLabel} signal from the GCM HRTC strategy:
- The strategy already passed HTF cloud confirmation, RSI momentum filter (min delta), and optional OB/OS zone filter
- Is RSI momentum at ${rsi_now} zero-centered strong enough to trust this entry?
- What does the quality score of ${quality.total}/100 say about conviction?`}

HRTC VERDICT: [1–2 sentences]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FRAMEWORK B — LIQUIDITY SANDWICH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The indicator already tagged this signal as: "${liquidity || context}"
Use that as context alongside your own analysis.

THE TAPE:
1. ABSORPTION ZONE: Nearest psychological level to $${price}? Approaching, at, or extended?
2. VALUE BUYERS/SELLERS: Is $${price} at value or is this a chase entry?
3. THE RISK: What stop-hunt or liquidity trap could occur before the real move?

LIQUIDITY VERDICT: [BUY / SELL / HOLD — one sentence]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FRAMEWORK C — MARKET MICROSTRUCTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Using Polygon live data:

1. VOLUME CONVICTION: Is this move backed by real volume or a liquidity vacuum?
   ${snap?.liqVacuum || '→ Assess volume context above'}

2. ORDER BOOK HEALTH: Bid/ask spread signals?
   ${snap?.spreadContext ? '→ ' + snap.spreadContext : '→ N/A'}

3. VWAP BIAS: Institutional positioning?
   ${snap?.vwapContext ? '→ ' + snap.vwapContext : '→ N/A'}

4. DARK POOL PROXY: Block trade evidence?
   ${trades?.blockContext ? '→ ' + trades.blockContext : isQQQ ? '→ No block trades detected in last 50 trades' : '→ Block trade scan not available for crypto'}

MICROSTRUCTURE VERDICT: [CONFIRMS / CONFLICTS / NEUTRAL]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FINAL CROSS-REFERENCED VERDICT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DECISION: [ACTIONABLE / WAIT / AVOID]
REASON: [One sentence — do all three frameworks agree?]
ENTRY CONDITION: [Exact trigger or "enter now at market"]
INVALIDATION: [What cancels this setup]
POSITION SIZING: [FULL / REDUCED / SKIP]

Rules:
- ACTIONABLE → Score ≥65 AND liquidity aligns AND microstructure confirms AND no liq vacuum
- WAIT       → Score 40–64 OR near absorption zone OR microstructure neutral
- AVOID      → Score <40 OR liq vacuum detected OR frameworks conflict`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1600,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  const text = data.content?.map(b => b.text || '').join('') || '';

  const verdictMatch = text.match(/DECISION:\s*(ACTIONABLE|WAIT|AVOID)/i);
  const sizeMatch    = text.match(/POSITION SIZING:\s*(FULL|REDUCED|SKIP)/i);
  const verdict      = verdictMatch ? verdictMatch[1].toUpperCase() : 'WAIT';
  const sizing       = sizeMatch    ? sizeMatch[1].toUpperCase()    : 'REDUCED';

  return { text, verdict, sizing };
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
    const marketData = await fetchPolygonData(payload.ticker);

    console.log(`[Polygon] Vol: ${marketData?.snapshot?.volRatio||'N/A'} | Spread: ${marketData?.snapshot?.spread||'N/A'} | VWAP: ${marketData?.snapshot?.vwap||'N/A'}`);

    const ai = await runTripleBrainAnalysis(payload, signals, quality, marketData);

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
