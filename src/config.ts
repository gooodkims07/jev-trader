const env = (key: string, fallback?: string) => process.env[key] ?? fallback;
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
  refreshBlocks: 200, // how often to refresh the fee estimate, margin balances and the vault check
  horizonBlocks: Number(env("HORIZON_BLOCKS", "100")), // the model is asked about the move over this many blocks (~30 s)
  model: env("MODEL", "mock") as "mock" | "jev",
  jevModelId: env("JEV_MODEL_ID", "jev-latest")!,
  jevUsdPerMTok: 0.042,
  port: Number(env("PORT", "3000")),
  historySize: 1000,
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
