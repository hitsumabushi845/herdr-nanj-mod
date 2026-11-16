// Agent の画面の文字列の扱い: 末尾の切り出し、変化の判定、認証情報の伏せ字。

export const TAIL_MAX = 4000;
export const KEY_LINES = 30;
export const MASK = "[伏せ字]";

/**
 * 末尾の max 字を返す。先頭の欠けた行は落とす。
 * @param {string} text
 * @param {number} [max]
 */
export function tail(text, max = TAIL_MAX) {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  if (text[text.length - max - 1] === "\n") return cut;
  const nl = cut.indexOf("\n");
  return nl < 0 ? cut : cut.slice(nl + 1);
}

const RULE_ONLY = /^[\s─━═│┃╭╮╰╯┌┐└┘_-]+$/;
const EMPTY_PROMPT = /^\s*[❯>]\s*$/;
const STATUS = /⏵⏵|esc to interrupt|shift\+tab|\(ctrl\+[a-z] to /;
const SPINNER = /^\s*(?:[✻✽✶✢✳⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s|[·*∗]\s.*…)/;
const HC_NOTE = /^\[hc\]/;
const BULLET = /^\s*[⏺●]\s*/;
const TIME_OR_COUNT = /(?:\s*·\s*)?(?:↓\s*)?\d+(?:\.\d+)?\s*(?:k\s+tokens|tokens|lines|ms|[smh]|秒|分)(?![A-Za-z])/g;

/**
 * 内容と関係なく変わる行（スピナー、経過時間、入力欄、状態の行）を除いた行を返す。
 * 残した行からは、経過時間と数の表示を取り除く。
 * @param {string} text
 * @returns {string[]}
 */
export function stableLines(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim() || RULE_ONLY.test(raw) || EMPTY_PROMPT.test(raw) || STATUS.test(raw) || SPINNER.test(raw) || HC_NOTE.test(raw)) continue;
    const line = raw.replace(BULLET, "").replace(TIME_OR_COUNT, "").replace(/\(\s*\)/g, "").replace(/\s+/g, " ").trim();
    if (line) out.push(line);
  }
  return out;
}

/**
 * 画面が変わったかを比べるためのキー。末尾の KEY_LINES 行だけを見るので、
 * 上の行がスクロールで消えただけでは変わらない。
 * @param {string} text
 * @returns {string} FNV-1a 32 ビットの 16 進
 */
export function screenKey(text) {
  const s = stableLines(text).slice(-KEY_LINES).join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, MASK],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, `$1${MASK}`],
  [/([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)[A-Za-z0-9_-]*\s*[:=]\s*)(["']?)[^\s"']{8,}\2/gi, `$1${MASK}`],
];

/**
 * 認証情報らしい文字列を伏せる。
 * @param {string} text
 */
export function maskSecrets(text) {
  let out = text;
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}
