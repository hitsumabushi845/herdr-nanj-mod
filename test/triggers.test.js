import { describe, it, expect } from "vitest";
import { DEFAULTS } from "../mods/nanj/config.js";
import {
  initialState, observe, pick, commit, drop, workingSince,
  WAIT_FIRST_MS,
} from "../mods/nanj/triggers.js";

const cfg = { ...DEFAULTS };
const quiet = { ...DEFAULTS, chat_interval_min: 0 };
const w = (address, key) => ({ address, status: "working", key });
const st = (address, status) => ({ address, status, key: null });
const progress = (address) => ({ kind: "progress", address });

describe("進捗", () => {
  it("初めて見た作業中の Agent は、すぐ進捗になる", () => {
    const s = observe(initialState(), [w("t1", "k1")], 0);
    expect(pick(s, 0, cfg)).toEqual(progress("t1"));
  });
  it("画面が変わっても 90 秒は空ける", () => {
    let s = commit(observe(initialState(), [w("t1", "k1")], 0), progress("t1"), 0);
    s = observe(s, [w("t1", "k2")], 60000);
    expect(pick(s, 60000, cfg)).toBeNull();
    s = observe(s, [w("t1", "k2")], 90000);
    expect(pick(s, 90000, cfg)).toEqual(progress("t1"));
  });
  it("画面が変わらなければ進捗にならない", () => {
    let s = commit(observe(initialState(), [w("t1", "k1")], 0), progress("t1"), 0);
    s = observe(s, [w("t1", "k1")], 100000);
    expect(pick(s, 100000, quiet)).toBeNull();
  });
  it("最後のレスが古い Agent から選ぶ", () => {
    let s = observe(initialState(), [w("t1", "a"), w("t2", "a")], 0);
    s = commit(s, progress("t1"), 0);
    s = commit(s, progress("t2"), 30000);
    s = observe(s, [w("t1", "b"), w("t2", "b")], 200000);
    expect(pick(s, 200000, cfg)).toEqual(progress("t1"));
    s = commit(s, progress("t1"), 200000);
    expect(pick(s, 200000, cfg)).toEqual(progress("t2"));
  });
});

describe("待ち", () => {
  it("画面が変わらないまま 3 分で待ちになり、次は 6 分後", () => {
    expect(WAIT_FIRST_MS).toBe(180000);
    let s = commit(observe(initialState(), [w("t1", "k1")], 0), progress("t1"), 0);
    expect(pick(observe(s, [w("t1", "k1")], 179000), 179000, quiet)).toBeNull();
    s = observe(s, [w("t1", "k1")], 180000);
    expect(pick(s, 180000, quiet)).toEqual({ kind: "wait", address: "t1" });
    s = commit(s, { kind: "wait", address: "t1" }, 180000);
    expect(pick(observe(s, [w("t1", "k1")], 539000), 539000, quiet)).toBeNull();
    expect(pick(observe(s, [w("t1", "k1")], 540000), 540000, quiet)).toEqual({ kind: "wait", address: "t1" });
  });
  it("画面が変わると待ちの間隔が 3 分に戻る", () => {
    let s = commit(observe(initialState(), [w("t1", "k1")], 0), progress("t1"), 0);
    s = commit(observe(s, [w("t1", "k1")], 180000), { kind: "wait", address: "t1" }, 180000);
    s = commit(observe(s, [w("t1", "k2")], 300000), progress("t1"), 300000);
    expect(pick(observe(s, [w("t1", "k2")], 479000), 479000, quiet)).toBeNull();
    expect(pick(observe(s, [w("t1", "k2")], 480000), 480000, quiet)).toEqual({ kind: "wait", address: "t1" });
  });
});

describe("状態の変化", () => {
  it("working から idle は完了、blocked は入力待ちで、進捗より先に出る", () => {
    let s = commit(observe(initialState(), [w("t1", "k1"), w("t2", "k1")], 0), progress("t1"), 0);
    s = observe(s, [st("t1", "idle"), w("t2", "k1")], 1000);
    expect(pick(s, 1000, cfg)).toEqual({ kind: "done", address: "t1" });
    s = observe(s, [st("t1", "idle"), st("t2", "blocked")], 2000);
    s = commit(s, { kind: "done", address: "t1" }, 2000);
    expect(pick(s, 2000, cfg)).toEqual({ kind: "blocked", address: "t2" });
    s = commit(s, { kind: "blocked", address: "t2" }, 2000);
    expect(pick(s, 2000, cfg)).toBeNull();
  });
  it("working から done も完了", () => {
    const s = observe(observe(initialState(), [w("t1", "k1")], 0), [st("t1", "done")], 1000);
    expect(pick(s, 1000, cfg)).toEqual({ kind: "done", address: "t1" });
  });
  it("done から idle への変化はきっかけにならない", () => {
    let s = observe(observe(initialState(), [w("t1", "k1")], 0), [st("t1", "done")], 1000);
    s = commit(s, { kind: "done", address: "t1" }, 1000);
    s = observe(s, [st("t1", "idle")], 2000);
    expect(pick(s, 2000, cfg)).toBeNull();
  });
  it("同じ状態を何度見ても、きっかけは 1 つ", () => {
    let s = observe(initialState(), [w("t1", "k1")], 0);
    s = observe(s, [st("t1", "blocked")], 1000);
    s = observe(s, [st("t1", "blocked")], 2000);
    s = commit(s, { kind: "blocked", address: "t1" }, 2000);
    expect(pick(s, 2000, cfg)).toBeNull();
  });
  it("初めて見た idle や blocked の Agent はきっかけにならない", () => {
    const s = observe(initialState(), [st("t9", "idle"), st("t8", "blocked")], 0);
    expect(pick(s, 99999999, cfg)).toBeNull();
  });
  it("完了のレスを作る前に作業に戻ったら、完了のきっかけを捨てる", () => {
    let s = commit(observe(initialState(), [w("t1", "k1")], 0), progress("t1"), 0);
    s = observe(s, [st("t1", "idle")], 1000);
    s = observe(s, [w("t1", "k1")], 2000);
    expect(pick(s, 2000, quiet)).toBeNull();
  });
  it("一覧から消えた Agent のきっかけは残らない", () => {
    let s = observe(initialState(), [w("t1", "k1")], 0);
    s = observe(s, [st("t1", "idle")], 1000);
    s = observe(s, [], 2000);
    expect(pick(s, 2000, cfg)).toBeNull();
  });
  it("drop は待ち行列から外す", () => {
    let s = observe(observe(initialState(), [w("t1", "k1")], 0), [st("t1", "idle")], 1000);
    s = drop(s, { kind: "done", address: "t1" });
    expect(pick(s, 1000, cfg)).toBeNull();
  });
});

describe("雑談", () => {
  it("作業中の Agent があるとき、10 分に 1 回", () => {
    let s = commit(observe(initialState(), [w("t1", "k1")], 0), progress("t1"), 0);
    s = commit(observe(s, [w("t1", "k1")], 180000), { kind: "wait", address: "t1" }, 180000);
    expect(pick(observe(s, [w("t1", "k1")], 539000), 539000, cfg)).toBeNull();
    s = commit(observe(s, [w("t1", "k1")], 540000), { kind: "wait", address: "t1" }, 540000);
    s = observe(s, [w("t1", "k1")], 600000);
    expect(pick(s, 600000, cfg)).toEqual({ kind: "chat", address: "t1" });
    s = commit(s, { kind: "chat", address: "t1" }, 600000);
    expect(pick(s, 600000, cfg)).toBeNull();
  });
  it("作業中の Agent のうち、最後のレスが古いほうのスレッドに書く", () => {
    const c = { ...cfg, min_interval_sec: 30, chat_interval_min: 1 };
    let s = observe(initialState(), [w("t1", "a"), w("t2", "a")], 0);
    s = commit(s, progress("t1"), 0);
    s = commit(s, progress("t2"), 30000);
    s = observe(s, [w("t1", "a"), w("t2", "a")], 100000);
    expect(pick(s, 100000, c)).toEqual({ kind: "chat", address: "t1" });
  });
  it("雑談を commit しても、その Agent のレスの間隔は延びない", () => {
    const c = { ...cfg, min_interval_sec: 30, chat_interval_min: 1 };
    let s = commit(observe(initialState(), [w("t1", "a")], 0), progress("t1"), 0);
    s = observe(s, [w("t1", "a")], 100000);
    const after = commit(s, { kind: "chat", address: "t1" }, 100000);
    expect(after.agents.t1.lastPostAt).toBe(0);
    expect(after.lastChatAt).toBe(100000);
    expect(pick(after, 100000, c)).toBeNull();
  });
  it("作業中でない Agent のスレッドには書かない", () => {
    const c = { ...cfg, chat_interval_min: 1 };
    let s = observe(initialState(), [st("t1", "idle"), w("t2", "a")], 0);
    s = commit(s, progress("t2"), 0);
    s = observe(s, [st("t1", "idle"), w("t2", "a")], 100000);
    expect(pick(s, 100000, c)).toEqual({ kind: "chat", address: "t2" });
  });
  it("作業中の Agent がなければ出ない", () => {
    const s = observe(observe(initialState(), [st("t1", "idle")], 0), [st("t1", "idle")], 6000000);
    expect(pick(s, 6000000, cfg)).toBeNull();
  });
  it("間隔が 0 なら出ない", () => {
    let s = commit(observe(initialState(), [w("t1", "k1")], 0), progress("t1"), 0);
    s = observe(s, [w("t1", "k1")], 100000);
    expect(pick(s, 100000, quiet)).toBeNull();
  });
});

describe("スレッドの切り替え", () => {
  it("きっかけの状態は、スレッドの立て直しを求める関数を持たない", async () => {
    const mod = await import("../mods/nanj/triggers.js");
    expect(mod.wantsRotate).toBeUndefined();
    expect(mod.clearRotate).toBeUndefined();
    expect(mod.ROTATE_IDLE_MS).toBeUndefined();
  });
});

describe("workingSince", () => {
  it("working になったのを最初に見た時刻を返す", () => {
    let s = observe(initialState(), [w("t1", "k1")], 5000);
    s = observe(s, [w("t1", "k2")], 9000);
    expect(workingSince(s, "t1")).toBe(5000);
    s = observe(s, [st("t1", "idle")], 10000);
    expect(workingSince(s, "t1")).toBeNull();
    expect(workingSince(s, "nope")).toBeNull();
  });
});

describe("状態を書き換えない", () => {
  it("observe と commit は元の状態を変えない", () => {
    const s0 = observe(initialState(), [w("t1", "k1")], 0);
    const snap = JSON.stringify(s0);
    commit(s0, progress("t1"), 0);
    observe(s0, [st("t1", "idle")], 1);
    expect(JSON.stringify(s0)).toBe(snap);
  });
});
