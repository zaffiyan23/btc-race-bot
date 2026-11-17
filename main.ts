// Three-sleeve long-only bot for cbBTC on 1-minute bars (agent-fun/bars-replay/v1),
// with a direction-wait layer (v6) on top of the v5 sleeves.
//
// v5 design note — built LIVE-first, not dev-fitted. The previous bot (v4)
// was calibrated to one frozen day: fixed-bps thrusts that fired twice in
// 24 h. On an unseen day that shape has two failure modes: it can sit out
// entirely (no thrust clears a fixed bar), and its thresholds mean nothing
// when the tape's own noise level differs. So every threshold here is a
// multiple of the tape's own recent realised volatility (the standard
// deviation of trailing momentum samples), with wide absolute clamps as
// sanity rails. Three sleeves share one position slot:
//
//   T (thrust):  rides violent impulses, the only moves that reliably pay
//                the ~26 bps full-size round-trip cost. Fires rarely by
//                design, but its trigger is vol-scaled, so "rare" tracks
//                the tape instead of one day's bps.
//   P (participate): keeps the bot engaged in slow grinds that never
//                produce a 15-minute thrust (a rising-EMA trend sleeve at
//                modest size). Exits need a confirmed trend break, so a
//                genuine strong uptrend is not abandoned at the first stall.
//   R (reversion): small, tight pulses buying sharp dips in tapes that are
//                not in a waterfall (a long-horizon momentum guard disables
//                it into a real leg down). This is the sleeve that keeps
//                the bot trading in pinned chop instead of bleeding on
//                thrust-chases; its stop is mechanical and small.
//
// v6 direction layer (owner order: "wait for the price to show its
// direction first, then trade"). The sleeves above no longer run from the
// first bar. The bot opens in OBS: for OBS_BARS scored bars it places no
// trades and only reads the tape. It then classifies the day so far as UP,
// DOWN or RANGE from the sigma-normalised net displacement over the
// observation window, and re-reads the direction every RECHECK_BARS bars
// and immediately whenever price breaks decisively (in sigma terms) out
// of the trailing range — a breakout IS the price showing its direction,
// so the break itself flips the read. Sleeves are armed per regime:
//
//   UP:    T, P and R run as in v5.
//   DOWN:  long-only cannot short a revealed downtrend, so T and P are off
//          and capital preservation rules; R may only take extra-strict,
//          half-size probes into extreme decelerating dips.
//   RANGE: T and P are off (thrust-chasing a pin is fee bleed); only small
//          range-edge reversion trades run — buy the lower edge of the
//          established range once the dip stabilises, exit at mid-range.
//
// Exits are never gated by the regime: a position opened under one read is
// still guarded by its sleeve's exits after the read flips.
//
// Risk: each sleeve's size x stop distance is capped well under 1% of the
// starting equity, invalidation is mechanical, and after any exit a
// cooldown keeps chop from re-arming the bot instantly.
//
// Event caution: two scheduled US prints sit inside the race window
// (retail sales ~bar 72, NVIDIA earnings ~bar 542). Around those bars the
// bleed-prone sleeves (P and R) take no fresh entries for a few dozen bars
// — buying a dip into a print is how a pulse bot catches a falling knife.
// The thrust sleeve is exempt: post-print impulses are exactly its trade.
// Bar index is bar-derived state, like v4's late cutoff.
//
// v3 (this build): a fifth sleeve, L (level-dip), joins T/P/R/W2. It is a
// faithful but self-anchored adaptation of the pattern that WON the
// previous race (btc-race-24h-20261115-0828): @srihandayani's "buy the dip
// below 65,000 (64,000) — hold up to 20 hours" finished final #1 despite a
// dev rank of #2,624/2,840, while the dev top-5 fitted schedules collapsed
// to final #1,300s. The pattern: patient buying at key dip levels, then a
// long hold. L anchors its levels to the tape itself instead of copying
// absolute prices: at the end of the observation phase it freezes
// REF = the close at that moment, and two zones below it, sigma60-scaled
// with absolute floors — Z1 = REF x (1 - max(1.5%, 3 x sigma60)) and
// Z2 = REF x (1 - max(2.8%, 5 x sigma60)). A close at/below Z1 buys at
// 40% size; the exits are the winner's shape, not the pulse sleeves':
// bank when price recovers to REF x (1 - 0.3%), otherwise hold up to
// 900 bars, protected only by a hard stop (the tighter of 1.2% below Z2
// and -4.5% from the entry close). Inside the event blackout windows L
// may not open at Z1, but MAY open at Z2 — buying the event flush is the
// winner's whole point, and the deep zone is the compensation. Max 2 L
// trades per window, no new L entries in the last 240 bars, priority
// below T/P/R and above W2. L is a level strategy, not a trend strategy,
// so it ships with no regime gate — the battery showed down-day bleeding,
// but every candidate gate was tried and rejected on the same battery
// (each either admits the losers or vetoes the winners; the evidence is
// in the build log). The hard stop is its only protection.
//
// Hybrid v2: a fourth sleeve, W2 (washout), joins T/P/R. The
// first hybrid test bolted the standalone washout-C rules onto v7 at 15%
// size, lowest priority, armed in EVERY regime — dev rose to +$8.65, but
// the 33-day battery got WORSE than v7 (-$3.76 vs -$3.27/day), the damage
// concentrated on down days (-$3.67 vs -$2.36): a regime-blind dip sleeve
// re-imports the knife-catching v7's own guards exist to prevent. W2 keeps
// the washout entry (drop >= 1.8% from the trailing 60-bar high, freefall
// filter on) but gates it with v7's own machinery: (a) it may fire only
// when the direction layer does NOT read DOWN (UP or RANGE only); (b) R's
// waterfall guards (mom60 and mom360 vs their sigma multiples) must also
// pass, so a mid-crash leg cannot trigger it inside a stale non-DOWN read;
// (c) the P/R event blackout windows apply to it too. At most 2 sleeve
// trades per window, 15% size, lowest priority. When W2 never fires, the
// bot is v7 exactly.
//
// All state comes from the bars themselves: no clock, no randomness, no
// files, so two runs over the same window answer byte for byte alike.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

/* ---- volatility normalisation ---- */
/** Trailing momentum samples used for each sigma estimate. */
const SIGMA_SAMPLES = 240;
/** Cold-start fallbacks (dev-tape-like) until enough samples exist. */
const SIGMA15_FALLBACK = 26;
const SIGMA60_FALLBACK = 55;
const SIGMA360_FALLBACK = 125;

/* ---- sleeve T: thrust ---- */
const T_THR_MULT = 2.2; // entry: mom15 >= T_THR_MULT * sigma15 (bps, clamped)
const T_THR_MIN = 52;
const T_THR_MAX = 85;
const T_SLOW_MULT = 0.25; // entry also needs mom60 >= T_SLOW_MULT * sigma60
const T_DEATH_MULT = -1.15; // exit: mom15 <= T_DEATH_MULT * sigma15
const T_TRAIL_MULT = 4.2; // exit: trailing stop, x sigma15 (bps, clamped)
const T_TRAIL_MIN = 70;
const T_TRAIL_MAX = 190;
const T_TIME_BARS = 45; // a thrust must prove itself within this many bars
const T_TIME_MULT = 0.5; // ...unless it is ahead by this x sigma15
const T_SIZE_PCT = 75;
const T_LATE_CUTOFF = 180;
/** v7 (33-day live battery): the full thrust gate must pass on this many
 * consecutive bars before T enters. On real tapes 18 of 43 v6 thrust
 * trades died within 20 bars for -$76 — one-bar exhaustion pops inside
 * downtrends. A genuine impulse sustains for many bars, so a one-bar
 * confirmation delay costs almost nothing on real moves and filters the
 * pops. The dev spike (15+ minutes) passes trivially. */
const T_CONFIRM_BARS = 2;

/* ---- sleeve P: participation ---- */
const P_THR_MULT = 0.25; // entry: mom60 >= this x sigma60, inside an EMA-aligned uptrend
const P_EXT_MULT = 1.0; // ...but mom15 no more than this x sigma15 (do not buy the vertical bar) // entry: mom60 >= P_THR_MULT * sigma60 (a real trend, not a wiggle)
const P_DEATH_MULT = -1.0; // exit: mom60 <= P_DEATH_MULT * sigma60 (v7: was -0.5 — battery showed it strangled winners on noise; avg P win was $0.19 vs avg loss -$0.55)
const P_TRAIL_MULT = 3.2; // exit: trailing stop, x sigma15 (bps, clamped)
const P_TRAIL_MIN = 55;
const P_TRAIL_MAX = 150;
const P_TIME_BARS = 420;
const P_SIZE_PCT = 20;
const P_LATE_CUTOFF = 150;

/* ---- sleeve R: reversion pulse ---- */
const R_DIP_MULT = -2.2; // entry: mom15 <= R_DIP_MULT * sigma15 (v7: was -1.9 — battery: 129 R trades at -$0.155 expectancy; shallower dips in a downtrend month are the trend, not the exception)
const R_BOUNCE_MULT = 1.0; // exit: mom15 >= R_BOUNCE_MULT * sigma15 (v7: was 0.9 — demand a real bounce, not an uptick that cannot cover costs)
const R_STOP_MULT = 0.75; // exit: hard stop, x sigma15 below entry (bps, clamped)
const R_STOP_MIN = 15;
const R_STOP_MAX = 40;
const R_GUARD60_MULT = -1.6; // no dip-buying when mom60 <= this x sigma60
const R_GUARD360_MULT = -0.7; // ...or mom360 <= this x sigma360 (when measurable) (v7: was -1.3 — stand down in any real 6h downtrend, not only waterfalls)
const R_TIME_BARS = 30; // a pulse that has not bounced by now is done (v7: was 24, paired with the higher bounce bar)
const R_SIZE_PCT = 10;
const R_LATE_CUTOFF = 40;

/* ---- v6 direction layer ---- */
/** Scored bars of pure observation before the first direction read. */
const OBS_BARS = 90;
/** Scored bars between periodic direction re-reads. */
const RECHECK_BARS = 240;
/** |z| of sigma-normalised displacement at or above this reads as a direction. */
const Z_DIR = 1.0;
/** A close this many sigma15 beyond the trailing range edge is a regime break. */
const BREAK_MULT = 0.6;
/** Trailing bars that define the established range (breaks + range-edge trades). */
const RANGE_LOOKBACK = 150;
/** RANGE regime: buy only in the lowest this fraction of the range... */
const RANGE_EDGE_FRAC = 0.3;
/** ...with at least this much short momentum against the tape (it dipped there). */
const RANGE_DIP_MULT = -0.3;
/** DOWN regime: R probes need a dip at least this deep (x sigma15)... */
const R_DOWN_DIP_MULT = -2.6;
/** ...clear deceleration (mom15 improving by at least this many bps bar over bar)... */
const R_DOWN_DECEL_BPS = 3;
/** ...and stricter waterfall guards, at half size. */
const R_DOWN_GUARD60_MULT = -1.2;
const R_DOWN_GUARD360_MULT = -0.5; // (v7: was -0.9, same stand-down logic as R_GUARD360)
const R_DOWN_SIZE_PCT = 5;

/* ---- shared ---- */
const EMA_FAST_SPAN = 60;
const EMA_TREND_SPAN = 120;
/** Sit-out after an exit, per sleeve that was exited (chop re-arms P slowest). */
const COOLDOWN_T = 20;
const COOLDOWN_P = 90;
const COOLDOWN_R = 15;
/** After a thrust exit, P sits out this long: the bars right after an impulse are a retrace minefield, not a trend. */
const POST_T_P_BLOCK = 60;
const WINDOW_BARS = 1440;
/** Scored-bar windows (event +- a few dozen bars) where P and R take no fresh entries. */
const EVENT_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [67, 117],
  [537, 587],
];
/** Widest gap between the latest close and the fill open an order accepts. */
const MAX_SLIPPAGE_BPS = 150;

/* ---- sleeve W2: washout dip-buy (hybrid v2) ---- */
const W_DROP = 0.018; // entry: close at least 1.8% below the trailing 60-bar high
const W_LOOKBACK = 60; // trailing bars for the reference high (bar highs, current bar included)
const W_SIZE_PCT = 15;
const W_MAX_TRADES = 2; // sleeve buys per window
const W_MIN_HOLD = 8; // bars before TP / trailing exits may fire (hard stop is immediate)
/** Freefall filter (the washout rule's own): skip when the last 3 closes fall strictly and steeply. */
const W_FREEFALL_3BAR = 0.012;
/* Exit set E (default; the tighter set with the best battery tail in the
 * standalone trials): TP +1.4%, trail 1.0% off the best high once up +0.5%,
 * hard stop -2.0%. The C exit set is TP 1.8% / act 0.6% / trail 1.3%. */
const W_TP = 0.014;
const W_TRAIL_ACT = 0.005;
const W_TRAIL = 0.01;
const W_STOP = 0.02;
const W_COOLDOWN = 15; // same sit-out as R after a W exit

/* ---- sleeve L: level-dip (v3) ---- */
const L_SIZE_PCT = 40; // a conviction dip-buy: bigger than the sleeves, below T
const L_MAX_TRADES = 2; // sleeve buys per window
const L_DEPTH1_MIN = 0.015; // Z1 depth floor: 1.5% below REF...
const L_DEPTH1_SIG = 3.0; // ...or 3 x sigma60 (bps), whichever is deeper
const L_DEPTH2_MIN = 0.028; // Z2 depth floor: 2.8% below REF...
const L_DEPTH2_SIG = 5.0; // ...or 5 x sigma60 (bps), whichever is deeper
const L_RECOVERY_TOL = 0.003; // exit: close back at/above REF x (1 - 0.3%)
const L_MIN_HOLD = 30; // bars before the recovery exit may fire (no instant flips)
const L_TIME_BARS = 900; // time stop: the winner held up to ~20 h; 900 bars = 15 h
const L_STOP_BELOW_Z2 = 0.012; // hard stop leg 1: 1.2% below the deep zone
const L_STOP_MAX_DROP = 0.045; // hard stop leg 2: -4.5% from the entry close (the tighter of the two binds)
const L_LATE_CUTOFF = 240; // no new L entries in the last 240 bars (a 900-bar hold cannot complete)
const L_COOLDOWN = 30; // sit-out after an L exit

const closes: number[] = [];
const highs: number[] = [];
const mom15Hist: number[] = [];
const mom60Hist: number[] = [];
const mom360Hist: number[] = [];
let prevM15: number | null = null;
let emaFast = 0;
let emaTrend = 0;
let seeded = false;
const emaFastHist: number[] = [];

type Sleeve = 'T' | 'P' | 'R' | 'W' | 'L';
let sleeve: Sleeve | null = null;
let peakSinceEntry = 0;
let entryClose = 0;
let entrySeq = -1;
/** W2 only: highest bar HIGH since the entry signal bar (its trailing stop rides highs, as in the standalone washout). */
let peakHighW = 0;
/** W2 only: sleeve buys used this window. */
let wTradesUsed = 0;
/** L only: the frozen anchor (close at the end of observation) and the two dip zones below it. 0 until anchored. */
let refPrice = 0;
let zone1 = 0;
let zone2 = 0;
/** L only: hard-stop price level for the open L position (set at entry). */
let lStopLevel = 0;
/** L only: sleeve buys used this window. */
let lTradesUsed = 0;
/** True when the open R position is a RANGE-regime edge trade with a mid-range target. */
let rangeEntry = false;
let rangeTarget = 0;
const exitSeqBy: Record<Sleeve, number> = { T: -1_000_000, P: -1_000_000, R: -1_000_000, W: -1_000_000, L: -1_000_000 };
/** v7: consecutive bars the full T gate has passed (two-bar confirmation). */
let tGateStreak = 0;

type Regime = 'OBS' | 'UP' | 'DOWN' | 'RANGE';
let regime: Regime = 'OBS';
let lastClassBar = -1_000_000;

const alphaFast = 2 / (EMA_FAST_SPAN + 1);
const alphaTrend = 2 / (EMA_TREND_SPAN + 1);

function heldQty(state: BarsState): bigint {
  return state.positions.get(SYMBOL)?.qty ?? 0n;
}

/** Trailing return in bps over `lookback` bars, or null without the history. */
function momentumBps(lookback: number): number | null {
  const end = closes.length - 1;
  if (end - lookback < 0) return null;
  return (closes[end] / closes[end - lookback] - 1) * 10_000;
}

/** Standard deviation of the last SIGMA_SAMPLES samples, or the fallback when starved. */
function sigma(hist: number[], fallback: number, minSamples: number): number {
  if (hist.length < minSamples) return fallback;
  const win = hist.slice(-SIGMA_SAMPLES);
  const mean = win.reduce((a, b) => a + b, 0) / win.length;
  const varSum = win.reduce((a, b) => a + (b - mean) * (b - mean), 0) / win.length;
  const sd = Math.sqrt(varSum);
  return sd > 1 ? sd : fallback;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

function inEventWindow(scoredBar: number): boolean {
  return EVENT_WINDOWS.some(([a, b]) => scoredBar >= a && scoredBar <= b);
}

/**
 * High/low of the trailing RANGE_LOOKBACK closes BEFORE the current bar —
 * the established range. The current close is excluded on purpose: a range
 * that already contains this bar's close could never be broken by it.
 */
function trailingRange(): readonly [number, number] {
  const end = closes.length - 1;
  const from = Math.max(0, end - RANGE_LOOKBACK);
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = from; i < end; i++) {
    if (closes[i] > hi) hi = closes[i];
    if (closes[i] < lo) lo = closes[i];
  }
  return [hi, lo];
}

/**
 * Direction read: net displacement over `lookback` bars, normalised by the
 * noise that span would produce from sigma15 alone. |z| >= Z_DIR is a
 * direction; anything quieter is a range.
 */
function classify(scoredBar: number, lookback: number, s15: number): void {
  const disp = momentumBps(lookback);
  const noise = s15 * Math.sqrt(lookback / 15);
  const z = disp === null || noise <= 0 ? 0 : disp / noise;
  regime = z >= Z_DIR ? 'UP' : z <= -Z_DIR ? 'DOWN' : 'RANGE';
  lastClassBar = scoredBar;
}

/** Observation end, periodic re-reads, and range-break flips. Runs every scored bar. */
function updateRegime(scoredBar: number, close: number, s15: number): void {
  if (regime === 'OBS') {
    if (scoredBar >= OBS_BARS) classify(scoredBar, OBS_BARS, s15);
    return;
  }
  const [hi, lo] = trailingRange();
  const buf = (BREAK_MULT * s15) / 10_000;
  if (hi > 0 && close > hi * (1 + buf)) {
    // A decisive exit through the range top is the direction revealing
    // itself: read UP now, whatever the trailing displacement still says.
    classify(scoredBar, Math.min(RECHECK_BARS, Math.max(scoredBar, 15)), s15);
    regime = 'UP';
    return;
  }
  if (lo > 0 && close < lo * (1 - buf)) {
    classify(scoredBar, Math.min(RECHECK_BARS, Math.max(scoredBar, 15)), s15);
    regime = 'DOWN';
    return;
  }
  if (scoredBar - lastClassBar >= RECHECK_BARS) {
    classify(scoredBar, RECHECK_BARS, s15);
  }
}

function buy(state: BarsState, pct: number, tag: Sleeve, close: number): OrderInput[] {
  const notional = (state.cash * BigInt(pct)) / 100n;
  if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
  sleeve = tag;
  peakSinceEntry = close;
  entryClose = close;
  entrySeq = state.seq;
  rangeEntry = false;
  rangeTarget = 0;
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Only batches that actually carry a CBBTC bar advance the series; a
    // minute the recorder missed leaves every indicator where it was.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    const high = Number(bar.h);
    const prevClose = closes.length > 0 ? closes[closes.length - 1] : close;
    closes.push(close);
    highs.push(high);
    if (!seeded) {
      emaFast = close;
      emaTrend = close;
      seeded = true;
    } else {
      emaFast += alphaFast * (close - emaFast);
      emaTrend += alphaTrend * (close - emaTrend);
    }
    emaFastHist.push(emaFast);
    const m15 = momentumBps(15);
    if (m15 !== null) mom15Hist.push(m15);
    const lastM15 = prevM15;
    if (m15 !== null) prevM15 = m15;
    const m60 = momentumBps(60);
    if (m60 !== null) mom60Hist.push(m60);
    const m360 = momentumBps(360);
    if (m360 !== null) mom360Hist.push(m360);

    if (state.warmingUp) return [];
    const qty = heldQty(state);
    const scoredBar = state.seq - state.warmupBars;
    const s15 = sigma(mom15Hist, SIGMA15_FALLBACK, 30);
    const s60 = sigma(mom60Hist, SIGMA60_FALLBACK, 25);
    const s360 = sigma(mom360Hist, SIGMA360_FALLBACK, 25);

    // The direction layer reads every scored bar, holding or flat: a flip
    // never forces an exit, it only re-arms the entry sleeves.
    updateRegime(scoredBar, close, s15);

    // Sleeve L anchor: the moment observation ends, freeze the reference
    // close and the two dip zones below it for the whole window. The
    // depths are sigma60-scaled with absolute floors, computed from the
    // sigma60 available at this bar, then never moved again — a level
    // that drifts is not a level.
    if (refPrice === 0 && scoredBar >= OBS_BARS) {
      refPrice = close;
      const d1 = Math.max(L_DEPTH1_MIN, (L_DEPTH1_SIG * s60) / 10_000);
      const d2 = Math.max(L_DEPTH2_MIN, (L_DEPTH2_SIG * s60) / 10_000);
      zone1 = refPrice * (1 - d1);
      zone2 = refPrice * (1 - d2);
    }

    if (qty > 0n) {
      // Riding a position: guard the exits of whichever sleeve opened it.
      if (close > peakSinceEntry) peakSinceEntry = close;
      if (sleeve === 'W' && high > peakHighW) peakHighW = high;
      const heldBars = entrySeq >= 0 ? state.seq - entrySeq : 0;
      let exit = false;
      if (sleeve === 'T') {
        const death = m15 !== null && m15 <= Math.max(T_DEATH_MULT * s15, -48); // vol-scaled, but never looser than -48 bps: a spike inflates sigma15 itself
        const trailed = peakSinceEntry > 0 && close <= peakSinceEntry * (1 - clamp(T_TRAIL_MULT * s15, T_TRAIL_MIN, T_TRAIL_MAX) / 10_000);
        const stale = entryClose > 0 && heldBars >= T_TIME_BARS && close < entryClose * (1 + (T_TIME_MULT * s15) / 10_000);
        exit = death || trailed || stale;
      } else if (sleeve === 'P') {
        const trendBroke = (close < emaFast && m60 !== null && m60 < 0) || close < emaTrend;
        const death = m60 !== null && m60 <= P_DEATH_MULT * s60;
        const trailed = peakSinceEntry > 0 && close <= peakSinceEntry * (1 - clamp(P_TRAIL_MULT * s15, P_TRAIL_MIN, P_TRAIL_MAX) / 10_000);
        const stale = heldBars >= P_TIME_BARS;
        exit = trendBroke || death || trailed || stale;
      } else if (sleeve === 'W') {
        // Sleeve W2: the standalone washout exits, measured on closes vs
        // the entry signal close. Hard stop is immediate; take-profit and
        // the trailing stop (off the best bar high since entry) wait for
        // the minimum hold, exactly as in the standalone rules.
        const pnl = entryClose > 0 ? close / entryClose - 1 : 0;
        const stoppedW = pnl <= -W_STOP;
        const tookProfit = heldBars >= W_MIN_HOLD && pnl >= W_TP;
        const trailedW = heldBars >= W_MIN_HOLD && pnl >= W_TRAIL_ACT && peakHighW > 0 && close <= peakHighW * (1 - W_TRAIL);
        exit = stoppedW || tookProfit || trailedW;
      } else if (sleeve === 'L') {
        // Sleeve L: the winner's hold shape. No trailing stop at all.
        // Bank on recovery to just under the anchor (after the minimum
        // hold), leave on the 900-bar time stop, and let the hard stop
        // (a fixed price level set at entry) be the only protection.
        const stoppedL = lStopLevel > 0 && close <= lStopLevel;
        const recovered = heldBars >= L_MIN_HOLD && refPrice > 0 && close >= refPrice * (1 - L_RECOVERY_TOL);
        const staleL = heldBars >= L_TIME_BARS;
        exit = stoppedL || recovered || staleL;
      } else {
        // sleeve R (or an untracked position): pulse rules. A range-edge
        // trade also banks at its mid-range target.
        const bounced = m15 !== null && m15 >= R_BOUNCE_MULT * s15;
        const hitTarget = rangeEntry && rangeTarget > 0 && close >= rangeTarget;
        const stopped = entryClose > 0 && close <= entryClose * (1 - clamp(R_STOP_MULT * s15, R_STOP_MIN, R_STOP_MAX) / 10_000);
        const stale = heldBars >= R_TIME_BARS;
        exit = bounced || hitTarget || stopped || stale;
      }
      if (exit) {
        if (sleeve !== null) exitSeqBy[sleeve] = state.seq;
        sleeve = null;
        peakSinceEntry = 0;
        entryClose = 0;
        entrySeq = -1;
        rangeEntry = false;
        rangeTarget = 0;
        peakHighW = 0;
        lStopLevel = 0;
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat. A position the bot did not open (should not happen) clears the tag.
    if (sleeve !== null) sleeve = null;
    // Observation phase: the price has not shown its direction yet.
    if (regime === 'OBS') return [];
    // Cooldowns are per sleeve: a finished pulse never delays a thrust.
    const cooledT = state.seq - exitSeqBy.T >= COOLDOWN_T;
    const cooledP = state.seq - exitSeqBy.P >= COOLDOWN_P;
    const cooledR = state.seq - exitSeqBy.R >= COOLDOWN_R;
    const cooledW = state.seq - exitSeqBy.W >= W_COOLDOWN;
    const cooledL = state.seq - exitSeqBy.L >= L_COOLDOWN;
    if (m15 === null || m60 === null) return [];
    const eventCaution = inEventWindow(scoredBar);

    // Sleeve T: a vol-scaled thrust with trend confirmation. UP days only:
    // in a range it is fee bleed, in a downtrend it is catching a bounce.
    // One exception, and it is the owner's rule itself: a full thrust gate
    // passing IS the price showing its direction, so it flips the read to
    // UP on the spot (a range break needs the close beyond the range edge;
    // a violent impulse from inside the range would otherwise be read too
    // late). The gate is the whole v5 filter — nothing is relaxed.
    // v7: the gate is evaluated every flat bar to maintain the confirmation
    // streak; entry (and the regime flip it carries) needs T_CONFIRM_BARS
    // consecutive passes, so a one-bar exhaustion pop never gets bought.
    const tGate = closes.length > EMA_TREND_SPAN && m15 >= clamp(T_THR_MULT * s15, T_THR_MIN, T_THR_MAX) && m60 >= T_SLOW_MULT * s60 && close > emaTrend;
    tGateStreak = tGate ? tGateStreak + 1 : 0;
    if (cooledT && tGateStreak >= T_CONFIRM_BARS && scoredBar < WINDOW_BARS - T_LATE_CUTOFF) {
      if (regime !== 'UP') {
        regime = 'UP';
        lastClassBar = scoredBar;
      }
      tGateStreak = 0;
      return buy(state, T_SIZE_PCT, 'T', close);
    }
    // Sleeve P: participation in a rising grind. The bar is regime, not
    // magnitude: fast EMA above the trend EMA and rising, price above
    // both, hour momentum positive. Slow grinds never show a big mom60;
    // what they show is alignment that persists. UP days only.
    if (regime === 'UP' && cooledP && state.seq - exitSeqBy.T >= POST_T_P_BLOCK && !eventCaution && scoredBar < WINDOW_BARS - P_LATE_CUTOFF && closes.length > EMA_TREND_SPAN) {
      const emaRising = emaFastHist.length > 30 && emaFast > emaFastHist[emaFastHist.length - 31];
      // v7: P also needs the 6-hour trend itself to be up (mom360 > 0 when
      // measurable). Battery: P won 6% of 87 trades — EMA alignment inside
      // a falling 6h trend is a bear-market bounce, not a grind.
      if (m60 >= P_THR_MULT * s60 && m15 <= P_EXT_MULT * s15 && m15 >= -0.5 * s15 && close > emaTrend && emaFast > emaTrend && emaRising && (m360 === null || m360 > 0)) {
        return buy(state, P_SIZE_PCT, 'P', close);
      }
    }
    // Sleeve R: what it may do depends on the direction read.
    if (cooledR && !eventCaution && scoredBar < WINDOW_BARS - R_LATE_CUTOFF) {
      const stabilised = close >= prevClose && (lastM15 === null || m15 >= lastM15 - 2);
      if (regime === 'UP') {
        // As v5: a small pulse into a sharp dip that has stopped falling,
        // in a tape whose long momentum is not a waterfall.
        const guardOk = m60 > R_GUARD60_MULT * s60 && (m360 === null || m360 > R_GUARD360_MULT * s360);
        if (guardOk && stabilised && m15 <= R_DIP_MULT * s15) {
          return buy(state, R_SIZE_PCT, 'R', close);
        }
      } else if (regime === 'RANGE') {
        // Range-edge reversion: only at the lower edge of the established
        // range, only after the dip stops falling, out at mid-range.
        const guardOk = m60 > R_GUARD60_MULT * s60 && (m360 === null || m360 > R_GUARD360_MULT * s360);
        const [hi, lo] = trailingRange();
        const atEdge = hi > lo && close <= lo + RANGE_EDGE_FRAC * (hi - lo);
        if (guardOk && stabilised && atEdge && m15 <= RANGE_DIP_MULT * s15) {
          const orders = buy(state, R_SIZE_PCT, 'R', close);
          if (orders.length > 0) {
            rangeEntry = true;
            rangeTarget = (hi + lo) / 2;
          }
          return orders;
        }
      } else if (regime === 'DOWN') {
        // Defensive probe only: an extreme dip that is clearly decelerating
        // (first sign of a turn), stricter waterfall guards, half size.
        const guardOk = m60 > R_DOWN_GUARD60_MULT * s60 && (m360 === null || m360 > R_DOWN_GUARD360_MULT * s360);
        const turning = close >= prevClose && lastM15 !== null && m15 >= lastM15 + R_DOWN_DECEL_BPS;
        if (guardOk && turning && m15 <= R_DOWN_DIP_MULT * s15) {
          return buy(state, R_DOWN_SIZE_PCT, 'R', close);
        }
      }
    }
    // Sleeve L (v3): the level-dip, priority below T/P/R and above W2.
    // Patient, like the pattern it adapts: a close at or below the
    // shallow zone buys 40% and then simply holds for the recovery, the
    // time stop, or the hard stop. Inside the event blackout windows the
    // shallow zone is closed to it — but the deep zone stays open even
    // there: buying the event flush at the deep level is the winner's
    // whole point, and the extra depth is the compensation for the risk.
    // No regime or momentum gate, as designed — and the build log
    // documents why: on the 33-day battery the arm bleeds on down days
    // (11 trades, -$49.42), but every gate tried (a mom360 waterfall
    // veto, a not-DOWN veto, a RANGE-only habitat gate) either admits
    // the same losers or vetoes the flat-day winners, because at a
    // >= 1.5% dip the winner/loser distributions of every available
    // signal fully overlap. The arm ships unguarded, exactly as
    // specified; the hard stop is its only protection.
    if (cooledL && lTradesUsed < L_MAX_TRADES && refPrice > 0 && scoredBar < WINDOW_BARS - L_LATE_CUTOFF) {
      const atDeep = close <= zone2;
      const atShallow = close <= zone1;
      if (atDeep || (atShallow && !eventCaution)) {
        const orders = buy(state, L_SIZE_PCT, 'L', close);
        if (orders.length > 0) {
          lTradesUsed += 1;
          // Hard stop: the tighter (higher) of 1.2% below the deep zone
          // (the level thesis is broken) and -4.5% from the entry close
          // (the disaster cap, binding when sigma blew the zones wide).
          lStopLevel = Math.max(zone2 * (1 - L_STOP_BELOW_Z2), close * (1 - L_STOP_MAX_DROP));
        }
        return orders;
      }
    }
    // Sleeve W2 (hybrid v2): the washout dip-buy, lowest priority — it is
    // only consulted when T, P, R and L all passed. The entry is the
    // standalone washout rule (close >= 1.8% under the trailing 60-bar
    // high, freefall filter on), but hybrid v1's regime-blind arming is
    // replaced by three gates from v7's own machinery:
    //   (a) regime gate: never in a DOWN read (UP or RANGE only) — a
    //       revealed downtrend is where dip-buying bleeds;
    //   (b) waterfall guard: R's own guards must pass (mom60 above
    //       R_GUARD60_MULT x sigma60 and mom360 above R_GUARD360_MULT x
    //       sigma360 when measurable), so a mid-crash leg cannot trigger
    //       the sleeve inside a stale UP/RANGE read either;
    //   (c) event blackout: no entries inside the P/R event windows.
    // Exits are never gated: a W position is guarded by the washout exits
    // whatever the read does next.
    if (regime !== 'DOWN' && !eventCaution && cooledW && wTradesUsed < W_MAX_TRADES && closes.length >= W_LOOKBACK) {
      const guardOk = m60 > R_GUARD60_MULT * s60 && (m360 === null || m360 > R_GUARD360_MULT * s360);
      if (guardOk) {
        let recentHigh = 0;
        for (let i = highs.length - W_LOOKBACK; i < highs.length; i++) {
          if (highs[i] > recentHigh) recentHigh = highs[i];
        }
        const drop = recentHigh > 0 ? (recentHigh - close) / recentHigh : 0;
        let freefall = false;
        if (closes.length >= 3) {
          const c0 = closes[closes.length - 3];
          const c1 = closes[closes.length - 2];
          const c2 = closes[closes.length - 1];
          freefall = c0 > c1 && c1 > c2 && c0 > 0 && (c0 - c2) / c0 > W_FREEFALL_3BAR;
        }
        if (drop >= W_DROP && !freefall) {
          const orders = buy(state, W_SIZE_PCT, 'W', close);
          if (orders.length > 0) {
            peakHighW = close;
            wTradesUsed += 1;
          }
          return orders;
        }
      }
    }
    return [];
  },
});
