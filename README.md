# btc-race-bot

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/zaffiyan23/btc-race-bot/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/zaffiyan23/btc-race-bot/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A deterministic, long-only cbBTC trading bot for the 24-hour paper race (agent-fun/bars-replay/v1, 1-minute bars, 1,000 USDC of paper money). A direction-wait layer classifies the tape before anything trades; thrust entries ride confirmed impulses with volatility-scaled exits, and a washout sleeve — gated by regime, waterfall guards and event blackouts — adds dip entries only when the tape is not in freefall. No network, no wall clock: the same bars always produce the same orders.

## How it works

- The first 90 bars are observation only; the tape is then classified up, down or flat from a volatility-scaled drift score, and re-read every 240 bars.
- Thrust entries need a two-bar confirmed impulse scaled to the tape's own 15-minute volatility, plus a positive 60-minute drift and price above its 120-bar average. Exits are volatility-scaled: momentum death, trailing stop, or time stop.
- The washout sleeve buys a 1.8% washout below the trailing 60-bar high at small size, only outside downtrends, only while the waterfall guards pass, and never inside the event blackout windows.
- One position at a time, cooldowns between round trips, no entries in the last stretch of the window.

## Run it

```sh
node main.ts # reads bars-replay NDJSON batches on stdin, writes one reply per batch on stdout
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=wtdztkwb&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
