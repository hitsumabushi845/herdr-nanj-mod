import { describe, it, expect } from "vitest";
import { YAJIUMA_NAME } from "../mods/nanj/names.js";
import {
  newThread, append, isFull, stamp, shortStamp, segments, serialize, deserialize, MAX_POSTS, COLOR_SLOTS,
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
  it("1000 レスを超える分は足さない", () => {
    expect(MAX_POSTS).toBe(1000);
    let full = newThread(0);
    for (let i = 0; i < 999; i++) full = append(full, [{ who: "yajiuma", body: "x" }], null, i, zero);
    expect(isFull(full)).toBe(false);
    full = append(full, [{ who: "yajiuma", body: "y" }, { who: "yajiuma", body: "z" }], null, 1000, zero);
    expect(full.posts.length).toBe(1000);
    expect(full.posts.at(-1).body).toBe("y");
    expect(isFull(full)).toBe(true);
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

describe("保存の形", () => {
  const t = append({ ...newThread(1), title: "【悲報】テスト" }, [{ who: "agent", body: "a" }], api, 5, zero);
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
