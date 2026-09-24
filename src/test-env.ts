// Test preload (bunfig.toml [test]): pin the settings tests depend on, whatever the local .env says.
// Bun has already loaded .env into process.env; config.ts reads these when first imported.
Object.assign(process.env, {
  DRY_RUN: "true",
  MODEL: "mock",
  VENUE: "kuru",
  TRADE_SIZE: "200",
  MAX_POSITION: "1000",
  HORIZON_BLOCKS: "100",
  QUOTE_INSIDE_TICKS: "1",
  OKX_INST_ID: "XRP-USDT-SWAP",
  OKX_TICK_MS: "300",
  OKX_MAKER_FEE_RATE: "0.0002",
  OKX_EMERGENCY_STOP_PCT: "0",
  MIN_SIDE_PROB: "0",
  RISK_SESSION_STOP_LOSS: "0",
  RISK_SESSION_TAKE_PROFIT: "0",
  RISK_POSITION_STOP_PCT: "0",
  RISK_POSITION_TAKE_PCT: "0",
});
