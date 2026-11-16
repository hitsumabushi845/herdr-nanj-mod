import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { DEFAULTS } from "../mods/nanj/config.js";
import { RESPONSE_SCHEMA } from "../mods/nanj/prompt.js";
import { claudeArgs, extractText } from "../mods/nanj/claude.js";

const fixture = readFileSync(new URL("./fixtures/claude-output.json", import.meta.url), "utf8");

describe("claudeArgs", () => {
  const args = claudeArgs({ ...DEFAULTS, model: "haiku" }, "SYS", "USER");
  const after = (flag) => args[args.indexOf(flag) + 1];
  it("確かめた引数の組で呼ぶ", () => {
    expect(args[0]).toBe("-p");
    expect(after("--model")).toBe("haiku");
    expect(after("--tools")).toBe("");
    expect(after("--setting-sources")).toBe("");
    expect(after("--output-format")).toBe("json");
    expect(after("--system-prompt")).toBe("SYS");
    expect(JSON.parse(after("--json-schema"))).toEqual(RESPONSE_SCHEMA);
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(args).not.toContain("--bare");
    expect(args.at(-1)).toBe("USER");
  });
  it("設定のモデルを使う", () => {
    expect(claudeArgs({ ...DEFAULTS, model: "sonnet" }, "S", "U")).toContain("sonnet");
  });
  it("- で始まる本文を引数と取り違えさせない", () => {
    const a = claudeArgs(DEFAULTS, "S", "--help");
    expect(a.at(-1)).toBe("--help");
    expect(a.at(-2)).toBe("--");
  });
});

describe("extractText", () => {
  it("実際の出力から本文の JSON を取り出す", () => {
    expect(JSON.parse(extractText(fixture)).posts[0].who).toBe("agent");
  });
  it("structured_output がなければ result を使う", () => {
    expect(extractText('{"is_error":false,"result":"{\\"posts\\":[]}"}')).toBe('{"posts":[]}');
  });
  it("失敗の出力、空、JSON でない文字列は null", () => {
    expect(extractText('{"is_error":true,"result":"Credit balance is too low"}')).toBeNull();
    expect(extractText("")).toBeNull();
    expect(extractText("not json")).toBeNull();
    expect(extractText('{"is_error":false}')).toBeNull();
    expect(extractText("null")).toBeNull();
  });
});
