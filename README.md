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
