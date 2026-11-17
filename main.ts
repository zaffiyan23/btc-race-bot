// Trend-rider for cbBTC on 1-minute bars (agent-fun/bars-replay/v1).
//
// Why this shape: a round trip costs roughly 26-35 bps in fee, slippage and
// price impact, and 1-minute BTC bars are mostly chop, so the bot trades
// rarely and only on moves that are large next to that cost.
//
//   - Regime: a fast EMA must sit above a slow EMA (uptrend) before any buy.
//   - Trigger: the trailing 30-minute momentum must show a real thrust
//     (>= MOM_MIN_BPS) on top of the regime, so quiet drift is ignored.
//   - Exit: a trailing stop under the best close since entry, or the regime
//     breaking (fast EMA back under the slow one), whichever comes first.
//   - After an exit the bot cools down for COOLDOWN_BARS batches, so chop
//     cannot whipsaw it into paying the spread again and again.
//   - No new position in the last LATE_CUTOFF batches of a 1,440-bar
//     window: a trade opened there cannot outrun its own costs.
//
// All state comes from the bars themselves: no clock, no randomness, no
// files, so two runs over the same window answer byte for byte alike.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

/** EMA spans, in bars. */
const EMA_FAST_SPAN = 45;
const EMA_SLOW_SPAN = 240;
/** Momentum lookback, in bars, and the least thrust (bps) worth paying costs for. */
const MOM_LOOKBACK = 30;
const MOM_MIN_BPS = 25;
/** Share of the cash a buy spends (the rest stays as a buffer). */
const SIZE_PCT = 85;
/** Trailing stop distance under the best close since entry, in bps. */
const TRAIL_BPS = 55;
/** Batches to sit out after an exit before entering again. */
const COOLDOWN_BARS = 30;
/** Both windows of this competition run 1,440 batches; no entries this close to the end. */
const WINDOW_BARS = 1440;
const LATE_CUTOFF = 60;
/** Widest gap between the latest close and the fill open an order accepts. */
const MAX_SLIPPAGE_BPS = 150;

const closes: number[] = [];
let emaFast = 0;
let emaSlow = 0;
let seeded = false;
let peakSinceEntry = 0;
let exitBar = -1_000_000; // seq of the last exit decision

const alphaFast = 2 / (EMA_FAST_SPAN + 1);
const alphaSlow = 2 / (EMA_SLOW_SPAN + 1);

function heldQty(state: BarsState): bigint {
  return state.positions.get(SYMBOL)?.qty ?? 0n;
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
      emaFast = close;
      emaSlow = close;
      seeded = true;
    } else {
      emaFast += alphaFast * (close - emaFast);
      emaSlow += alphaSlow * (close - emaSlow);
    }

    if (state.warmingUp) return [];
    const qty = heldQty(state);
    const scoredBar = state.seq - state.warmupBars;

    if (qty > 0n) {
      // Riding a position: track the best close and guard the exit.
      if (close > peakSinceEntry) peakSinceEntry = close;
      const trailed = peakSinceEntry > 0 && close <= peakSinceEntry * (1 - TRAIL_BPS / 10_000);
      const regimeBroke = emaFast < emaSlow;
      if (trailed || regimeBroke) {
        exitBar = state.seq;
        peakSinceEntry = 0;
        return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: look for an entry, but not during cooldown or near the end.
    if (state.seq - exitBar < COOLDOWN_BARS) return [];
    if (scoredBar >= WINDOW_BARS - LATE_CUTOFF) return [];
    if (closes.length <= Math.max(EMA_SLOW_SPAN, MOM_LOOKBACK)) return [];
    if (emaFast <= emaSlow) return [];
    const past = closes[closes.length - 1 - MOM_LOOKBACK];
    const momentumBps = (close / past - 1) * 10_000;
    if (momentumBps < MOM_MIN_BPS) return [];

    const notional = (state.cash * BigInt(SIZE_PCT)) / 100n;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    peakSinceEntry = close;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
