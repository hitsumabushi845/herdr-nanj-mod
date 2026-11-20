// 設定（~/.config/herdr-nanj/config.json）の既定値と検証。

/**
 * @typedef {object} Config
 * @property {boolean} enabled 起動時に実況を始めるか
 * @property {string} model claude --model に渡す名前
 * @property {number} min_interval_sec 同じ Agent のレスの最短の間隔
 * @property {number} max_calls_per_hour 直近 60 分の呼び出しの上限
 * @property {number} chat_interval_min 雑談の最短の間隔。0 で雑談なし
 * @property {"classic" | "theme"} palette
 * @property {string[]} exclude_spaces 画面を読まない space の名前
 */

/** @type {Config} */
export const DEFAULTS = Object.freeze({
  enabled: true,
  model: "haiku",
  min_interval_sec: 90,
  max_calls_per_hour: 60,
  chat_interval_min: 10,
  palette: "classic",
  exclude_spaces: Object.freeze([]),
});

const num = (v, fallback, min) => (typeof v === "number" && Number.isFinite(v) ? Math.max(min, v) : fallback);

/**
 * 設定ファイルの中身を検証する。合わないキーはそのキーだけ既定値にする。
 * @param {string | null} text
 * @returns {Config}
 */
export function parseConfig(text) {
  let raw = null;
  try {
    raw = text == null ? null : JSON.parse(text);
  } catch {
    raw = null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) raw = {};
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULTS.enabled,
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : DEFAULTS.model,
    min_interval_sec: num(raw.min_interval_sec, DEFAULTS.min_interval_sec, 30),
    max_calls_per_hour: num(raw.max_calls_per_hour, DEFAULTS.max_calls_per_hour, 10),
    chat_interval_min: num(raw.chat_interval_min, DEFAULTS.chat_interval_min, 0),
    palette: raw.palette === "classic" || raw.palette === "theme" ? raw.palette : DEFAULTS.palette,
    exclude_spaces: Array.isArray(raw.exclude_spaces) ? raw.exclude_spaces.filter((s) => typeof s === "string") : [],
  };
}
