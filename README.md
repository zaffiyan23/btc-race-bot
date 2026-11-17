# btc-race bot: trend-rider for cbBTC 1-minute bars

A long-only trading bot for the make.fun `btc-race-24h-20261117-0603`
competition (agent-fun/bars-replay/v1). It trades Coinbase Wrapped BTC
(cbBTC) against USDC on 1-minute bars with 1,000 USDC of paper money.

## Idea

A full-size round trip costs roughly 26-35 bps in fees, slippage and price
impact, so the bot only trades moves that are large next to that cost:

- It keeps a fast and a slow exponential moving average of the close.
- It buys only when the fast average is above the slow one (an uptrend
  regime) **and** the trailing 30-minute momentum shows a real thrust.
- It rides the position with a trailing stop under the best close since
  entry, and also leaves if the trend regime breaks.
- After an exit it cools down before it may enter again, so chop cannot
  whipsaw it into paying the spread over and over.

`vendor/makefun-bars.ts` is a byte-identical copy of the kit's SDK shim
(`sdk/makefun-bars.ts`); all strategy code is in `main.ts`.

## Run

The grader runs `node /bot/main.ts`. Locally, from the kit directory:

    node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process

## v5 (live-first rebuild)

Three sleeves share one position slot, every threshold a multiple of the
tape's own realised volatility (no fixed-bps triggers fitted to one day):
T rides vol-scaled thrusts at 75% size, P participates in EMA-aligned
grinds at 20%, R probes extreme decelerating dips at 10% with a tight
mechanical stop. Per-sleeve cooldowns; P sits out 60 bars after a thrust
exit; P and R take no fresh entries around the window's two scheduled US
prints (~bars 72 and 542). Dev-window grade: net +$4.64, max drawdown
0.51%; at least one round trip in every 6-hour segment of the dev tape.

## v6 (direction-wait layer)

The sleeves no longer run from the first bar. The bot opens with a
90-bar observation phase — no trades, it only reads the tape — then
classifies the day as UP, DOWN or RANGE from the sigma-normalised net
displacement, and re-reads the direction every 240 bars and immediately
on a decisive break out of the trailing 150-bar range. UP arms all three
sleeves as in v5. DOWN disarms T and P (long-only does not buy a revealed
downtrend) and allows only extra-strict half-size R probes. RANGE disarms
T and P and allows only small range-edge reversion trades out at
mid-range. A full v5 thrust gate passing in any regime is itself the
price showing direction: it flips the read to UP on the spot. Exits are
never regime-gated. Dev-window grade: net +$6.12, max drawdown 0.47%;
at least one round trip in every 6-hour segment; time-reversed tape
-$3.10 with 10 round trips.

## v7 (live-battery upgrade)

v6 was run cold-start over 33 real unseen days (Coinbase BTC-USD 1-minute
bars, 2026-10-12 to 2026-11-16, kit fill model): it lost money on 30 of
them (mean -$4.75/day). The battery's repeated failure modes, fixed here:
T now needs its full gate to pass on 2 consecutive bars (18 of v6's 43
thrust trades died within 20 bars for -$76 — one-bar exhaustion pops);
P additionally requires the 6-hour trend to be up (mom360 > 0) and its
mom60 death exit is loosened (-0.5 -> -1.0 sigma); R stands down in any
real 6-hour downtrend (guard -1.3 -> -0.7 sigma), needs a deeper dip
(-2.2 sigma) and a real bounce (+1.0 sigma) to exit. Dev-window grade:
net +$7.07, max drawdown 0.47%. Battery after the upgrade: mean -$3.27,
median -$2.05 per day — still negative on a bearish month; see the build
log for the full distribution and the honest live estimate.
