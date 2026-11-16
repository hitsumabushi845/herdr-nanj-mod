import { describe, it, expect } from "vitest";
import { YAJIUMA_NAME } from "../mods/nanj/names.js";
import {
  newThread, append, nextNo, setTitle, stamp, shortStamp, segments, serialize, deserialize, MAX_POSTS, COLOR_SLOTS,
} from "../mods/nanj/thread.js";

const api = { address: "t17", name: "api" };
const zero = () => 0;

describe("append", () => {
  it("Agent 本人はコテハンと端末のアドレス、野次馬は名無しとランダムな ID で書き込む", () => {
    const t = append(newThread(0), [{ who: "agent", body: "a" }, { who: "yajiuma", body: ">>1 草" }], api, 5, zero);
    expect(t.posts).toEqual([
      { no: 1, name: "api", id: "t17", agent: "t17", at: 5, body: "a" },
      { no: 2, name: YAJIUMA_NAME, id: expect.stringMatching(/^[A-Za-z0-9]{5}$/), agent: null, at: 5, body: ">>1 草" },
    ]);
  });
  it("初めて書いた順に Agent の色を割り当て、同じ Agent は同じ色のまま", () => {
    let t = append(newThread(0), [{ who: "agent", body: "a" }], api, 5, zero);
    t = append(t, [{ who: "agent", body: "b" }], { address: "t11", name: "web" }, 6, zero);
    t = append(t, [{ who: "agent", body: "c" }], api, 7, zero);
    expect(t.colors).toEqual({ t17: 0, t11: 1 });
  });
  it("色は 8 つで一巡する", () => {
    expect(COLOR_SLOTS).toBe(8);
    let t = newThread(0);
    for (let i = 0; i < 9; i++) t = append(t, [{ who: "agent", body: "x" }], { address: `t${i}`, name: "n" }, i, zero);
    expect(t.colors.t8).toBe(0);
  });
  it("野次馬だけのレスでは色を割り当てない", () => {
    expect(append(newThread(0), [{ who: "yajiuma", body: "x" }], api, 1, zero).colors).toEqual({});
  });
  it("雑談（Agent なし）のレスはすべて野次馬になる", () => {
    const t = append(newThread(0), [{ who: "agent", body: "c" }], null, 7, zero);
    expect(t.posts[0]).toMatchObject({ name: YAJIUMA_NAME, agent: null });
  });
  it("1000 レスを超えたら古いレスから落とし、番号は続ける", () => {
    expect(MAX_POSTS).toBe(1000);
    let t = newThread(0);
    for (let i = 0; i < 999; i++) t = append(t, [{ who: "yajiuma", body: "x" }], null, i, zero);
    t = append(t, [{ who: "yajiuma", body: "y" }, { who: "yajiuma", body: "z" }], null, 1000, zero);
    expect(t.posts.length).toBe(1000);
    expect(t.posts[0].no).toBe(2);
    expect(t.posts.at(-2)).toMatchObject({ no: 1000, body: "y" });
    expect(t.posts.at(-1)).toMatchObject({ no: 1001, body: "z" });
    t = append(t, [{ who: "agent", body: "次" }], api, 1001, zero);
    expect(t.posts.at(-1).no).toBe(1002);
    expect(t.posts[0].no).toBe(3);
  });
  it("nextNo は次に付く番号を返す", () => {
    expect(nextNo(newThread(0))).toBe(1);
    expect(nextNo(append(newThread(0), [{ who: "yajiuma", body: "x" }], null, 1, zero))).toBe(2);
  });
  it("元のスレッドを変えない", () => {
    const t0 = newThread(0);
    append(t0, [{ who: "agent", body: "a" }], api, 5, zero);
    expect(t0).toEqual(newThread(0));
  });
});

describe("segments", () => {
  it("アンカーとそれ以外に分ける", () => {
    expect(segments(">>12 >>13 明暗分かれてて草")).toEqual([
      { text: ">>12", anchor: 12 }, { text: " ", anchor: null }, { text: ">>13", anchor: 13 }, { text: " 明暗分かれてて草", anchor: null }]);
  });
  it("アンカーがなければ 1 つ", () => {
    expect(segments("草")).toEqual([{ text: "草", anchor: null }]);
    expect(segments("")).toEqual([]);
  });
});

describe("stamp", () => {
  it("2ch の書式でローカル時刻を返す", () => {
    expect(stamp(new Date(2026, 10, 16, 19, 32, 10).getTime())).toBe("2026/11/16(月) 19:32:10");
    expect(stamp(new Date(2027, 0, 3, 5, 4, 3).getTime())).toBe("2027/01/03(日) 05:04:03");
  });
  it("短い書式は時刻だけ", () => {
    expect(shortStamp(new Date(2027, 0, 3, 5, 4, 3).getTime())).toBe("05:04:03");
  });
});

describe("スレタイ", () => {
  it("新しいスレッドはスレタイも付けた時刻も持たない", () => {
    expect(newThread(3)).toMatchObject({ title: null, titleAt: null });
  });
  it("setTitle はスレタイと付けた時刻を入れる", () => {
    const t = setTitle(newThread(0), "【朗報】題", 99);
    expect(t).toMatchObject({ title: "【朗報】題", titleAt: 99 });
    expect(newThread(0).title).toBeNull();
  });
  it("付けた時刻のない保存データは、スレッドの開始時刻を使う", () => {
    const old = '{"v":1,"title":"前からの題","startedAt":5,"posts":[],"colors":{}}';
    expect(deserialize(old, 9)).toMatchObject({ title: "前からの題", titleAt: 5 });
    expect(deserialize('{"v":1,"title":"x","titleAt":"bad","startedAt":5,"posts":[],"colors":{}}', 9)).toEqual(newThread(9));
  });
});

describe("保存の形", () => {
  const t = append(setTitle(newThread(1), "【悲報】テスト", 2), [{ who: "agent", body: "a" }], api, 5, zero);
  it("書いて読むと元に戻る", () => {
    expect(deserialize(serialize(t), 9)).toEqual(t);
  });
  it("ファイルがない、壊れている、形が違うときは新しいスレッドにする", () => {
    expect(deserialize(null, 9)).toEqual(newThread(9));
    expect(deserialize("{壊れた", 9)).toEqual(newThread(9));
    expect(deserialize('{"v":2,"posts":"x"}', 9)).toEqual(newThread(9));
    expect(deserialize('{"v":1,"title":null,"startedAt":1,"posts":[{"no":"x"}],"colors":{}}', 9)).toEqual(newThread(9));
    expect(deserialize('{"v":1,"title":3,"startedAt":1,"posts":[],"colors":[]}', 9)).toEqual(newThread(9));
  });
});
