import { expect, test } from "bun:test";
import { recommendationText, reviewText, type Recommendation } from "./regime";

const rec: Recommendation = {
  date: "2026-10-07", ts: 1, choice: "spike_fade", confidence: 0.55, crowded: 0.91,
  probabilities: { spike_fade: 0.64, band_reversion: 0.3, stand_aside: 0.05, squeeze_breakout: 0.01, trend_follow: 0 },
  regime: {} as Recommendation["regime"],
};

test("recommendation text: the pick first, the others by probability, the crowding, and that nothing switches", () => {
  const t = recommendationText(rec);
  expect(t).toBe("Jev 전략 추천: 급변 되돌림 64% (밴드 평균회귀 30%, 쉬기 5%, 스퀴즈 돌파 1%, 추세 추종 0%). 한쪽 쏠림 위험: 91%. 추천만 하고 전략은 바꾸지 않습니다.");
  expect(/[·—–]/.test(t)).toBe(false);
});

test("review text: each strategy's average since the pick; spike fade counts Jev's and the fade rule's trades", () => {
  const t = reviewText(rec, { jev: { trades: 1, wins: 1, avgPct: 1 }, fade: { trades: 3, wins: 2, avgPct: 0.2 }, band: { trades: 2, wins: 1, avgPct: -0.1 }, trend: { trades: 0, wins: 0, avgPct: 0 }, squeeze: { trades: 0, wins: 0, avgPct: 0 } });
  expect(t).toBe("지난 추천(2026-10-07): 급변 되돌림. 그 뒤 전략별 평균 성적: 급변 되돌림 +0.40% (4건), 밴드 평균회귀 -0.10% (2건), 스퀴즈 돌파 거래 없음, 추세 추종 거래 없음.");
});
