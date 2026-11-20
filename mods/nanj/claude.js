// claude コマンドの引数と、応答の取り出し。引数の組は CLAUDE.md の「確かめた事実」による。

import { RESPONSE_SCHEMA } from "./prompt.js";

/** @typedef {import("./config.js").Config} Config */

export const CLAUDE_TIMEOUT_MS = 60000;

/**
 * @param {Config} cfg
 * @param {string} system
 * @param {string} user
 * @returns {string[]}
 */
export function claudeArgs(cfg, system, user) {
  return [
    "-p",
    "--model", cfg.model,
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--no-session-persistence",
    "--output-format", "json",
    "--system-prompt", system,
    "--json-schema", JSON.stringify(RESPONSE_SCHEMA),
    "--",
    user,
  ];
}

/**
 * claude の標準出力（--output-format json）から、モデルの応答の文字列を取り出す。
 * @param {string} stdout
 * @returns {string | null} 失敗の出力や読めない出力は null
 */
export function extractText(stdout) {
  let out;
  try {
    out = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (out === null || typeof out !== "object" || out.is_error === true) return null;
  if (out.structured_output !== null && typeof out.structured_output === "object") return JSON.stringify(out.structured_output);
  return typeof out.result === "string" && out.result ? out.result : null;
}
