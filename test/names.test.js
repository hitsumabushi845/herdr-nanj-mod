import { describe, it, expect } from "vitest";
import { agentNames, yajiumaId, YAJIUMA_NAME } from "../mods/nanj/names.js";

const a = (address, space, space_name, tab_name) => ({ address, space, space_name, tab_name });

describe("agentNames", () => {
  it("space に Agent が 1 つなら space の名前にする", () => {
    expect(agentNames([a("t1", "s1", "api", "1")])).toEqual({ t1: "api" });
  });
  it("同じ space に 2 つ以上あれば tab の名前を付ける", () => {
    expect(agentNames([a("t1", "s1", "api", "1"), a("t2", "s1", "api", "fix"), a("t3", "s2", "web", "1")]))
      .toEqual({ t1: "api/1", t2: "api/fix", t3: "web" });
  });
  it("名前が同じでも space が別なら tab を付けない", () => {
    expect(agentNames([a("t1", "s1", "api", "1"), a("t2", "s2", "api", "1")])).toEqual({ t1: "api", t2: "api" });
  });
  it("24 字で切る", () => {
    expect(agentNames([a("t1", "s1", "[API Auth]sample-terraform", "1")]).t1).toBe("[API Auth]sample-terrafo");
  });
  it("コードポイントで数える", () => {
    expect(Array.from(agentNames([a("t1", "s1", "🍣".repeat(30), "1")]).t1).length).toBe(24);
  });
  it("空の一覧は空を返す", () => {
    expect(agentNames([])).toEqual({});
  });
});

describe("yajiumaId", () => {
  it("英数字 5 字を返す", () => {
    expect(yajiumaId(() => 0)).toMatch(/^[A-Za-z0-9]{5}$/);
    expect(yajiumaId(() => 0.999999)).toMatch(/^[A-Za-z0-9]{5}$/);
    expect(yajiumaId(Math.random)).toMatch(/^[A-Za-z0-9]{5}$/);
  });
  it("野次馬の名前は風吹けば名無し", () => {
    expect(YAJIUMA_NAME).toBe("風吹けば名無し");
  });
});
