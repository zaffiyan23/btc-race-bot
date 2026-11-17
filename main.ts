// Thrust-and-ride for cbBTC on 1-minute bars (agent-fun/bars-replay/v1).
//
// Why this shape: a round trip costs roughly 26-35 bps in fee, slippage and
// price impact, and 1-minute BTC bars are mostly chop (the standard
// deviation of a 30-minute return is only ~35 bps), so a signal has to be
// several times the noise before it is worth paying costs for. The dev
// window's autocorrelation and variance ratios agree: what little edge the
// tape offers sits in short, violent thrusts, not in slow drift.
//
//   - Entry: the trailing 15-minute momentum must thrust at least
//     MOM_MIN_BPS while the trailing 60-minute momentum is also positive
//     and the close sits above its 120-bar EMA (a light regime check, so
//     counter-trend spikes are ignored).
//   - Exit: whichever comes first of a trailing stop under the best close
//     since entry, the 30-minute momentum dying (below EXIT_MOM_BPS), or a
//     time stop on a position that never got going.
//   - Re-entry: a momentum-death exit inside a still-rising regime is a
//     pause, not a funeral: after a short REENTRY_COOLDOWN the bot may buy
//     again on a smaller thrust (REENTRY_MIN_BPS). Any other exit starts
//     the full COOLDOWN_BARS sit-out, so chop cannot whipsaw it into
//     paying the spread again and again.
//   - No new position in the last LATE_CUTOFF batches of a 1,440-bar
//     window: what is left there cannot outrun round-trip costs plus the
//     forced flatten at the end.
//
// All state comes from the bars themselves: no clock, no randomness, no
// files, so two runs over the same window answer byte for byte alike.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

/** Trend EMA span, in bars (regime check only). */
const EMA_TREND_SPAN = 120;
/** Momentum lookbacks, in bars. */
const MOM_FAST = 15;
const MOM_SLOW = 60;
const DEATH_WIN = 30;
/** Least 15-minute thrust (bps) worth paying round-trip costs for. */
const MOM_MIN_BPS = 55;
/** Thrust (bps) that may re-enter after a momentum-death pause. */
const REENTRY_MIN_BPS = 38;
/** 30-minute momentum (bps) under which a held position is abandoned. */
const EXIT_MOM_BPS = -35;
/** Trailing stop distance under the best close since entry, in bps. */
const TRAIL_BPS = 130;
/** A position older than this (bars) that is not ahead by TIME_STOP_MIN_BPS is sold. */
const TIME_STOP_BARS = 360;
const TIME_STOP_MIN_BPS = 20;
/** Share of the cash a buy spends. */
const SIZE_PCT = 90;
/** Batches to sit out after an exit before entering again (short after a momentum-death pause). */
const COOLDOWN_BARS = 45;
const REENTRY_COOLDOWN = 10;
/** Both windows of this competition run 1,440 batches; no entries this close to the end. */
const WINDOW_BARS = 1440;
const LATE_CUTOFF = 240;
/** Widest gap between the latest close and the fill open an order accepts. */
const MAX_SLIPPAGE_BPS = 150;

const closes: number[] = [];
let emaTrend = 0;
let seeded = false;
let peakSinceEntry = 0;
let entryClose = 0;
let entryBar = -1;
let exitBar = -1_000_000; // seq of the last exit decision
let exitWasDeath = false; // whether that exit was a momentum-death pause

const alphaTrend = 2 / (EMA_TREND_SPAN + 1);

function heldQty(state: BarsState): bigint {
  return state.positions.get(SYMBOL)?.qty ?? 0n;
}

/** Trailing return in bps over `lookback` bars, or null without the history. */
function momentumBps(lookback: number): number | null {
  if (closes.length <= lookback) return null;
  const past = closes[closes.length - 1 - lookback];
  return (closes[closes.length - 1] / past - 1) * 10_000;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Only batches that actually carry a CBBTC bar advance the series; a
    // minute the recorder missed leaves every indicator where it was.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    closes.push(close);
    if (!seeded) {
      emaTrend = close;
      seeded = true;
    } else {
      emaTrend += alphaTrend * (close - emaTrend);
    }

    if (state.warmingUp) return [];
    const qty = heldQty(state);
    const scoredBar = state.seq - state.warmupBars;

    if (qty > 0n) {
      // Riding a position: guard the exits.
      if (close > peakSinceEntry) peakSinceEntry = close;
      const trailed = peakSinceEntry > 0 && close <= peakSinceEntry * (1 - TRAIL_BPS / 10_000);
      const deathMom = momentumBps(DEATH_WIN);
      const momentumDied = deathMom !== null && deathMom < EXIT_MOM_BPS;
      const heldBars = entryBar >= 0 ? state.seq - entryBar : 0;
      const stale =
        entryClose > 0 && heldBars >= TIME_STOP_BARS && close < entryClose * (1 + TIME_STOP_MIN_BPS / 10_000);
      if (trailed || momentumDied || stale) {
        exitBar = state.seq;
        exitWasDeath = momentumDied && !trailed && !stale;
        peakSinceEntry = 0;
        entryClose = 0;
        entryBar = -1;
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: look for a thrust worth riding. A death-pause re-entry needs a
    // shorter sit-out and a smaller thrust, but the same rising regime.
    const cooldown = exitWasDeath ? REENTRY_COOLDOWN : COOLDOWN_BARS;
    if (state.seq - exitBar < cooldown) return [];
    if (scoredBar >= WINDOW_BARS - LATE_CUTOFF) return [];
    if (closes.length <= Math.max(EMA_TREND_SPAN, MOM_SLOW)) return [];
    if (close <= emaTrend) return [];
    const momFast = momentumBps(MOM_FAST);
    const momSlow = momentumBps(MOM_SLOW);
    if (momFast === null || momSlow === null) return [];
    if (momSlow <= 0) return [];
    const thrustNeeded = exitWasDeath ? REENTRY_MIN_BPS : MOM_MIN_BPS;
    if (momFast < thrustNeeded) return [];

    const notional = (state.cash * BigInt(SIZE_PCT)) / 100n;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    peakSinceEntry = close;
    entryClose = close;
    entryBar = state.seq;
    exitWasDeath = false;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
