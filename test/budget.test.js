import { describe, it, expect } from "vitest";
import { canCall, record, MIN_GAP_MS, WINDOW_MS, RESERVED } from "../mods/nanj/budget.js";

const every = (n, step) => Array.from({ length: n }, (_, i) => i * step);

describe("canCall", () => {
  it("記録がなければ呼べる", () => {
    expect(canCall([], "progress", 0, 60)).toBe(true);
  });
  it("前の呼び出しから 20 秒は呼べない", () => {
    expect(MIN_GAP_MS).toBe(20000);
    expect(canCall([0], "progress", 19999, 60)).toBe(false);
    expect(canCall([0], "done", 19999, 60)).toBe(false);
    expect(canCall([0], "progress", 20000, 60)).toBe(true);
  });
  it("直近 60 分で 50 回に達すると、進捗、待ち、雑談は呼べない", () => {
    expect(RESERVED).toBe(10);
    const fifty = every(50, 30000);
    const now = 50 * 30000 + 20000;
    expect(canCall(fifty, "progress", now, 60)).toBe(false);
    expect(canCall(fifty, "wait", now, 60)).toBe(false);
    expect(canCall(fifty, "chat", now, 60)).toBe(false);
    expect(canCall(fifty.slice(1), "progress", now, 60)).toBe(true);
  });
  it("残りの 10 回は完了と入力待ちに使える", () => {
    const fifty = every(50, 30000);
    const now = 50 * 30000 + 20000;
    expect(canCall(fifty, "done", now, 60)).toBe(true);
    expect(canCall(fifty, "blocked", now, 60)).toBe(true);
    expect(canCall(every(60, 30000), "done", 60 * 30000 + 20000, 60)).toBe(false);
  });
  it("60 分より前の呼び出しは数えない", () => {
    expect(canCall(every(50, 30000), "progress", WINDOW_MS + 20001, 60)).toBe(true);
  });
  it("上限は設定の値に従う", () => {
    expect(canCall(every(20, 30000), "progress", 20 * 30000 + 20000, 30)).toBe(false);
    expect(canCall(every(20, 30000), "done", 20 * 30000 + 20000, 30)).toBe(true);
  });
});

describe("record", () => {
  it("60 分より古い記録を落として今の時刻を足す", () => {
    expect(record([0, 10], WINDOW_MS + 5)).toEqual([10, WINDOW_MS + 5]);
  });
  it("元の配列を変えない", () => {
    const calls = [1];
    record(calls, 2);
    expect(calls).toEqual([1]);
  });
});
