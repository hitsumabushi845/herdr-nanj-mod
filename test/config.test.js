import { describe, it, expect } from "vitest";
import { DEFAULTS, parseConfig } from "../mods/nanj/config.js";

describe("parseConfig", () => {
  it("ファイルがなければ既定値を返す", () => {
    expect(parseConfig(null)).toEqual(DEFAULTS);
  });
  it("壊れた JSON は既定値にする", () => {
    expect(parseConfig("{ 壊れた")).toEqual(DEFAULTS);
    expect(parseConfig("[1,2]")).toEqual(DEFAULTS);
    expect(parseConfig("null")).toEqual(DEFAULTS);
  });
  it("型や値が合わないキーだけ既定値にする", () => {
    expect(parseConfig('{"model":"sonnet","palette":"neon","min_interval_sec":"x","enabled":"yes"}'))
      .toEqual({ ...DEFAULTS, model: "sonnet" });
  });
  it("間隔と上限に下限を掛ける", () => {
    expect(parseConfig('{"min_interval_sec":5}').min_interval_sec).toBe(30);
    expect(parseConfig('{"max_calls_per_hour":3}').max_calls_per_hour).toBe(10);
    expect(parseConfig('{"chat_interval_min":-1}').chat_interval_min).toBe(0);
  });
  it("雑談の間隔 0 を受け付ける", () => {
    expect(parseConfig('{"chat_interval_min":0}').chat_interval_min).toBe(0);
  });
  it("exclude_spaces は文字列だけ残す", () => {
    expect(parseConfig('{"exclude_spaces":["a",1]}').exclude_spaces).toEqual(["a"]);
    expect(parseConfig('{"exclude_spaces":"a"}').exclude_spaces).toEqual([]);
  });
  it("有効な値を受け付ける", () => {
    expect(parseConfig('{"enabled":false,"palette":"theme","min_interval_sec":120}'))
      .toEqual({ ...DEFAULTS, enabled: false, palette: "theme", min_interval_sec: 120 });
  });
  it("既定値の配列を書き換えられても次の呼び出しに残らない", () => {
    parseConfig(null).exclude_spaces.push("x");
    expect(parseConfig(null).exclude_spaces).toEqual([]);
  });
});
