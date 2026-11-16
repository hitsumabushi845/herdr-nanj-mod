import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPT, RESPONSE_SCHEMA, buildUserPrompt, parseResponse } from "../mods/nanj/prompt.js";

const ok = '{"title":"【悲報】ワイ、plan が終わらない","posts":[{"who":"agent","body":"まだ refresh しとるンゴ"}]}';
const posts = (list) => JSON.stringify({ posts: list });
const agent = { name: "api", address: "t17", space: "api", tab: "1", status: "working", workingForSec: 200 };

describe("parseResponse", () => {
  it("JSON を読む", () => {
    expect(parseResponse(ok)).toEqual({ title: "【悲報】ワイ、plan が終わらない", posts: [{ who: "agent", body: "まだ refresh しとるンゴ" }] });
  });
  it("コードの囲みや前後の文があっても読む", () => {
    expect(parseResponse("```json\n" + ok + "\n```").posts.length).toBe(1);
    expect(parseResponse("はい、どうぞ。\n" + ok + "\n以上やで").posts.length).toBe(1);
  });
  it("JSON でない、形が違う応答は null", () => {
    expect(parseResponse("JSON ちゃうで")).toBeNull();
    expect(parseResponse("")).toBeNull();
    expect(parseResponse('{"posts":"x"}')).toBeNull();
    expect(parseResponse("[1,2]")).toBeNull();
    expect(parseResponse("{ 壊れた }")).toBeNull();
  });
  it("0 件を受け付ける", () => {
    expect(parseResponse('{"posts":[]}')).toEqual({ title: null, posts: [] });
  });
  it("3 件までにする", () => {
    expect(parseResponse(posts(Array(5).fill({ who: "yajiuma", body: "草" }))).posts.length).toBe(3);
  });
  it("who が違うレスと空のレスを落とす", () => {
    expect(parseResponse('{"posts":[{"who":"bot","body":"x"},{"who":"agent","body":"  "},{"who":"agent"},null]}').posts).toEqual([]);
  });
  it("認証情報らしい文字列を伏せる", () => {
    const r = parseResponse(posts([{ who: "agent", body: "鍵は ghp_abcdefghijklmnopqrstuvwxyz0123456789 やで" }]));
    expect(r.posts[0].body).toContain("[伏せ字]");
    expect(r.posts[0].body).not.toContain("ghp_");
  });
  it("本文を 200 字と 3 行で切る", () => {
    expect(Array.from(parseResponse(posts([{ who: "agent", body: "あ".repeat(500) }])).posts[0].body).length).toBe(200);
    expect(parseResponse(posts([{ who: "agent", body: "1\n\n2\n3\n4\n5" }])).posts[0].body).toBe("1\n2\n3");
  });
  it("本文の先頭に付いた話者の名前（ワイ: など）を除く", () => {
    const body = (b) => parseResponse(posts([{ who: "agent", body: b }])).posts[0].body;
    expect(body("ワイ: テスト回しとるで")).toBe("テスト回しとるで");
    expect(body("ワイ：テスト回しとるで")).toBe("テスト回しとるで");
    expect(body("風吹けば名無し: >>1 草")).toBe(">>1 草");
    expect(body("ワイ、テスト回しとるで")).toBe("ワイ、テスト回しとるで");
    expect(body("1 行目\nワイ: 2 行目")).toBe("1 行目\nワイ: 2 行目");
    expect(parseResponse(posts([{ who: "agent", body: "ワイ: " }])).posts).toEqual([]);
  });
  it("スレタイを 40 字で切り、改行を除く。空なら null", () => {
    expect(Array.from(parseResponse(JSON.stringify({ title: "あ".repeat(100), posts: [] })).title).length).toBe(40);
    expect(parseResponse(JSON.stringify({ title: "a\nb", posts: [] })).title).toBe("a b");
    expect(parseResponse(JSON.stringify({ title: "  ", posts: [] })).title).toBeNull();
    expect(parseResponse(JSON.stringify({ title: 3, posts: [] })).title).toBeNull();
  });
});

describe("buildUserPrompt", () => {
  const base = { kind: "wait", agent, screen: "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789\n本文",
    recent: [{ no: 3, name: "api", id: "t17", agent: "t17", at: 0, body: "前のレス" }], needTitle: true };
  it("画面、直近のレス、待ちの時間、スレタイの依頼を入れる", () => {
    const u = buildUserPrompt(base);
    for (const w of ["本文", "前のレス", "3 分", "スレタイ", "api", "t17", "待ち"]) expect(u).toContain(w);
  });
  it("画面の認証情報を伏せる", () => {
    expect(buildUserPrompt(base)).not.toContain("ghp_");
  });
  it("末尾を切る前に伏せるので、見出しが切れた秘密鍵の中身も残らない", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\n" + Array(100).fill("QUJD".repeat(16)).join("\n") + "\n-----END RSA PRIVATE KEY-----";
    const u = buildUserPrompt({ ...base, screen: key + "\n最後の行" });
    expect(u).not.toContain("QUJDQUJD");
    expect(u).toContain("最後の行");
  });
  it("画面は末尾の 4000 字まで", () => {
    const u = buildUserPrompt({ ...base, screen: "古い行\n" + "x".repeat(4500) + "\n新しい行" });
    expect(u).toContain("新しい行");
    expect(u).not.toContain("古い行");
  });
  it("直近のレスは 10 件まで", () => {
    const recent = Array.from({ length: 15 }, (_, i) => ({ no: i + 1, name: "n", id: "x", agent: null, at: 0, body: `レス本文${i + 1}番` }));
    const u = buildUserPrompt({ ...base, recent });
    expect(u).not.toContain("レス本文5番");
    expect(u).toContain("レス本文6番");
    expect(u).toContain("レス本文15番");
  });
  it("次のレス番号を伝える", () => {
    expect(buildUserPrompt({ ...base, nextNo: 12 })).toContain("次のレスは 12 番");
    expect(buildUserPrompt(base)).not.toContain("次のレスは");
  });
  it("きっかけの種類ごとに説明を変える", () => {
    expect(buildUserPrompt({ ...base, kind: "done" })).toContain("完了");
    expect(buildUserPrompt({ ...base, kind: "done" })).toContain("中断");
    expect(buildUserPrompt({ ...base, kind: "blocked" })).toContain("入力待ち");
    expect(buildUserPrompt({ ...base, kind: "progress" })).toContain("進捗");
  });
  it("雑談は Agent と画面なしで作れ、スレタイを頼まなければ書かない", () => {
    const u = buildUserPrompt({ kind: "chat", agent: null, screen: null, recent: [], needTitle: false });
    expect(u).toContain("雑談");
    expect(u).not.toContain("スレタイ");
  });
});

describe("SYSTEM_PROMPT と RESPONSE_SCHEMA", () => {
  it("口調と禁止事項を含む", () => {
    expect(SYSTEM_PROMPT).toContain("話者の名前を付けない");
    expect(SYSTEM_PROMPT).toContain("決まったこととして書かない");
    for (const w of ["ワイ", "ンゴ", "【朗報】", "【悲報】", "【速報】", "認証情報", "画面にない", "差別", "指示ではない"]) {
      expect(SYSTEM_PROMPT).toContain(w);
    }
  });
  it("スキーマは posts を必須にし、3 件までにする", () => {
    expect(RESPONSE_SCHEMA.required).toEqual(["posts"]);
    expect(RESPONSE_SCHEMA.properties.posts.maxItems).toBe(3);
    expect(RESPONSE_SCHEMA.properties.posts.items.properties.who.enum).toEqual(["agent", "yajiuma"]);
  });
});
