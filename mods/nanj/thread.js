// スレッドのデータ、時刻の書式、アンカーの分割、保存の形。

import { YAJIUMA_NAME, yajiumaId } from "./names.js";

/** @typedef {{no: number, name: string, id: string, agent: string | null, at: number, body: string}} Post */
/**
 * @typedef {object} Thread
 * @property {1} v
 * @property {string | null} title
 * @property {number | null} titleAt スレタイを付けた時刻。付け直す時期を決めるのに使う
 * @property {number} startedAt
 * @property {Post[]} posts
 * @property {Record<string, number>} colors
 */

export const MAX_POSTS = 1000;
export const COLOR_SLOTS = 8;

/** @param {number} now @returns {Thread} */
export function newThread(now) {
  return { v: 1, title: null, titleAt: null, startedAt: now, posts: [], colors: {} };
}

/**
 * スレタイを付ける、または付け直す。
 * @param {Thread} thread
 * @param {string} title
 * @param {number} now
 * @returns {Thread}
 */
export function setTitle(thread, title, now) {
  return { ...thread, title, titleAt: now };
}

/** 次に付くレスの番号。古いレスを落としたあとも番号は続く。 @param {Thread} thread */
export function nextNo(thread) {
  return thread.posts.length === 0 ? 1 : thread.posts[thread.posts.length - 1].no + 1;
}

/**
 * レスを足す。agent が null のとき（雑談）は、すべて野次馬のレスにする。
 * スレッドは 1 本のまま続く。MAX_POSTS を超えたら古いレスから落とし、番号は続ける。
 * @param {Thread} thread
 * @param {{who: "agent" | "yajiuma", body: string}[]} entries
 * @param {{address: string, name: string} | null} agent
 * @param {number} now
 * @param {() => number} rand
 * @returns {Thread}
 */
export function append(thread, entries, agent, now, rand) {
  const posts = [...thread.posts];
  const colors = { ...thread.colors };
  let no = nextNo(thread);
  for (const e of entries) {
    const own = e.who === "agent" && agent !== null;
    if (own && !(agent.address in colors)) colors[agent.address] = Object.keys(colors).length % COLOR_SLOTS;
    posts.push({
      no: no++,
      name: own ? agent.name : YAJIUMA_NAME,
      id: own ? agent.address : yajiumaId(rand),
      agent: own ? agent.address : null,
      at: now,
      body: e.body,
    });
  }
  return { ...thread, posts: posts.slice(-MAX_POSTS), colors };
}

const p2 = (n) => String(n).padStart(2, "0");
const DAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** @param {number} ms @returns {string} 例: 05:04:03 */
export function shortStamp(ms) {
  const d = new Date(ms);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** @param {number} ms @returns {string} 例: 2026/11/16(月) 19:32:10 */
export function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}(${DAYS[d.getDay()]}) ${shortStamp(ms)}`;
}

/**
 * 本文をアンカー（>>12）とそれ以外に分ける。
 * @param {string} body
 * @returns {{text: string, anchor: number | null}[]}
 */
export function segments(body) {
  const out = [];
  let last = 0;
  for (const m of body.matchAll(/>>(\d+)/g)) {
    if (m.index > last) out.push({ text: body.slice(last, m.index), anchor: null });
    out.push({ text: m[0], anchor: Number(m[1]) });
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push({ text: body.slice(last), anchor: null });
  return out;
}

/** @param {Thread} thread */
export function serialize(thread) {
  return JSON.stringify(thread);
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const validPost = (p) =>
  isObj(p) && typeof p.no === "number" && typeof p.name === "string" && typeof p.id === "string" &&
  (p.agent === null || typeof p.agent === "string") && typeof p.at === "number" && typeof p.body === "string";

/**
 * 保存した文字列からスレッドを読む。ない、壊れている、形が違うときは新しいスレッドを返す。
 * @param {string | null} text
 * @param {number} now
 * @returns {Thread}
 */
export function deserialize(text, now) {
  try {
    const t = text == null ? null : JSON.parse(text);
    if (
      isObj(t) && t.v === 1 && (t.title === null || typeof t.title === "string") && typeof t.startedAt === "number" &&
      (t.titleAt === undefined || t.titleAt === null || typeof t.titleAt === "number") &&
      Array.isArray(t.posts) && t.posts.every(validPost) && isObj(t.colors) &&
      Object.values(t.colors).every((c) => typeof c === "number")
    ) {
      // 付けた時刻のない古い保存データは、スレッドの開始時刻で補う
      const titleAt = t.title === null ? null : (t.titleAt ?? t.startedAt);
      return { v: 1, title: t.title, titleAt, startedAt: t.startedAt, posts: t.posts, colors: t.colors };
    }
  } catch {
    // 壊れたファイルは新しいスレッドとして扱う
  }
  return newThread(now);
}
