// モデルの呼び出しの上限。

/** @typedef {"progress" | "wait" | "chat" | "done" | "blocked"} Kind */

export const MIN_GAP_MS = 20000;
export const WINDOW_MS = 3600000;
export const RESERVED = 10;

const inWindow = (calls, now) => calls.filter((t) => now - t < WINDOW_MS);

/**
 * 今このきっかけでモデルを呼んでよいか。
 * @param {number[]} calls これまでの呼び出しの時刻
 * @param {Kind} kind
 * @param {number} now
 * @param {number} max 直近 60 分の上限。うち RESERVED 回は完了と入力待ちにだけ使う
 */
export function canCall(calls, kind, now, max) {
  const recent = inWindow(calls, now);
  if (recent.length > 0 && now - Math.max(...recent) < MIN_GAP_MS) return false;
  const limit = kind === "done" || kind === "blocked" ? max : max - RESERVED;
  return recent.length < limit;
}

/**
 * 呼び出しを記録する。60 分より古い記録は落とす。
 * @param {number[]} calls
 * @param {number} now
 * @returns {number[]}
 */
export function record(calls, now) {
  return [...inWindow(calls, now), now];
}
