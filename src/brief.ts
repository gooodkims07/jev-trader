/**
 * The daily market brief for the coin-trade office: OKX public data on the traded coin, BTC and ETH, a few
 * notes on what they mean for the bot (range or trend, crowded side, funding), and the day's headlines from
 * crypto news RSS feeds. Sent as an alert (sender "시황 리포트"), so the office files it under market news.
 * Facts only, no advice: the bot's decisions stay Jev's.
 */
const OKX = "https://www.okx.com";
const FEEDS = ["https://cointelegraph.com/rss", "https://www.coindesk.com/arc/outboundfeeds/rss/", "https://decrypt.co/feed"];

async function okx<T>(path: string, q: Record<string, string>): Promise<T> {
  const r = await fetch(`${OKX}${path}?${new URLSearchParams(q)}`, { signal: AbortSignal.timeout(8000) });
  const j = (await r.json()) as { code: string; msg: string; data: T };
  if (j.code !== "0") throw new Error(`okx ${path}: ${j.code} ${j.msg}`);
  return j.data;
}

type Ticker = { last: string; open24h: string; high24h: string; low24h: string };
const pct = (a: number, b: number) => `${a >= b ? "+" : ""}${((a / b - 1) * 100).toFixed(2)}%`;

/** Headlines of the last 36 h: the coin's first, then macro ones (Bitcoin, the Fed, ETFs, liquidations), then other crypto news. */
export async function headlines(coin: string, max = 4): Promise<string[]> {
  const items: { title: string; ts: number }[] = [];
  await Promise.all(FEEDS.map(async (url) => {
    try {
      const xml = await (await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "user-agent": "Mozilla/5.0 jev-trader" } })).text();
      for (const it of xml.match(/<item>[\s\S]*?<\/item>/g) ?? []) {
        const title = it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1]?.trim();
        const date = Date.parse(it.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "");
        if (title && Date.now() - date < 36 * 3600_000) items.push({ title: title.replace(/&amp;/g, "&").replace(/&#039;|&#8217;/g, "'").replace(/[—–]/g, "-"), ts: date });
      }
    } catch { /* a feed down: the others still count */ }
  }));
  const coinRe = new RegExp(`\\b(${coin}|${coin === "XRP" ? "Ripple" : coin})\\b`, "i");
  const macroRe = /\b(Bitcoin|BTC|Fed|rate|ETF|liquidat|SEC|inflation|Treasury)\b/i;
  const seen = new Set<string>();
  const pick = (re: RegExp) => items.filter((i) => re.test(i.title)).sort((a, b) => b.ts - a.ts).filter((i) => !seen.has(i.title) && seen.add(i.title));
  const cryptoRe = /\b(crypto|coin|token|stablecoin|exchange|blockchain|DeFi|Ethereum|ETH|Solana|hack|wallet|digital (asset|ruble|dollar|euro))/i;
  return [...pick(coinRe), ...pick(macroRe), ...pick(cryptoRe)].slice(0, max).map((i) => i.title);
}

/** The brief for `instId` (e.g. XRP-USDT-SWAP): subject and body, in Korean, prices at `priceDecimals`. */
export async function buildBrief(instId: string, priceDecimals = 4, now = new Date()): Promise<{ subject: string; body: string }> {
  const coin = instId.split("-")[0]!;
  const [[t], [f], days, ls, btc, eth, news] = await Promise.all([
    okx<Ticker[]>("/api/v5/market/ticker", { instId }),
    okx<{ fundingRate: string }[]>("/api/v5/public/funding-rate", { instId }),
    okx<string[][]>("/api/v5/market/candles", { instId, bar: "1D", limit: "8" }),
    okx<string[][]>("/api/v5/rubik/stat/contracts/long-short-account-ratio", { ccy: coin, period: "1H" }).catch(() => [] as string[][]),
    okx<Ticker[]>("/api/v5/market/ticker", { instId: "BTC-USDT-SWAP" }).then((d) => d[0]),
    okx<Ticker[]>("/api/v5/market/ticker", { instId: "ETH-USDT-SWAP" }).then((d) => d[0]),
    headlines(coin),
  ]);
  const px = (x: number) => x.toFixed(priceDecimals);
  const last = Number(t!.last), open = Number(t!.open24h);
  const week = days.slice(0, 7), hi7 = Math.max(...week.map((c) => Number(c[2]))), lo7 = Math.min(...week.map((c) => Number(c[3])));
  const width7 = (hi7 / lo7 - 1) * 100, where = (last - lo7) / (hi7 - lo7 || 1);
  const funding = Number(f?.fundingRate ?? 0) * 100;
  const ratio = ls[0] ? Number(ls[0][1]) : null;

  // What the numbers say, in plain terms (facts, not advice).
  const notes: string[] = [];
  notes.push(width7 < 10 ? `7일 범위 폭 ${width7.toFixed(1)}%: 박스권, 급변 뒤 되돌림이 잘 맞는 장이에요.` : `7일 범위 폭 ${width7.toFixed(1)}%: 움직임이 커서 추세가 이어질 수 있어요.`);
  notes.push(where > 0.8 ? "가격이 7일 범위 위쪽 끝 근처예요." : where < 0.2 ? "가격이 7일 범위 아래쪽 끝 근처예요." : "가격이 7일 범위 가운데쯤이에요.");
  if (ratio !== null && ratio >= 2.5) notes.push(`계정 기준 롱/숏 비율 ${ratio.toFixed(2)}: 롱이 몰려 있어 롱 강제청산이 이어지는 급락에 주의하세요.`);
  else if (ratio !== null && ratio <= 0.6) notes.push(`계정 기준 롱/숏 비율 ${ratio.toFixed(2)}: 숏이 몰려 있어 숏 강제청산이 이어지는 급등에 주의하세요.`);
  if (Math.abs(funding) >= 0.03) notes.push(`펀딩비 ${funding.toFixed(4)}%: 한쪽이 과열돼 있어요.`);

  const date = `${now.getMonth() + 1}월 ${now.getDate()}일`;
  const subject = `[시황] ${date} ${coin} ${px(last)} (${pct(last, open)})`;
  const body = [
    `${date} 시황 요약입니다 (OKX 무기한 선물 기준).`,
    `${coin}: ${px(last)}, 24시간 ${pct(last, open)} (고 ${px(Number(t!.high24h))} / 저 ${px(Number(t!.low24h))}), 7일 범위 ${px(lo7)}~${px(hi7)}, 펀딩비 ${funding.toFixed(4)}%${ratio !== null ? `, 롱/숏 계정 비율 ${ratio.toFixed(2)}` : ""}`,
    `BTC: ${Number(btc!.last).toFixed(0)}, 24시간 ${pct(Number(btc!.last), Number(btc!.open24h))}`,
    `ETH: ${Number(eth!.last).toFixed(1)}, 24시간 ${pct(Number(eth!.last), Number(eth!.open24h))}`,
    `메모: ${notes.join(" ")}`,
    news.length ? `헤드라인:\n${news.map((h) => `- ${h}`).join("\n")}` : "헤드라인: 가져오지 못했어요.",
  ].join("\n");
  return { subject, body };
}
