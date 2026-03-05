/**
 * GCM HRTC AI Brain — Triple Engine Server v4
 *
 * Engine 1 — HRTC Signal Quality Scorer (0–100)
 * Engine 2 — Liquidity Sandwich Order Flow
 * Engine 3 — Polygon.io Live Market Data
 *   → Volume vs average (Liquidity Vacuum detection)
 *   → Bid/ask spread (order book thinning)
 *   → VWAP positioning (institutional reference)
 *   → Block trade detection (dark pool proxy)
 *   → Pre/after market volume context
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
//  ENGINE 3 — POLYGON.IO LIVE MARKET DATA FETCHER
// ══════════════════════════════════════════════════════════════════════════
async function fetchPolygonData(ticker) {
  // Clean ticker — remove /USD, /USDT etc for stocks, keep as-is for crypto
  const isForex  = ticker.includes('/') && !ticker.includes('USD');
  const isCrypto = ticker.includes('BTC') || ticker.includes('ETH') ||
                   ticker.includes('SOL') || ticker.includes('XRP') ||
                   ticker.toUpperCase().endsWith('USD') || ticker.includes('/');

  // Normalise ticker for Polygon
  let polyTicker = ticker.replace('/', '').replace('-', '').toUpperCase();
  if (isCrypto) polyTicker = 'X:' + polyTicker.replace('USDT','USD');

  const results = {};

  try {
    // ── 1. Snapshot (last trade, bid/ask, today's volume) ──────────────────
    const snapUrl = isCrypto
      ? `https://api.polygon.io/v2/snapshot/locale/global/markets/crypto/tickers/${polyTicker}?apiKey=${POLYGON_API_KEY}`
      : `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${polyTicker}?apiKey=${POLYGON_API_KEY}`;

    const snapRes  = await fetch(snapUrl);
    const snapData = await snapRes.json();
    const snap     = snapData?.ticker || snapData?.results?.[0] || null;

    if (snap) {
      const day  = snap.day  || {};
      const prev = snap.prevDay || {};
      const last = snap.lastTrade || snap.lastQuote || {};
      const min  = snap.min || {};

      // Volume analysis
      const todayVol   = day.v  || 0;
      const prevVol    = prev.v || 0;
      const volRatio   = prevVol > 0 ? (todayVol / prevVol) : null;
      const volContext = volRatio === null ? 'N/A'
        : volRatio < 0.3  ? 'VERY LOW (liquidity vacuum risk)'
        : volRatio < 0.6  ? 'LOW (thin market)'
        : volRatio < 0.9  ? 'BELOW AVERAGE'
        : volRatio < 1.2  ? 'AVERAGE'
        : volRatio < 2.0  ? 'ABOVE AVERAGE'
        : 'HIGH VOLUME (institutional activity likely)';

      // Bid/ask spread analysis
      const bid    = snap.lastQuote?.P || snap.lastQuote?.bp || 0;
      const ask    = snap.lastQuote?.p || snap.lastQuote?.ap || 0;
      const spread = (bid && ask) ? ((ask - bid) / bid * 100).toFixed(4) : null;
      const spreadContext = !spread ? 'N/A'
        : parseFloat(spread) > 0.1  ? 'WIDE — order book thinning, low liquidity'
        : parseFloat(spread) > 0.05 ? 'MODERATE — normal market conditions'
        : 'TIGHT — deep order book, good liquidity';

      // VWAP positioning
      const vwap     = day.vw || null;
      const lastPrice = snap.lastTrade?.p || snap.day?.c || null;
      const vwapContext = (!vwap || !lastPrice) ? 'N/A'
        : lastPrice > vwap * 1.005 ? `ABOVE VWAP ($${vwap?.toFixed(2)}) — bullish institutional bias`
        : lastPrice < vwap * 0.995 ? `BELOW VWAP ($${vwap?.toFixed(2)}) — bearish institutional bias`
        : `AT VWAP ($${vwap?.toFixed(2)}) — decision zone`;

      // Price change context
      const priceChange = (lastPrice && prev.c) ? ((lastPrice - prev.c) / prev.c * 100).toFixed(2) : null;

      // Liquidity Vacuum detection: price moving but volume low
      const liqVacuum = (volRatio !== null && volRatio < 0.5 && priceChange && Math.abs(parseFloat(priceChange)) > 0.5)
        ? `⚠ LIQUIDITY VACUUM DETECTED — price moved ${priceChange}% on only ${(volRatio*100).toFixed(0)}% of normal volume. Move may not be sustained.`
        : null;

      results.snapshot = {
        lastPrice,
        todayVol:      todayVol.toLocaleString(),
        prevVol:       prevVol.toLocaleString(),
        volRatio:      volRatio ? (volRatio * 100).toFixed(0) + '% of yesterday' : 'N/A',
        volContext,
        bid:           bid || 'N/A',
        ask:           ask || 'N/A',
        spread:        spread ? spread + '%' : 'N/A',
        spreadContext,
        vwap:          vwap?.toFixed(2) || 'N/A',
        vwapContext,
        priceChange:   priceChange ? priceChange + '%' : 'N/A',
        liqVacuum,
        open:          day.o?.toFixed(2) || 'N/A',
        high:          day.h?.toFixed(2) || 'N/A',
        low:           day.l?.toFixed(2) || 'N/A',
      };
    }

    // ── 2. Recent trades — block trade / dark pool proxy ──────────────────
    // Large single trades relative to average = institutional block proxy
    if (!isCrypto) {
      const tradesUrl = `https://api.polygon.io/v3/trades/${polyTicker}?limit=50&apiKey=${POLYGON_API_KEY}`;
      const tradesRes  = await fetch(tradesUrl);
      const tradesData = await tradesRes.json();
      const trades     = tradesData?.results || [];

      if (trades.length > 0) {
        const sizes     = trades.map(t => t.size || 0);
        const avgSize   = sizes.reduce((a, b) => a + b, 0) / sizes.length;
        const maxSize   = Math.max(...sizes);
        const blockTrades = trades.filter(t => (t.size || 0) > avgSize * 5);

        results.trades = {
          avgTradeSize:   Math.round(avgSize).toLocaleString(),
          largestTrade:   maxSize.toLocaleString(),
          blockTradeCount: blockTrades.length,
          blockContext:   blockTrades.length > 3
            ? `⚠ ${blockTrades.length} BLOCK TRADES detected (5x+ avg size) — institutional activity likely`
            : blockTrades.length > 0
            ? `${blockTrades.length} large trade(s) detected — monitor for accumulation/distribution`
            : 'No significant block trades in last 50 trades — retail flow dominant',
        };
      }
    }

    // ── 3. Previous close + gap context ───────────────────────────────────
    if (results.snapshot?.priceChange) {
      const pct = parseFloat(results.snapshot.priceChange);
      results.gapContext = pct > 2  ? `GAP UP ${pct}% — institutions may fade this`
        : pct < -2 ? `GAP DOWN ${pct}% — watch for institutional support`
        : `No significant gap (${pct}%)`;
    }

  } catch (err) {
    console.warn(`[Polygon] Failed for ${ticker}:`, err.message);
    results.error = err.message;
  }

  return results;
}

// ══════════════════════════════════════════════════════════════════════════
//  ENGINE 1A — HRTC SIGNAL LOGIC
// ══════════════════════════════════════════════════════════════════════════
function computeSignals({ rsi_now, rsi_prev, harsi_candle, harsi_prev, divergence }) {
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
// ══════════════════════════════════════════════════════════════════════════
function scoreSignal({ rsi_now, rsi_prev, harsi_candle, harsi_prev, divergence, timeframe, signals }) {
  const rsiVal = parseFloat(rsi_now);
  const rsiAbs = Math.abs(rsiVal);
  const isBull = signals.overallBull;
  const breakdown = {};

  let conf = 0;
  const harsiFlip = signals.harsiBull || signals.harsiBear;
  const rsiFlip   = signals.rsiBull   || signals.rsiBear;
  const dirMatch  = (isBull && signals.rsiRising) || (!isBull && !signals.rsiRising);
  if (harsiFlip)            conf += 15;
  if (rsiFlip)              conf += 10;
  if (dirMatch)             conf += 5;
  if (harsiFlip && rsiFlip) conf += 5;
  breakdown.confluence = { score: conf, max: 35,
    items: [
      { label: 'HARSI candle flip',       pts: harsiFlip ? 15 : 0, hit: harsiFlip },
      { label: 'RSI zero-cross flip',     pts: rsiFlip   ? 10 : 0, hit: rsiFlip   },
      { label: 'RSI direction aligned',   pts: dirMatch  ? 5  : 0, hit: dirMatch  },
      { label: 'Dual confirmation bonus', pts: (harsiFlip && rsiFlip) ? 5 : 0, hit: harsiFlip && rsiFlip },
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
    items: [ !divergence || divergence === 'none'
      ? { label: 'No divergence', pts: 0, hit: false }
      : divConfirms
        ? { label: `${divergence} div confirms signal`, pts: 20, hit: true }
        : { label: `${divergence} div OPPOSES signal ⚠`, pts: 0, hit: false, warn: true }
    ]
  };

  const tfMap = {
    '1m':3,'2m':4,'3m':5,'5m':7,'10m':9,'15m':12,'30m':14,
    '45m':15,'1H':16,'2H':17,'3H':17,'4H':18,'6H':18,
    '8H':19,'12H':19,'1D':20,'3D':20,'1W':20,'1M':20
  };
  const tf    = (timeframe || '').replace('min','m').replace('hour','H').replace('day','D');
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
//  Framework A: HRTC signal evaluation
//  Framework B: Liquidity Sandwich
//  Framework C: Polygon live market data (volume, spread, VWAP, blocks)
//  Final:       Cross-referenced ACTIONABLE / WAIT / AVOID
// ══════════════════════════════════════════════════════════════════════════
async function runTripleBrainAnalysis(payload, signals, quality, marketData) {
  const { ticker, timeframe, price, rsi_now, rsi_prev,
          harsi_candle, harsi_prev, divergence, context } = payload;
  const isBull = signals.overallBull;
  const action = isBull ? 'BUY' : 'SELL';
  const rsiStd = (parseFloat(rsi_now) + 50).toFixed(1);

  const activeSignals = [
    signals.harsiBull ? 'HARSI Bull flip (primary)'  : '',
    signals.harsiBear ? 'HARSI Bear flip (primary)'  : '',
    signals.rsiBull   ? 'Fast Bull — RSI zero-cross' : '',
    signals.rsiBear   ? 'Fast Bear — RSI zero-cross' : '',
  ].filter(Boolean).join(', ') || 'Momentum continuation';

  // Format Polygon data for prompt
  const snap   = marketData?.snapshot;
  const trades = marketData?.trades;
  const marketSection = snap ? `
╔═══════════════════════════════════════╗
  LIVE MARKET DATA (Polygon.io)
╚═══════════════════════════════════════╝
Price:          $${snap.lastPrice || price}
Today's Range:  $${snap.low} – $${snap.high}  |  Open: $${snap.open}
Price Change:   ${snap.priceChange} vs yesterday  ${marketData.gapContext ? '→ ' + marketData.gapContext : ''}

VOLUME ANALYSIS:
Today's Volume: ${snap.todayVol} (${snap.volRatio})
Volume Context: ${snap.volContext}
${snap.liqVacuum ? snap.liqVacuum : '✓ No liquidity vacuum detected'}

ORDER BOOK:
Bid/Ask Spread: ${snap.spread} — ${snap.spreadContext}

VWAP:           ${snap.vwapContext}

${trades ? `BLOCK TRADE ANALYSIS:
Avg Trade Size: ${trades.avgTradeSize} shares
Largest Trade:  ${trades.largestTrade} shares
${trades.blockContext}` : ''}
` : `
╔═══════════════════════════════════════╗
  LIVE MARKET DATA
╚═══════════════════════════════════════╝
${marketData?.error ? 'Polygon data unavailable: ' + marketData.error : 'No market data retrieved'}
`;

  const prompt = `You are a triple-engine trading analyst. Run all three frameworks, then deliver a cross-referenced final verdict.

╔═══════════════════════════════════════╗
  SIGNAL INPUT
╚═══════════════════════════════════════╝
Ticker:     ${ticker}
Action:     ${action}
Price:      $${price || 'N/A'}
Timeframe:  ${timeframe}
RSI:        ${rsi_now} zero-centered (standard ~${rsiStd})
Prev RSI:   ${rsi_prev}
HARSI:      ${harsi_candle === 'bullish' ? '🟢 GREEN' : '🔴 RED'} (was: ${harsi_prev === 'bullish' ? '🟢 GREEN' : '🔴 RED'})
Divergence: ${divergence || 'none'}
Context:    ${context || 'Standard HRTC alert'}
Signals:    ${activeSignals}

╔═══════════════════════════════════════╗
  QUALITY SCORE: ${quality.total}/100 — ${quality.tier} (Grade ${quality.grade})
╚═══════════════════════════════════════╝
Confluence ${quality.breakdown.confluence.score}/35 | RSI Strength ${quality.breakdown.rsiStrength.score}/25 | Divergence ${quality.breakdown.divergence.score}/20 | Timeframe ${quality.breakdown.timeframe.score}/20
${quality.divOpposes ? '⚠ DIVERGENCE OPPOSES SIGNAL' : ''}
${marketSection}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FRAMEWORK A — HRTC SIGNAL EVALUATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Evaluate the HRTC reading for this ${action}:
- Is RSI momentum (${rsi_now} zero-centered) strong enough?
- Does the HARSI flip carry conviction or is it a weak wiggle?
- What does ${quality.total}/100 mean for position confidence?

HRTC VERDICT: [1–2 sentences referencing actual values]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FRAMEWORK B — LIQUIDITY SANDWICH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are an institutional Order Flow Analyst.

THE TAPE:
1. ABSORPTION ZONE: Nearest psychological level to $${price}? Is price approaching, at, or extended from it?
2. VALUE BUYERS/SELLERS: Is $${price} at value or extended/chasing?
3. THE RISK: Why might institutions wait? What stop-hunt could occur first?

LIQUIDITY VERDICT: [BUY / SELL / HOLD — one sentence]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FRAMEWORK C — MARKET MICROSTRUCTURE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Using the Polygon live data above, analyze:

1. VOLUME CONVICTION: Is this signal backed by real volume or a liquidity vacuum move?
   ${snap?.liqVacuum ? '→ LIQUIDITY VACUUM ALREADY FLAGGED — price moved on thin volume' : '→ Assess volume vs historical context'}

2. ORDER BOOK HEALTH: What does the bid/ask spread tell us about market depth right now?
   ${snap?.spreadContext ? '→ ' + snap.spreadContext : ''}

3. INSTITUTIONAL POSITIONING: Is price above or below VWAP? What does that mean for smart money bias?
   ${snap?.vwapContext ? '→ ' + snap.vwapContext : ''}

4. DARK POOL PROXY: Based on block trade data, is there evidence of institutional accumulation or distribution?
   ${trades?.blockContext ? '→ ' + trades.blockContext : '→ No block trade data available'}

MICROSTRUCTURE VERDICT: [CONFIRMS / CONFLICTS / NEUTRAL — one sentence]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FINAL CROSS-REFERENCED VERDICT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
All three frameworks must broadly agree for ACTIONABLE.

DECISION: [ACTIONABLE / WAIT / AVOID]
REASON: [One sentence — how do all three frameworks align or conflict?]
ENTRY CONDITION: [Exact trigger — or "wait for X"]
INVALIDATION: [What cancels this setup]
POSITION SIZING: [FULL / REDUCED / SKIP]

Rules:
- ACTIONABLE → Score ≥65 AND liquidity aligns AND microstructure confirms AND no liq vacuum
- WAIT       → Score 40–64 OR near absorption zone OR microstructure neutral OR low volume
- AVOID      → Score <40 OR liq vacuum detected OR divergence opposes OR frameworks conflict`;

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
  res.json({ status: 'GCM HRTC Triple Brain online', clients: clients.size, signals: signalHistory.length }));

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
  const body = req.body;
  if (body.secret !== WEBHOOK_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  console.log(`[Webhook] ${body.ticker} ${body.timeframe} @ $${body.price}`);
  res.json({ received: true });

  broadcast({ type: 'processing', ticker: body.ticker, timeframe: body.timeframe, ts: Date.now() });

  try {
    // Run signal scoring and Polygon data fetch in parallel
    const signals    = computeSignals(body);
    const quality    = scoreSignal({ ...body, signals });
    const marketData = await fetchPolygonData(body.ticker);

    console.log(`[Polygon] ${body.ticker} — Vol: ${marketData?.snapshot?.volRatio || 'N/A'} | Spread: ${marketData?.snapshot?.spread || 'N/A'} | VWAP: ${marketData?.snapshot?.vwap || 'N/A'}`);

    const ai = await runTripleBrainAnalysis(body, signals, quality, marketData);

    const record = {
      type: 'signal',
      id: Date.now(),
      ticker:       body.ticker     || '—',
      timeframe:    body.timeframe  || '—',
      price:        body.price      || null,
      rsi_now:      parseFloat(body.rsi_now),
      rsi_prev:     parseFloat(body.rsi_prev),
      harsi_candle: body.harsi_candle,
      harsi_prev:   body.harsi_prev,
      divergence:   body.divergence || 'none',
      context:      body.context    || '',
      signals,
      quality,
      marketData,
      analysis: ai.text,
      verdict:  ai.verdict,
      sizing:   ai.sizing,
      ts: Date.now()
    };

    signalHistory.unshift(record);
    if (signalHistory.length > 50) signalHistory.pop();
    broadcast(record);

    console.log(`[Done] ${body.ticker} | ${quality.total}/100 ${quality.tier} | ${ai.verdict} | ${ai.sizing}`);
  } catch (err) {
    console.error('[Error]', err.message);
    broadcast({ type: 'error', message: err.message, ts: Date.now() });
  }
});

app.listen(PORT, () => console.log(`GCM HRTC Triple Brain listening on port ${PORT}`));
