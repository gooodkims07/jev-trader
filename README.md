# jev-trader

One decision every Monad block. A TypeSafe Jev model watches the Kuru MON-USDC order book and answers buy or sell every ~300 ms. Every block posts a real post-only limit order on that side, one tick inside the touch, replacing the last one. Fills happen when a taker hits it, so the bot earns the spread instead of paying it. A small server streams every block to the dashboard.

## Run

    cp .env.example .env
    bun install
    bun run start

With no `PRIVATE_KEY` it dry-runs: real book, real decisions, simulated fills. Set `MODEL=jev` and `TYPESAFE_AI_API_KEY` to use Jev; the default `mock` is a momentum heuristic stand-in.

## Venues

Kuru on Monad is the default and the demo. `VENUE=okx` runs the same loop on an OKX USDT perpetual swap instead: `OKX_INST_ID` picks it (default `MON-USDT-SWAP`). Everything exchange specific sits behind the `Venue` interface in `src/venue.ts`; the Trader, the model and the server only see that.

| | Kuru (`VENUE=kuru`) | OKX (`VENUE=okx`) |
|---|---|---|
| Product | spot MON-USDC | USDT-margined perpetual swap |
| Clock | Monad blocks (~300 ms) | a 300 ms timer (`OKX_TICK_MS`); `block` in events is the tick number |
| Book, prints | `eth_call` getL2Book, `eth_getLogs` Trade | public WebSocket `books5` + `trades`, REST fallback |
| Order | one `batchUpdate` tx: cancel + post-only place | `cancel-order` for what rests, then `order` with `ordType: post_only` |
| Our fills | Trade logs with us as maker | private WebSocket `orders` (`fillSz`, `fillPx`, `fillFee`) |
| Funds | margin account: USDC for bids, MON for asks | USDT margin for either side (notional / `OKX_LEVERAGE`); reducing the position needs none |
| Cost | gas on the gas limit (`gasMon`) | maker fee per fill from the account's fee tier (`feesUsd`); funding is not counted |
| Money | USDC | USDT (every `...Usd` field is in the venue's quote currency) |
| Live when | `PRIVATE_KEY` is set | `OKX_API_KEY`, `OKX_SECRET_KEY` and `OKX_PASSPHRASE` are set |

OKX notes:
- Sizes stay in the underlying and are converted to contracts: MON-USDT-SWAP contracts are 10 MON, so `TRADE_SIZE` must be a multiple of 10. For any other swap set `TRADE_SIZE` and `MAX_POSITION` in its underlying; the bot refuses to start otherwise.
- `OKX_DEMO` defaults to `true`: live runs go to OKX demo trading (`x-simulated-trading: 1`, demo keys). Demo trading lists fewer swaps and **not MON-USDT-SWAP**; use e.g. `BTC-USDT-SWAP` there. A dry run always reads the real market. `OKX_DEMO=false` trades real money.
- The account must be in net position mode. Startup sets `OKX_LEVERAGE` (default 2) and `OKX_MARGIN_MODE` (default `isolated`) for the swap, reads the maker fee, cancels orders it left behind (client ids starting `jev`), and refuses to start with a position already open. Ctrl-C cancels our open orders and warns if a position is left; it never closes a position for you.
- Register the API key's IP with OKX and give it read and trade permissions only (no withdrawal). The account must also be allowed to trade futures: OKX error `50123` ("does not have trading permission") on every order means it is not.
- Refused orders stop the bot: at once on an auth or permission refusal (HTTP 401, codes 501xx), otherwise after 20 in a row. It shuts down as on Ctrl-C.
- `OKX_TICK_MS` sets the loop step (default 300). At `OKX_TICK_MS=1000` set `HORIZON_BLOCKS=30` to keep the ~30 s horizon; Jev's question states the tick and horizon in seconds either way.

## Endpoints

Deployed (dry run, mock model): https://jev-trader-production.up.railway.app

- `GET /` snapshot: model, wallet, dryRun, latest block event
- `GET /history` last 1000 block events
- `GET /events` SSE: `snapshot` on connect, then one `block` event per block, plus a `fill` event whenever a live order's receipt lands

Every event (see `src/trader.ts` for types):

    {
      "block": 105488269, "ts": 1789593630676,
      "mid": 0.022636, "bestBid": 0.022628, "bestAsk": 0.022644, "spreadBps": 7.07,
      "decision": { "action": "buy", "probabilities": { "buy": 0.77, "sell": 0.23, "hold": 0 }, "upIn10": 0.77, "latencyMs": 81, "late": false },
      "quote": { "side": "buy", "price": 0.022629, "size": 200, "txHash": "0x…", "gasMon": 0.0357, "cancel": [100295801], "status": "sent", "orderId": null, "capped": false },
      "fill": null,
      "resting": { "bidMon": 200, "askMon": 200 },
      "position": { "side": "short", "size": 200, "entryPrice": 0.022633, "unrealizedUsd": -0.0006, "unrealizedMon": -0.027 },
      "totals": { "blocks": 3, "decisions": 3, "quotes": 3, "fills": 1, "reverted": 0, "lateBlocks": 0, "jevUsd": 0.000004, "gasMon": 0.107, "gasUsd": 0.0024, "realizedUsd": 0, "pnlUsd": -0.003, "pnlMon": -0.13, "pnlPct": -0.003 }
    }

Every block the model is asked about the move over `HORIZON_BLOCKS` (default 100, ~30 s) and answers `buy` or `sell`. `quote` is the order that block put on the book: a post-only limit order of `TRADE_SIZE` on that side, `QUOTE_INSIDE_TICKS` inside the touch (clamped to the touch when the spread is too tight), in one `batchUpdate` that also cancels everything we had resting (`cancel`). `hold` appears only with `decision.late: true`, when the model missed the block and nothing was posted. When the position cap (or, live, margin funds) blocks a side, the quote goes on the other side with `capped: true` and `probabilities` still show the model's call. `resting` is our size known to be on the book after this block. `upIn10` equals the buy probability.

Live sends are fired and forgotten, so the `block` event carries the **intent**: `status: "sent"`, `gasMon` is `gasLimit x (last known base fee + priority)`. Monad charges the gas limit, so that is the real cost whether the order lands or not. The receipt arrives a block or two later as its own SSE event:

    event: quote
    data: { "block": 105488269, "quote": { …, "status": "placed", "orderId": 100295812, "gasMon": 0.0357 } }

`status` becomes `placed` (with the order id) or `reverted` (the book moved through the price before the tx landed, or a cancelled order had already filled). No receipt after 10 blocks gives `lost`. Fills are not in our own transactions: someone else's taker order hits our resting one, and the Trade log for it arrives via the same `eth_getLogs` poll that feeds the model. Each block with fills gets its own SSE event, and `position`, `realizedUsd` and `fills` update then:

    event: fill
    data: { "block": 105488271, "fill": { "side": "buy", "size": 200, "price": 0.022629, "txHash": "0x…", "orderId": 100295812, "simulated": false } }

`txHash` is the taker's transaction. In a dry run the quote is `status: "sim"`: the order rests for one block and fills from real prints (`simulated: true`), queued behind the size already resting at its price. A print at our price eats that queue first and fills us with the rest; a print through our price fills us in full. An order one tick inside the touch has no queue. Queue size that cancels is not credited, so simulated fills err low.

## Layout

    src/config.ts   env
    src/chain.ts    block feed (WebSocket newHeads + polling backstop, newest block only), raw RPC
    src/book.ts     one-eth_call order book reader (decodes getL2Book, merges the AMM vault)
    src/venue.ts    Venue interface and the types shared by every exchange
    src/market.ts   KuruVenue: read book, hand-encoded batchUpdate (cancel + post-only place), margin deposits, local nonce, async confirmation
    src/okx.ts      OkxVenue: USDT perpetual swap, WebSocket book and prints, private orders fills, cancel then post-only place
    src/okx-api.ts  OKX v5 REST with HMAC-SHA256 signing, demo trading header, clock sync
    src/model.ts    Model interface, JevModel (AI SDK experimental_evaluate), MockModel
    src/trader.ts   the loop: one in flight, hold when late, position and P&L accounting
    src/server.ts   Bun.serve: snapshot, history, SSE

## The 300 ms budget

A decision and an order have to fit in one block, so the hot loop makes exactly two RPC round trips:
one `eth_call` for the book (~18 ms on the public RPC, `READ_RPC_URL`) and one `eth_sendRawTransaction`
(`RPC_URL`), which returns as soon as the tx is accepted. Nothing else is on the path — no
`eth_estimateGas` (Monad charges gas on the limit, so the limit is hardcoded or derived once at
startup), no `eth_sendRawTransactionSync` (it blocks until the tx is Proposed), no gas price lookup
(static type-2 fees: `MAX_FEE_GWEI` cap, 2 gwei priority; the effective price is base + priority).
Receipts, the fee estimate and the vault check run off the hot path on later blocks. Measured in a
dry run with the mock model: read p50 18 ms, whole loop p50 100 ms (80 ms of it the mock's inference stand-in).

    bun run scripts/bench-read.ts     # book reader vs the SDK: exactness and latency
    bun run scripts/dry-encode.ts     # signs a buy and a sell offline, asserts the calldata matches the SDK
