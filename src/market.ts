import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import MarginAccountAbi from "@kuru-labs/kuru-sdk/abi/MarginAccount.json";
import { config } from "./config";
import { rpc, startBlockFeed } from "./chain";
import { readBook as fetchBook, readVaultParams, vaultActive, log10 } from "./book";
import { TradeFeed } from "./trades";
import type { Book, Fill, OrderId, Quote, QuoteResult, Side, Venue, VenueInfo } from "./venue";

export type { Book, Fill, OrderId, Quote, QuoteResult, Side };

const ERC20_ABI = [
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

const gwei = (n: number) => ethers.utils.parseUnits(String(n), "gwei");
const BN = ethers.BigNumber;
const ZERO_ADDRESS = ethers.constants.AddressZero;

interface Pending { block: number; quote: Quote; gasLimit: ethers.BigNumber }

/** Kuru MON-USDC market on Monad: read the book, post one limit order per block, confirm asynchronously. */
export class KuruVenue implements Venue {
  readonly info: VenueInfo = {
    name: "kuru", label: "Kuru", market: config.market, symbol: "MON-USDC", base: "MON", quoteCcy: "USDC",
    priceDecimals: 6, sizeDecimals: 1, clock: "block", txUrl: "https://monadvision.com/tx/",
  };
  readonly makerFeeRate = 0;
  readonly provider = new ethers.providers.StaticJsonRpcProvider(config.rpcUrl, config.chainId);
  /** null in a dry run (no key, or DRY_RUN=true): nothing is signed, nothing is sent. */
  readonly wallet = config.dryRun ? null : new ethers.Wallet(config.privateKey!, this.provider);
  params!: Kuru.MarketParams; // public so scripts can build txs without init()
  /** Margin account balances, refreshed every `config.refreshBlocks`. Limit orders draw from here. */
  readonly funds = { mon: 0, quote: 0 };
  private iface = new ethers.utils.Interface(OrderBookAbi.abi);
  private marginIface = new ethers.utils.Interface(MarginAccountAbi.abi);
  private nonce = 0;
  private feeWei = gwei(102); // base + priority, last known; Monad's floor is 100 + 2
  private gasLimit = BN.from(config.gasLimitFallback);
  private useVault = false;
  private pending = new Map<string, Pending>();

  private feed: TradeFeed | null = null;

  get address() { return this.wallet?.address ?? null; }
  get account() { return this.address; }
  get live() { return this.wallet !== null; }
  get trades() {
    if (!this.feed) throw new Error("KuruVenue.trades before init()");
    return this.feed;
  }
  private get priceDec() { return log10(this.params.pricePrecision); }
  private get sizeDec() { return log10(this.params.sizePrecision); }
  private get tickUnits() { return Number(this.params.tickSize.toString()); }

  async init() {
    this.params = await Kuru.ParamFetcher.getMarketParams(this.provider, config.market);
    this.feed = new TradeFeed({ market: config.market, url: config.readRpcUrl, sizeDec: this.sizeDec, maker: this.address });
    await this.refresh();
    if (!this.wallet) return;
    await this.resyncNonce();
    await this.ensureMargin();
    await this.initGasLimit();
  }

  startClock(onBlock: (block: number) => void) {
    startBlockFeed(onBlock);
  }

  /** Every `config.refreshBlocks`: fee estimate, margin balances, and whether the Kuru AMM vault went live. */
  async refresh() {
    const [fee, vault, mon, usdc] = await Promise.allSettled([
      rpc<string>("eth_gasPrice"),
      readVaultParams(config.readRpcUrl, config.market),
      this.wallet ? this.marginBalance(ZERO_ADDRESS) : Promise.resolve(null),
      this.wallet ? this.marginBalance(this.params.quoteAssetAddress) : Promise.resolve(null),
    ]);
    if (fee.status === "fulfilled") this.feeWei = BN.from(fee.value);
    if (vault.status === "fulfilled") this.useVault = vaultActive(vault.value);
    if (mon.status === "fulfilled" && mon.value) this.funds.mon = Number(ethers.utils.formatUnits(mon.value, this.params.baseAssetDecimals.toNumber()));
    if (usdc.status === "fulfilled" && usdc.value) this.funds.quote = Number(ethers.utils.formatUnits(usdc.value, this.params.quoteAssetDecimals.toNumber()));
  }

  /** One eth_call (two batched into one HTTP request once the vault is live). */
  readBook(): Promise<Book> {
    return fetchBook(config.readRpcUrl, config.market, this.params, { vault: this.useVault });
  }

  /**
   * Where this block's order rests: `quoteInsideTicks` inside the touch on our side, never crossing.
   * If the spread is too tight to step inside, join the touch. Integer tick math, so the price is
   * exactly representable on-chain.
   */
  quotePrice(side: Side, book: Book): number {
    const scale = 10 ** this.priceDec, tick = this.tickUnits;
    const bidU = Math.round(book.bid * scale), askU = Math.round(book.ask * scale);
    const step = config.quoteInsideTicks * tick;
    let p = side === "buy" ? bidU + step : askU - step;
    if (side === "buy" && p >= askU) p = bidU;
    if (side === "sell" && p <= bidU) p = askU;
    return p / scale;
  }

  /**
   * Sign and fire one `batchUpdate`: cancel the given resting orders, post one new post-only limit
   * order. Returns as soon as the RPC has the hash. `pollPending` resolves placed/reverted later.
   */
  async send(block: number, side: Side, sizeMon: number, book: Book, cancel: OrderId[], capped: boolean): Promise<Quote> {
    const price = this.quotePrice(side, book);
    if (!this.wallet) return { side, price, size: sizeMon, txHash: null, ref: null, gasMon: 0, cancel, status: "sim", orderId: null, capped };

    const tx = this.buildTx(side, sizeMon, price, cancel.map(Number));
    const signed = await this.wallet.signTransaction(tx);
    let hash: string;
    try {
      hash = await rpc<string>("eth_sendRawTransaction", [signed]);
      this.nonce++;
    } catch (e) {
      await this.resyncNonce().catch(() => {});
      throw e;
    }
    const quote: Quote = { side, price, size: sizeMon, txHash: hash, ref: hash, gasMon: this.gasMon(this.gasLimit, this.feeWei), cancel, status: "sent", orderId: null, capped };
    this.pending.set(hash, { block, quote, gasLimit: this.gasLimit });
    return quote;
  }

  /** One eth_getTransactionReceipt per in-flight tx. Returns whatever resolved (or timed out). */
  async pollPending(block: number): Promise<QuoteResult[]> {
    if (!this.pending.size) return [];
    const out: QuoteResult[] = [];
    let lost = false;
    await Promise.all([...this.pending].map(async ([hash, p]) => {
      const receipt = await rpc<any>("eth_getTransactionReceipt", [hash]).catch(() => null);
      if (!this.pending.has(hash)) return; // an overlapping poll already resolved it
      if (receipt) {
        this.pending.delete(hash);
        out.push(this.parseReceipt(receipt, p));
      } else if (block - p.block >= config.pendingBlocks) {
        this.pending.delete(hash);
        lost = true;
        out.push({ block: p.block, quote: { ...p.quote, status: "lost", gasMon: 0 }, canceled: [] });
      }
    }));
    if (lost) await this.resyncNonce().catch(() => {});
    return out;
  }

  /** The exact transaction the hot loop signs: no pre-send RPC, hardcoded gas limit, static type-2 fees. */
  buildTx(side: Side, sizeMon: number, price: number, cancel: number[]): ethers.providers.TransactionRequest {
    return {
      type: 2, chainId: config.chainId, to: config.market, nonce: this.nonce, gasLimit: this.gasLimit,
      maxFeePerGas: gwei(config.maxFeeGwei), maxPriorityFeePerGas: gwei(config.priorityFeeGwei),
      data: this.encode(side, sizeMon, price, cancel), value: BN.from(0),
    };
  }

  /** batchUpdate(buyPrices, buySizes, sellPrices, sellSizes, orderIdsToCancel, postOnly). Funds come from the margin account, so value is 0. */
  encode(side: Side, sizeMon: number, price: number, cancel: number[]): string {
    const priceU = BN.from(Math.round(price * 10 ** this.priceDec));
    const sizeU = ethers.utils.parseUnits(sizeMon.toFixed(this.sizeDec), this.sizeDec);
    const [bp, bs, sp, ss] = side === "buy" ? [[priceU], [sizeU], [], []] : [[], [], [priceU], [sizeU]];
    return this.iface.encodeFunctionData("batchUpdate", [bp, bs, sp, ss, cancel.map((id) => BN.from(id)), true]);
  }

  /** OrderCreated for our address gives the new order id; OrdersCanceled lists what the tx removed. status 0x0: nothing changed on the book. */
  private parseReceipt(r: any, p: Pending): QuoteResult {
    if (r.effectiveGasPrice) this.feeWei = BN.from(r.effectiveGasPrice);
    const gasMon = this.gasMon(p.gasLimit, BN.from(r.effectiveGasPrice ?? this.feeWei));
    const me = this.wallet!.address.toLowerCase();
    let orderId: number | null = null;
    const canceled: number[] = [];
    if (r.status !== "0x0") {
      for (const log of r.logs ?? []) {
        let ev; try { ev = this.iface.parseLog(log); } catch { continue; }
        if (ev.name === "OrderCreated" && String(ev.args.owner).toLowerCase() === me) orderId = Number(ev.args.orderId);
        if (ev.name === "OrdersCanceled" && String(ev.args.owner).toLowerCase() === me) for (const id of ev.args.orderId) canceled.push(Number(id));
      }
    }
    const status: Quote["status"] = r.status === "0x0" ? "reverted" : "placed";
    return { block: p.block, quote: { ...p.quote, status, orderId, gasMon }, canceled };
  }

  /** Top the margin account up to MARGIN_MON / MARGIN_USDC. Runs once at startup, awaiting each receipt. */
  private async ensureMargin() {
    const w = this.wallet!;
    const baseDec = this.params.baseAssetDecimals.toNumber(), quoteDec = this.params.quoteAssetDecimals.toNumber();
    const [monBal, usdcBal] = await Promise.all([this.marginBalance(ZERO_ADDRESS), this.marginBalance(this.params.quoteAssetAddress)]);
    const mon = Number(ethers.utils.formatUnits(monBal, baseDec)), usdc = Number(ethers.utils.formatUnits(usdcBal, quoteDec));
    const deposit = async (token: string, amount: ethers.BigNumber, native: boolean) => {
      const tx = await w.sendTransaction({
        to: config.marginAccount, nonce: this.nonce++, value: native ? amount : BN.from(0),
        data: this.marginIface.encodeFunctionData("deposit", [w.address, token, amount]),
      });
      await tx.wait(1);
    };
    if (mon < config.marginMon) {
      const amt = ethers.utils.parseUnits((config.marginMon - mon).toFixed(6), baseDec);
      console.log(`margin: depositing ${ethers.utils.formatUnits(amt, baseDec)} MON`);
      await deposit(ZERO_ADDRESS, amt, true);
    }
    if (usdc < config.marginUsdc) {
      const token = new ethers.Contract(this.params.quoteAssetAddress, ERC20_ABI, w);
      const amt = ethers.utils.parseUnits((config.marginUsdc - usdc).toFixed(quoteDec), quoteDec);
      const have: ethers.BigNumber = await token.balanceOf(w.address);
      if (have.lt(amt)) {
        console.warn(`margin: wallet has ${ethers.utils.formatUnits(have, quoteDec)} USDC, wanted to deposit ${ethers.utils.formatUnits(amt, quoteDec)}; depositing what is there`);
      }
      const dep = have.lt(amt) ? have : amt;
      if (dep.gt(0)) {
        const allowance: ethers.BigNumber = await token.allowance(w.address, config.marginAccount);
        if (allowance.lt(dep)) { const tx = await token.approve(config.marginAccount, ethers.constants.MaxUint256, { nonce: this.nonce++ }); await tx.wait(1); }
        console.log(`margin: depositing ${ethers.utils.formatUnits(dep, quoteDec)} USDC`);
        await deposit(this.params.quoteAssetAddress, dep, false);
      }
    }
    await this.refresh();
    console.log(`margin · ${this.funds.mon.toFixed(2)} MON · ${this.funds.quote.toFixed(2)} USDC`);
  }

  private async marginBalance(token: string): Promise<ethers.BigNumber> {
    const data = this.marginIface.encodeFunctionData("getBalance", [this.wallet!.address, token]);
    const res = await rpc<string>("eth_call", [{ to: config.marginAccount, data }, "latest"], config.readRpcUrl);
    return BN.from(res);
  }

  /**
   * One eth_estimateGas at startup for a post-only place with no cancels, plus headroom for the one
   * or two cancels a normal block carries, x1.15. Never in the hot loop. Needs margin funds to succeed.
   */
  private async initGasLimit() {
    if (config.gasLimit) { this.gasLimit = BN.from(config.gasLimit); }
    else {
      try {
        const book = await this.readBook();
        const side: Side = this.funds.quote >= config.tradeSize * book.ask ? "buy" : "sell";
        const data = this.encode(side, config.tradeSize, this.quotePrice(side, book), []);
        const est = await this.provider.estimateGas({ to: config.market, from: this.wallet!.address, data });
        this.gasLimit = est.add(90_000).mul(115).div(100);
      } catch (e) {
        console.warn(`gas estimate failed (${(e as Error).message.slice(0, 120)}); using ${config.gasLimitFallback}`);
      }
    }
    const perBlock = this.gasMon(this.gasLimit, this.feeWei);
    console.log(`gas limit ${this.gasLimit} · maxFee ${config.maxFeeGwei} gwei · priority ${config.priorityFeeGwei} gwei · ~${perBlock.toFixed(4)} MON per block, ~${(perBlock * 12_000).toFixed(0)} MON per hour`);
  }

  private gasMon(limit: ethers.BigNumber, feeWei: ethers.BigNumber) {
    return Number(ethers.utils.formatEther(limit.mul(feeWei)));
  }

  private async resyncNonce() {
    this.nonce = parseInt(await rpc<string>("eth_getTransactionCount", [this.wallet!.address, "latest"]), 16);
  }
}
