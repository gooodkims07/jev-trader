/** An empty value (KEY= in .env) counts as unset, so a blank line from the example never becomes 0. */
const env = (key: string, fallback?: string) => process.env[key] || fallback;
const num = (key: string) => (env(key) ? Number(env(key)) : undefined);

const venue = env("VENUE", "kuru") as "kuru" | "okx";
const okxKey = env("OKX_API_KEY"), okxSecret = env("OKX_SECRET_KEY"), okxPassphrase = env("OKX_PASSPHRASE");
/** Live only with credentials for the chosen venue and DRY_RUN not "true". */
const hasKeys = venue === "okx" ? !!(okxKey && okxSecret && okxPassphrase) : !!env("PRIVATE_KEY");

export const config = {
  /** Which exchange the bot trades on. kuru: Monad's on-chain spot book, one order per block. okx: a USDT perpetual swap, one order per 300 ms tick. */
  venue,
  rpcUrl: env("RPC_URL", "https://rpc.monad.xyz")!, // sends, receipts, nonce, gas estimation
  readRpcUrl: env("READ_RPC_URL", "https://rpc.monad.xyz")!, // book reads + eth_blockNumber polling + trade logs
  wsUrl: env("WS_URL"), // optional; polling backstop always runs
  chainId: 143,
  market: env("MARKET", "0x065C9d28E428A0db40191a54d33d5b7c71a9C394")!, // Kuru MON-USDC
  /** Kuru MarginAccount this market settles against (slot 73 of the OrderBook proxy; verifiedMarket(market) is true). */
  marginAccount: env("MARGIN_ACCOUNT", "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5")!,
  privateKey: env("PRIVATE_KEY"),
  dryRun: env("DRY_RUN") === "true" || !hasKeys,
  okx: {
    apiKey: okxKey,
    secretKey: okxSecret,
    passphrase: okxPassphrase,
    /** USDT-margined perpetual swap. Sizes (TRADE_SIZE, MAX_POSITION) are in its underlying, converted to contracts. */
    instId: env("OKX_INST_ID", "XRP-USDT-SWAP")!,
    /** Demo trading (OKX's paper account, `x-simulated-trading: 1`) unless OKX_DEMO=false. Demo keys only work there. */
    demo: env("OKX_DEMO", "true") !== "false",
    /** isolated caps the loss at the margin posted for this swap; cross shares the whole USDT balance. */
    marginMode: env("OKX_MARGIN_MODE", "isolated") as "isolated" | "cross",
    leverage: Number(env("OKX_LEVERAGE", "2")),
    /**
     * Exchange-side emergency stop, in percent from the average entry (0 = off). A conditional market order
     * on OKX closes the whole position if the mark price moves this far against it, even with the bot down.
     * Re-placed as the position flips or its entry moves; OKX drops it when the position closes.
     */
    emergencyStopPct: Number(env("OKX_EMERGENCY_STOP_PCT", "0")),
    /** Maker fee rate for simulated fills (OKX's regular tier). Live fills carry OKX's own fillFee. */
    makerFeeRate: Number(env("OKX_MAKER_FEE_RATE", "0.0002")),
    /** Length of one loop step. No chain, so a timer stands in for the block. */
    tickMs: Number(env("OKX_TICK_MS", "300")),
  },
  /** Order size in the base asset (MON on Kuru; the swap's underlying on OKX). TRADE_SIZE_MON still works. */
  tradeSize: Number(env("TRADE_SIZE", env("TRADE_SIZE_MON", "200"))), // Kuru MON-USDC minimum order is 200 MON
  maxPosition: Number(env("MAX_POSITION", env("MAX_POSITION_MON", "1000"))),
  /**
   * The defaults and the ..._MON settings are MON amounts, so any other coin must set TRADE_SIZE and
   * MAX_POSITION themselves. Otherwise a .env copied from the example would size a BTC order at 200 BTC.
   */
  sizesSetForAnyCoin: !!env("TRADE_SIZE") && !!env("MAX_POSITION"),
  /** Started by scripts/run.sh, which restarts the bot when it exits with 75 (e.g. the dashboard changed the coin). */
  supervised: env("JEV_SUPERVISED") === "1",
  bankrollUsd: Number(env("BANKROLL", env("BANKROLL_USD", "100"))), // used for pnlPct, in the venue's quote currency
  /** Quote this many ticks inside the touch (0 = join the best bid/ask). Never crosses: clamps to the touch when the spread is too tight. */
  quoteInsideTicks: Number(env("QUOTE_INSIDE_TICKS", "1")),
  /** Startup deposits into the Kuru margin account, topped up to these balances. Limit orders draw from margin, not the wallet. */
  marginMon: Number(env("MARGIN_MON", "600")),
  marginUsdc: Number(env("MARGIN_USDC", "20")),
  // Monad charges gas on the LIMIT, so never estimate per block: estimate once at init (or override) and hardcode.
  gasLimit: num("GAS_LIMIT"),
  gasLimitFallback: 350_000, // batchUpdate: one cancel + one post-only place measured at ~282k for the place alone
  // EIP-1559 type-2 only. Effective price = base + priority, so a high static cap is free.
  maxFeeGwei: Number(env("MAX_FEE_GWEI", "400")),
  priorityFeeGwei: Number(env("PRIORITY_FEE_GWEI", "2")), // Monad hardcodes eth_maxPriorityFeePerGas at 2
  pendingBlocks: 10, // give up on a tx with no receipt after this many blocks
  refreshBlocks: 200, // unused: refreshes now run once a minute
  horizonBlocks: Number(env("HORIZON_BLOCKS", "100")), // the model is asked about the move over this many blocks (~30 s)
  /**
   * When the model skips (OKX), still post on the likelier of bid and ask if its probability is at least
   * this (0.3 = 30%). 0 = always respect the skip.
   */
  minSideProb: Number(env("MIN_SIDE_PROB", "0")),
  /** How far back the model's inputs look (taker flow, sampled mids). Defaults to the horizon, as on Kuru. */
  lookbackBlocks: Number(env("LOOKBACK_BLOCKS", env("HORIZON_BLOCKS", "100"))),
  model: env("MODEL", "mock") as "mock" | "jev",
  /** Bearer token that lets the dashboard change settings (POST /settings). Unset: settings are read-only. */
  adminToken: env("ADMIN_TOKEN"),
  jevModelId: env("JEV_MODEL_ID", "jev-latest")!,
  jevUsdPerMTok: 0.042,
  port: Number(env("PORT", "3000")),
  /** Blocks kept for the dashboard. OKX: an hour at a 1 s tick, the chart's longest range. */
  historySize: venue === "okx" ? 3600 : 1000,
  /**
   * mm: market making (one post-only order per block; Kuru's demo, and OKX). spike (OKX, dry run only for
   * now): wait for a sharp move, let Jev choose long, short or stay out, enter at market, exit at
   * take-profit, stop-loss or a time limit.
   */
  strategy: (env("STRATEGY", "mm") as "mm" | "spike"),
  spike: {
    /**
     * A spike: the mid moved at least move1mPct over the short window (window1Sec, default 1 minute), or
     * move3mPct over the long one (window2Sec, default 3 minutes). The names keep their first defaults.
     */
    move1mPct: Number(env("SPIKE_1M_PCT", "0.5")),
    move3mPct: Number(env("SPIKE_3M_PCT", "0.8")),
    window1Sec: Number(env("SPIKE_WINDOW1_SEC", "60")),
    window2Sec: Number(env("SPIKE_WINDOW2_SEC", "180")),
    /** Exits as return on margin (ROE, %): the price levels are these divided by OKX_LEVERAGE. */
    takeProfitRoePct: Number(env("SPIKE_TP_ROE_PCT", "20")),
    stopLossRoePct: Number(env("SPIKE_SL_ROE_PCT", "30")),
    maxHoldMin: Number(env("SPIKE_MAX_HOLD_MIN", "240")),
    /** Which positions spikes may open: 0 both, 1 long only, 2 short only (SPIKE_SIDES=both|long|short). */
    sides: ({ both: 0, long: 1, short: 2 } as Record<string, number>)[env("SPIKE_SIDES", "both")!] ?? 0,
    /** While in a position, a new spike on the same side adds another order, up to this many times (0 = never). */
    maxAdds: Number(env("SPIKE_MAX_ADDS", "0")),
    /** While in a position, a new spike on the other side closes it and opens the other way (1) or is ignored (0). */
    allowReverse: Number(env("SPIKE_ALLOW_REVERSE", "0")),
    /**
     * Live only: 1 = observe. Spikes are still found and Jev still asked, but no new position or add is sent;
     * a position already open keeps its exits, time limit and session limits. 0 = trade.
     */
    observe: Number(env("SPIKE_OBSERVE", "0")),
    /**
     * The trend shadow (simulated, no orders): long when the mid breaks the highest 1-minute close of the last
     * trendLookbackSec, short below the lowest; out on a trailing stop trendTrailPct from the best mid since
     * entry, or turned by a break the other way. No take-profit, no time limit.
     */
    trendLookbackSec: Number(env("SPIKE_TREND_LOOKBACK_SEC", "14400")),
    trendTrailPct: Number(env("SPIKE_TREND_TRAIL_PCT", "1.5")),
    /** No new spike for this long after one fires, so one move is asked about once. */
    cooldownSec: Number(env("SPIKE_COOLDOWN_SEC", "180")),
    takerFeeRate: Number(env("OKX_TAKER_FEE_RATE", "0.0005")),
  },
  /**
   * Stops and take-profits, all off (0) by default. Money in the venue's quote currency (USDT on OKX),
   * positions as the price move from the average entry, in percent.
   *   session: P&L of this run (realized + unrealized - gas - fees) at or below -stopLoss, or at or above
   *            takeProfit: close the position, then stop the bot.
   *   position: the open position moved stopPct against or takePct in favour of its entry: close it, then
   *            go on trading.
   * Closing posts reduce-only post-only orders at the touch each block until flat ("slowly": no market orders).
   */
  risk: {
    sessionStopLoss: Number(env("RISK_SESSION_STOP_LOSS", "0")),
    sessionTakeProfit: Number(env("RISK_SESSION_TAKE_PROFIT", "0")),
    positionStopPct: Number(env("RISK_POSITION_STOP_PCT", "0")),
    positionTakePct: Number(env("RISK_POSITION_TAKE_PCT", "0")),
  },
};
