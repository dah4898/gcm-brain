/**
 * GCM HRTC AI Brain — Dual Engine Server v3
 *
 * Engine 1 — HRTC Signal Quality Scorer (0–100)
 *   Confluence 35pts | RSI Strength 25pts | Divergence 20pts | Timeframe 20pts
 *
 * Engine 2 — Liquidity Sandwich Order Flow Analyst
 *   Absorption zones | Value buyers/sellers | Institutional risk
 *
 * Final verdict = cross-referenced ACTIONABLE / WAIT / AVOID
 */

const express = require('express');
const cors    = require('cors');
const app     = express();

app.use(cors());
app.use(express.json());

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET    || 'gcm-secret-change-me';
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
//  ENGINE 1A — HRTC SIGNAL LOGIC  (Pine Script replica)
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
//  ENGINE 1B — SIGNAL QUALITY SCORER  (0–100)
// ══════════════════════════════════════════════════════════════════════════
function scoreSignal({ rsi_now, rsi_prev, harsi_candle, harsi_prev, divergence, timeframe, signals }) {
  const rsiVal = parseFloat(rsi_now);
  const rsiAbs = Math.abs(rsiVal);
  const isBull = signals.overallBull;
  const breakdown = {};

  // Factor 1 — Confluence (35 pts)
  let conf = 0;
  const harsiFlip = signals.harsiBull || signals.harsiBear;
  const rsiFlip   = signals.rsiBull   || signals.rsiBear;
  const dirMatch  = (isBull && signals.rsiRising) || (!isBull && !signals.rsiRising);
  if (harsiFlip)            conf += 15;
  if (rsiFlip)              conf += 10;
  if (dirMatch)             conf += 5;
  if (harsiFlip && rsiFlip) conf += 5;
  breakdown.confluence = {
    score: conf, max: 35,
    items: [
      { label: 'HARSI candle flip',       pts: harsiFlip ? 15 : 0, hit: harsiFlip },
      { label: 'RSI zero-cross flip',     pts: rsiFlip   ? 10 : 0, hit: rsiFlip   },
      { label: 'RSI direction aligned',   pts: dirMatch  ? 5  : 0, hit: dirMatch  },
      { label: 'Dual confirmation bonus', pts: (harsiFlip && rsiFlip) ? 5 : 0, hit: harsiFlip && rsiFlip },
    ]
  };

  // Factor 2 — RSI Strength & Momentum (25 pts)
  let rsiPts = rsiAbs >= 25 ? 22 : rsiAbs >= 15 ? 17 : rsiAbs >= 5 ? 11 : 4;
  const delta  = Math.abs(rsiVal - parseFloat(rsi_prev));
  const mBonus = delta >= 5 ? 3 : delta >= 2 ? 1 : 0;
  rsiPts = Math.min(25, rsiPts + mBonus);
  const strength = rsiAbs >= 25 ? 'Very Strong' : rsiAbs >= 15 ? 'Strong' : rsiAbs >= 5 ? 'Medium' : 'Weak';
  breakdown.rsiStrength = {
    score: rsiPts, max: 25,
    items: [
      { label: `Momentum ${strength} (|RSI| = ${rsiAbs.toFixed(1)})`, pts: rsiPts - mBonus, hit: true },
      { label: `Acceleration bonus (Δ${delta.toFixed(1)})`,           pts: mBonus,          hit: mBonus > 0 },
    ]
  };

  // Factor 3 — Divergence (20 pts)
  const divConfirms = (divergence === 'bull' && isBull) || (divergence === 'bear' && !isBull);
  const divOpposes  = (divergence === 'bull' && !isBull) || (divergence === 'bear' && isBull);
  const divPts      = divConfirms ? 20 : 0;
  breakdown.divergence = {
    score: divPts, max: 20, warning: divOpposes,
    items: [ !divergence || divergence === 'none'
      ? { label: 'No divergence', pts: 0, hit: false }
      : divConfirms
        ? { label: `${divergence} div confirms signal`, pts: 20, hit: true }
        : { label: `${divergence} div OPPOSES signal ⚠`, pts: 0, hit: false, warn: true }
    ]
  };

  // Factor 4 — Timeframe Weight (20 pts)
  const tfMap = {
    '1m':3,'2m':4,'3m':5,'5m':7,'10m':9,'15m':12,'30m':14,
    '45m':15,'1H':16,'2H':17,'3H':17,'4H':18,'6H':18,
    '8H':19,'12H':19,'1D':20,'3D':20,'1W':20,'1M':20
  };
  const tf    = (timeframe || '').replace('min','m').replace('hour','H').replace('day','D');
  const tfPts = tfMap[tf] || tfMap[timeframe] || 10;
  const tfLbl = tfPts >= 18 ? 'High (daily+)' : tfPts >= 14 ? 'Medium-High' : tfPts >= 10 ? 'Medium' : 'Low (noisy)';
  breakdown.timeframe = {
    score: tfPts, max: 20,
    items: [{ label: `${timeframe} — ${tfLbl}`, pts: tfPts, hit: tfPts >= 12 }]
  };

  const total = conf + rsiPts + divPts + tfPts;
  const grade = total >= 80 ? 'A' : total >= 65 ? 'B' : total >= 50 ? 'C' : total >= 35 ? 'D' : 'F';
  const tier  = total >= 80 ? 'PREMIUM' : total >= 65 ? 'STRONG' : total >= 50 ? 'MODERATE' : total >= 35 ? 'WEAK' : 'NOISE';

  return { total, grade, tier, breakdown, divOpposes };
}

// ══════════════════════════════════════════════════════════════════════════
//  ENGINE 2 — DUAL-BRAIN AI PROMPT
//  Section A: HRTC signal quality narrative
//  Section B: Liquidity Sandwich order flow (your original framework)
//  Section C: Cross-reference → ACTIONABLE / WAIT / AVOID verdict
// ══════════════════════════════════════════════════════════════════════════
async function runDualBrainAnalysis(payload, signals, quality) {
  const { ticker, timeframe, price, rsi_now, rsi_prev,
          harsi_candle, harsi_prev, divergence, context } = payload;
  const isBull  = signals.overallBull;
  const action  = isBull ? 'BUY' : 'SELL';
  const rsiStd  = (parseFloat(rsi_now) + 50).toFixed(1);

  const activeSignals = [
    signals.harsiBull ? 'HARSI Bull flip (primary)'   : '',
    signals.harsiBear ? 'HARSI Bear flip (primary)'   : '',
    signals.rsiBull   ? 'Fast Bull — RSI zero-cross'  : '',
    signals.rsiBear   ? 'Fast Bear — RSI zero-cross'  : '',
  ].filter(Boolean).join(', ') || 'Momentum continuation (no flip)';

  const prompt = `You are a dual-engine trading analyst. Run both frameworks below on this signal, then cross-reference for a final actionable verdict.

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
${quality.divOpposes ? '⚠ DIVERGENCE OPPOSES SIGNAL — flag this' : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FRAMEWORK A — HRTC SIGNAL EVALUATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Evaluate the GCM HRTC indicator reading for this ${action}:
- Is RSI momentum (${rsi_now} zero-centered) strong enough to trust this signal?
- Does the HARSI candle flip carry real conviction or is it a weak edge-of-range wiggle?
- What does the quality score of ${quality.total}/100 mean for position confidence?

HRTC VERDICT: [1–2 direct sentences referencing the actual values]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FRAMEWORK B — LIQUIDITY SANDWICH (ORDER FLOW)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You are now an institutional Order Flow Analyst specializing in Liquidity Discovery.
Analyze the Liquidity Sandwich for this ${action} at $${price}:

THE TAPE:
1. ABSORPTION ZONE: What is the nearest psychological whole number or .50 level to $${price}? Is price currently approaching, sitting at, or extended away from that cluster?
2. VALUE BUYERS/SELLERS: Is $${price} in a zone of value (near recent range lows for buys, highs for sells) — or is price extended and chasing momentum?
3. THE RISK: Why might institutions be waiting rather than acting here? What liquidity trap or stop-hunt could occur before the real move?

LIQUIDITY VERDICT: [BUY / SELL / HOLD — one sentence]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FINAL CROSS-REFERENCED VERDICT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Reconcile both frameworks. They must broadly agree for ACTIONABLE.

DECISION: [ACTIONABLE / WAIT / AVOID]
REASON: [One sentence — does liquidity confirm or conflict with HRTC?]
ENTRY CONDITION: [Exact trigger needed — or "wait for X before entering"]
INVALIDATION: [What price action cancels this setup]
POSITION SIZING: [FULL / REDUCED / SKIP]

Scoring rules for DECISION:
- ACTIONABLE → Score ≥65 AND liquidity aligns AND no opposing divergence
- WAIT       → Score 40–64 OR liquidity near absorption zone OR one framework neutral
- AVOID      → Score <40 OR divergence opposes OR both frameworks conflict`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1400,
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
  res.json({ status: 'GCM HRTC Dual Brain online', clients: clients.size, signals: signalHistory.length }));

app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  clients.add(res);
  console.log(`[SSE] +1 client (${clients.size} total)`);
  res.write(`data: ${JSON.stringify({ type: 'history', signals: signalHistory })}\n\n`);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
  req.on('close', () => { clearInterval(ping); clients.delete(res); });
});

app.get('/history', (req, res) => res.json(signalHistory));

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.secret !== WEBHOOK_SECRET) {
    console.warn('[Webhook] Unauthorized');
    return res.status(401).json({ error: 'Unauthorized' });
  }
  console.log(`[Webhook] ${body.ticker} ${body.timeframe} @ $${body.price}`);
  res.json({ received: true }); // fast ACK to TradingView

  broadcast({ type: 'processing', ticker: body.ticker, timeframe: body.timeframe, ts: Date.now() });

  try {
    const signals = computeSignals(body);
    const quality = scoreSignal({ ...body, signals });
    const ai      = await runDualBrainAnalysis(body, signals, quality);

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

app.listen(PORT, () => console.log(`GCM HRTC Dual Brain listening on port ${PORT}`));
