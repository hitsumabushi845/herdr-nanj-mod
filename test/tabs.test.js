import { describe, it, expect } from "vitest";
import { newThread } from "../mods/nanj/thread.js";
import { unread, selectTab, buildTabs, markSeen } from "../mods/nanj/tabs.js";

const th = (key, nos, color = 1) => ({
  ...newThread(0, { key, address: key.split("@")[0], name: "n", color }),
  posts: nos.map((no) => ({ no, name: "n", id: "i", agent: null, at: no, body: "b" })),
});

describe("unread", () => {
  it("最後に見た番号より大きいレスを数える", () => {
    expect(unread(th("t1@1", [1, 2, 3]), 1)).toBe(2);
    expect(unread(th("t1@1", [1, 2, 3]), 3)).toBe(0);
  });
  it("見たことがなければ全レス", () => {
    expect(unread(th("t1@1", [1, 2, 3]), undefined)).toBe(3);
  });
  it("連番でない番号（移行したスレッド）でも数えられる", () => {
    expect(unread(th("t1@1", [5, 9]), 5)).toBe(1);
  });
  it("次スレで番号が 1 に戻ったら、戻ったあとのレスをすべて数える", () => {
    expect(unread(th("t1@1", [1, 2]), 50)).toBe(2);
  });
  it("スレッドがなければ 0", () => {
    expect(unread(null, 3)).toBe(0);
    expect(unread(undefined, undefined)).toBe(0);
  });
});

describe("selectTab", () => {
  it("覚えたキーが起動していれば、そのまま選ぶ", () => {
    expect(selectTab("b", ["a", "b"])).toEqual({ key: "b", save: false });
  });
  it("覚えたキーが起動していなければ、先頭を選んで覚え直す", () => {
    expect(selectTab("gone", ["a", "b"])).toEqual({ key: "a", save: true });
    expect(selectTab(undefined, ["a"])).toEqual({ key: "a", save: true });
    expect(selectTab({ x: 1 }, ["a"])).toEqual({ key: "a", save: true });
  });
  it("起動している Agent がないときは、覚えた値を書き換えない", () => {
    expect(selectTab("b", [])).toEqual({ key: null, save: false });
  });
  it("キーをまだ読めていない Agent がある間は、覚えたキーがなくても替えない", () => {
    expect(selectTab("c", ["a", "b"], true)).toEqual({ key: null, save: false });
    expect(selectTab("b", ["a", "b"], true)).toEqual({ key: "b", save: false });
    expect(selectTab(undefined, ["a"], true)).toEqual({ key: "a", save: false });
    expect(selectTab("c", ["a", "b"], false)).toEqual({ key: "a", save: true });
  });
  it("並びが変わっても、選んだキーは替わらない", () => {
    expect(selectTab("b", ["c", "a", "b"])).toEqual({ key: "b", save: false });
  });
});

describe("buildTabs", () => {
  const agents = [
    { key: "t1@1", address: "t1", status: "working" },
    { key: null, address: "t9", status: "idle" },
    { key: "t2@2", address: "t2", status: "blocked" },
  ];
  const threads = { "t1@1": th("t1@1", [1, 2], 4), "t2@2": th("t2@2", [1, 2, 3], 6) };
  it("キーの付いた Agent を、渡された順にタブにする", () => {
    expect(buildTabs(agents, { t1: "api", t2: "web", t9: "x" }, threads, { "t2@2": 1 }, "t1@1")).toEqual([
      { key: "t1@1", address: "t1", name: "api", status: "working", color: 4, unread: 0, selected: true },
      { key: "t2@2", address: "t2", name: "web", status: "blocked", color: 6, unread: 2, selected: false },
    ]);
  });
  it("選んでいるタブの未読は 0", () => {
    expect(buildTabs(agents, {}, threads, {}, "t2@2")[1]).toMatchObject({ unread: 0, selected: true });
    expect(buildTabs(agents, {}, threads, {}, "t2@2")[0]).toMatchObject({ unread: 2, selected: false });
  });
  it("スレッドがまだない Agent は、色なし、未読 0", () => {
    expect(buildTabs([{ key: "t3@3", address: "t3", status: "idle" }], { t3: "new" }, {}, {}, null)[0])
      .toEqual({ key: "t3@3", address: "t3", name: "new", status: "idle", color: null, unread: 0, selected: false });
  });
  it("名前がわからなければアドレスを出す", () => {
    expect(buildTabs([{ key: "t3@3", address: "t3", status: "idle" }], {}, {}, {}, null)[0].name).toBe("t3");
  });
  it("壊れた既読の値でも落ちない", () => {
    expect(buildTabs(agents, {}, threads, null, null)[0].unread).toBe(2);
    expect(buildTabs(agents, {}, threads, { "t1@1": "x" }, null)[0].unread).toBe(2);
  });
});

describe("markSeen", () => {
  it("表示中のスレッドの最後の番号を既読にする", () => {
    expect(markSeen({}, "t1@1", th("t1@1", [1, 2]))).toEqual({ "t1@1": 2 });
    expect(markSeen({ a: 1 }, "t1@1", th("t1@1", [7]))).toEqual({ a: 1, "t1@1": 7 });
  });
  it("変える必要がなければ null", () => {
    expect(markSeen({ "t1@1": 2 }, "t1@1", th("t1@1", [1, 2]))).toBeNull();
    expect(markSeen({ a: 1 }, "t1@1", null)).toBeNull();
    expect(markSeen({}, "t1@1", th("t1@1", []))).toBeNull();
    expect(markSeen({}, null, th("t1@1", [1]))).toBeNull();
  });
  it("壊れた既読の値は作り直す", () => {
    expect(markSeen(null, "t1@1", th("t1@1", [1]))).toEqual({ "t1@1": 1 });
    expect(markSeen("x", "t1@1", th("t1@1", [1]))).toEqual({ "t1@1": 1 });
  });
  it("次スレで番号が戻ったら、既読の位置も戻す", () => {
    expect(markSeen({ "t1@1": 50 }, "t1@1", th("t1@1", [1]))).toEqual({ "t1@1": 1 });
  });
});
