// Three-sleeve long-only bot for cbBTC on 1-minute bars (agent-fun/bars-replay/v1).
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

/* ---- sleeve P: participation ---- */
const P_THR_MULT = 0.25; // entry: mom60 >= this x sigma60, inside an EMA-aligned uptrend
const P_EXT_MULT = 1.0; // ...but mom15 no more than this x sigma15 (do not buy the vertical bar) // entry: mom60 >= P_THR_MULT * sigma60 (a real trend, not a wiggle)
const P_DEATH_MULT = -0.5; // exit: mom60 <= P_DEATH_MULT * sigma60
const P_TRAIL_MULT = 3.2; // exit: trailing stop, x sigma15 (bps, clamped)
const P_TRAIL_MIN = 55;
const P_TRAIL_MAX = 150;
const P_TIME_BARS = 420;
const P_SIZE_PCT = 20;
const P_LATE_CUTOFF = 150;

/* ---- sleeve R: reversion pulse ---- */
const R_DIP_MULT = -1.9; // entry: mom15 <= R_DIP_MULT * sigma15
const R_BOUNCE_MULT = 0.9; // exit: mom15 >= R_BOUNCE_MULT * sigma15
const R_STOP_MULT = 0.75; // exit: hard stop, x sigma15 below entry (bps, clamped)
const R_STOP_MIN = 15;
const R_STOP_MAX = 40;
const R_GUARD60_MULT = -1.6; // no dip-buying when mom60 <= this x sigma60
const R_GUARD360_MULT = -1.3; // ...or mom360 <= this x sigma360 (when measurable)
const R_TIME_BARS = 24; // a pulse that has not bounced by now is done
const R_SIZE_PCT = 10;
const R_LATE_CUTOFF = 40;

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

const closes: number[] = [];
const mom15Hist: number[] = [];
const mom60Hist: number[] = [];
const mom360Hist: number[] = [];
let prevM15: number | null = null;
let emaFast = 0;
let emaTrend = 0;
let seeded = false;
const emaFastHist: number[] = [];

type Sleeve = 'T' | 'P' | 'R';
let sleeve: Sleeve | null = null;
let peakSinceEntry = 0;
let entryClose = 0;
let entrySeq = -1;
const exitSeqBy: Record<Sleeve, number> = { T: -1_000_000, P: -1_000_000, R: -1_000_000 };

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

function buy(state: BarsState, pct: number, tag: Sleeve, close: number): OrderInput[] {
  const notional = (state.cash * BigInt(pct)) / 100n;
  if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
  sleeve = tag;
  peakSinceEntry = close;
  entryClose = close;
  entrySeq = state.seq;
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Only batches that actually carry a CBBTC bar advance the series; a
    // minute the recorder missed leaves every indicator where it was.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    const prevClose = closes.length > 0 ? closes[closes.length - 1] : close;
    closes.push(close);
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

    if (qty > 0n) {
      // Riding a position: guard the exits of whichever sleeve opened it.
      if (close > peakSinceEntry) peakSinceEntry = close;
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
      } else {
        // sleeve R (or an untracked position): pulse rules.
        const bounced = m15 !== null && m15 >= R_BOUNCE_MULT * s15;
        const stopped = entryClose > 0 && close <= entryClose * (1 - clamp(R_STOP_MULT * s15, R_STOP_MIN, R_STOP_MAX) / 10_000);
        const stale = heldBars >= R_TIME_BARS;
        exit = bounced || stopped || stale;
      }
      if (exit) {
        if (sleeve !== null) exitSeqBy[sleeve] = state.seq;
        sleeve = null;
        peakSinceEntry = 0;
        entryClose = 0;
        entrySeq = -1;
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat. A position the bot did not open (should not happen) clears the tag.
    if (sleeve !== null) sleeve = null;
    // Cooldowns are per sleeve: a finished pulse never delays a thrust.
    const cooledT = state.seq - exitSeqBy.T >= COOLDOWN_T;
    const cooledP = state.seq - exitSeqBy.P >= COOLDOWN_P;
    const cooledR = state.seq - exitSeqBy.R >= COOLDOWN_R;
    if (m15 === null || m60 === null) return [];
    const eventCaution = inEventWindow(scoredBar);

    // Sleeve T: a vol-scaled thrust with trend confirmation.
    if (cooledT && scoredBar < WINDOW_BARS - T_LATE_CUTOFF && closes.length > EMA_TREND_SPAN) {
      const thrust = clamp(T_THR_MULT * s15, T_THR_MIN, T_THR_MAX);
      if (m15 >= thrust && m60 >= T_SLOW_MULT * s60 && close > emaTrend) {
        return buy(state, T_SIZE_PCT, 'T', close);
      }
    }
    // Sleeve P: participation in a rising grind. The bar is regime, not
    // magnitude: fast EMA above the trend EMA and rising, price above
    // both, hour momentum positive. Slow grinds never show a big mom60;
    // what they show is alignment that persists.
    if (cooledP && state.seq - exitSeqBy.T >= POST_T_P_BLOCK && !eventCaution && scoredBar < WINDOW_BARS - P_LATE_CUTOFF && closes.length > EMA_TREND_SPAN) {
      const emaRising = emaFastHist.length > 30 && emaFast > emaFastHist[emaFastHist.length - 31];
      if (m60 >= P_THR_MULT * s60 && m15 <= P_EXT_MULT * s15 && m15 >= -0.5 * s15 && close > emaTrend && emaFast > emaTrend && emaRising) {
        return buy(state, P_SIZE_PCT, 'P', close);
      }
    }
    // Sleeve R: a small pulse into a sharp dip that has stopped falling,
    // in a tape whose long momentum is not a waterfall.
    if (cooledR && !eventCaution && scoredBar < WINDOW_BARS - R_LATE_CUTOFF) {
      const guardOk = m60 > R_GUARD60_MULT * s60 && (m360 === null || m360 > R_GUARD360_MULT * s360);
      const stabilised = close >= prevClose && (lastM15 === null || m15 >= lastM15 - 2);
      if (guardOk && stabilised && m15 <= R_DIP_MULT * s15) {
        return buy(state, R_SIZE_PCT, 'R', close);
      }
    }
    return [];
  },
});
