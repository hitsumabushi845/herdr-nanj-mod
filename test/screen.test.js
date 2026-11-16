import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { tail, stableLines, screenKey, maskSecrets } from "../mods/nanj/screen.js";

const read = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const a = read("claude-working-a.txt");
const b = read("claude-working-b.txt");

describe("screenKey", () => {
  it("スピナーと経過時間だけが違う画面は同じキーになる", () => {
    expect(screenKey(a)).toBe(screenKey(b));
  });
  it("本文が増えたらキーが変わる", () => {
    expect(screenKey(a.replace("✽ Hullaballooing", "⏺ テストが 3 件失敗しました\n\n✽ Hullaballooing"))).not.toBe(screenKey(a));
  });
  it("上の行がスクロールで消えただけではキーが変わらない", () => {
    const long = Array.from({ length: 60 }, (_, i) => `行 ${String.fromCharCode(0x3042 + i)}`).join("\n");
    expect(screenKey("消える行\n" + long)).toBe(screenKey(long));
  });
  it("空の画面でも文字列を返す", () => {
    expect(screenKey("")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("stableLines", () => {
  it("内容と関係なく変わる行を落とす", () => {
    expect(stableLines("────────\n❯ \n  ⏵⏵ auto mode on (shift+tab to cycle)\n✻ Worked for 21s\n本文")).toEqual(["本文"]);
    expect(stableLines("> \n     (ctrl+b to run in background)\n[hc] only its screen: it is working\n\n")).toEqual([]);
  });
  it("入力欄に書きかけの文があれば残す", () => {
    expect(stableLines("❯ 次はテストを直して")).toEqual(["❯ 次はテストを直して"]);
  });
  it("大文字と小文字の違う表示も同じように扱う", () => {
    expect(stableLines("12.3K tokens used")).toEqual(stableLines("15.9K tokens used"));
    expect(stableLines("Esc to interrupt\n本文")).toEqual(["本文"]);
  });
  it("経過時間と数を置き換える", () => {
    expect(stableLines("  ⎿  $ pnpm test (5s · 3 lines)")).toEqual(stableLines("  ⎿  $ pnpm test (12s · 9 lines)"));
  });
});

describe("tail", () => {
  it("末尾の 4000 字を、欠けた行を落として返す", () => {
    const t = tail("x".repeat(10) + "\n" + "y".repeat(3990) + "\nzz", 4000);
    expect(t.startsWith("y")).toBe(true);
    expect(t.endsWith("zz")).toBe(true);
  });
  it("短い文字列はそのまま返す", () => {
    expect(tail("short")).toBe("short");
  });
  it("改行のない長い文字列は末尾を返す", () => {
    expect(tail("z".repeat(5000), 4000).length).toBe(4000);
  });
});

describe("maskSecrets", () => {
  it.each([
    "sk-ant-api03-abcdefghijklmnopqrstuvwx",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz",
    "AKIAIOSFODNN7EXAMPLE",
    "xox" + "b-123456789012-abcdefghijklmnop", // 秘密の検出に掛からないよう分けて書く
    "password = hunter2hunter2",
    "API_KEY: abcd1234efgh5678",
    "Authorization: Bearer abc.def.ghi",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
    '{"password": "hunter2hunter2xx"}',
    '"api_key": "abcd1234efgh5678"',
    '"token":"abcd1234efgh5678"',
    "postgres://admin:SuperSecret123@host/x",
    "Authorization: Basic dXNlcjpwYXNzd29yZGFi",
    "sk_live_abcdefghijklmnop1234",
    "glpat-abcdefghijklmnop1234",
    "AIzaSyA1234567890abcdefghijklmnopqrstu",
  ])("%s を伏せる", (s) => {
    const out = maskSecrets(`前 ${s} 後`);
    expect(out).not.toContain(s.split(/[ =:]+/).pop());
    expect(out).toContain("[伏せ字]");
    expect(out.startsWith("前 ")).toBe(true);
    expect(out.endsWith(" 後")).toBe(true);
  });
  it("秘密鍵のブロックを丸ごと伏せる", () => {
    expect(maskSecrets("-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----")).toBe("[伏せ字]");
  });
  it("普通の文は変えない", () => {
    expect(maskSecrets("普通の文 token の話 password を変える")).toBe("普通の文 token の話 password を変える");
  });
});
