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
 * @property {Record<string, number>} colors 1 本にまとめていたころの、端末ごとの色。移行で使う
 * @property {string | null} key スレッドのキー（<端末のアドレス>@<端末の作成時刻>）
 * @property {string | null} address 持ち主の端末のアドレス
 * @property {string | null} name 持ち主の Agent の名前
 * @property {number} color 持ち主の名前の色の番号
 */
/** @typedef {{key: string, address: string, name: string, color: number}} Owner */
/** @typedef {{key: string, address: string, name: string, color: number, lastPostAt: number}} IndexEntry */
/** @typedef {{v: 1, threads: IndexEntry[]}} Index */

export const MAX_POSTS = 1000;
export const COLOR_SLOTS = 8;
/** 起動していない Agent のスレッドを、最後のレスからこれだけたったら消す。 */
export const PRUNE_AFTER_MS = 604800000;

/** スレッドのキー。アドレスが別の端末に使い回されても混ざらないよう、作成時刻を付ける。 */
export function threadKey(address, createdMs) {
  return `${address}@${createdMs}`;
}

/** スレッドを保存するファイルの名前。別のマシンの端末（machine/t7）の / を置き換える。 */
export function threadFile(key) {
  return key.replace(/\//g, "_") + ".json";
}

/**
 * @param {number} now
 * @param {Owner} [owner] 持ち主の Agent。なければ持ち主の欄は空にする
 * @returns {Thread}
 */
export function newThread(now, owner) {
  return {
    v: 1, title: null, titleAt: null, startedAt: now, posts: [], colors: {},
    key: owner?.key ?? null, address: owner?.address ?? null, name: owner?.name ?? null, color: owner?.color ?? 0,
  };
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
const optString = (v) => v === undefined || v === null || typeof v === "string";
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
      Object.values(t.colors).every((c) => typeof c === "number") &&
      optString(t.key) && optString(t.address) && optString(t.name) && (t.color === undefined || typeof t.color === "number")
    ) {
      // 付けた時刻のない古い保存データは、スレッドの開始時刻で補う
      const titleAt = t.title === null ? null : (t.titleAt ?? t.startedAt);
      return {
        v: 1, title: t.title, titleAt, startedAt: t.startedAt, posts: t.posts, colors: t.colors,
        key: t.key ?? null, address: t.address ?? null, name: t.name ?? null, color: t.color ?? 0,
      };
    }
  } catch {
    // 壊れたファイルは新しいスレッドとして扱う
  }
  return newThread(now);
}

/** @returns {Index} */
export function emptyIndex() {
  return { v: 1, threads: [] };
}

/**
 * 一覧にスレッドを足す、または置き換える。持ち主のないスレッドは入れない。
 * @param {Index} index
 * @param {Thread} thread
 * @param {number} now レスのないスレッドの lastPostAt に使う
 * @returns {Index}
 */
export function upsertIndex(index, thread, now) {
  if (thread.key === null || thread.address === null || thread.name === null) return index;
  const last = thread.posts[thread.posts.length - 1];
  const entry = { key: thread.key, address: thread.address, name: thread.name, color: thread.color, lastPostAt: last ? last.at : now };
  const at = index.threads.findIndex((e) => e.key === thread.key);
  const threads = at < 0 ? [...index.threads, entry] : index.threads.map((e, i) => (i === at ? entry : e));
  return { v: 1, threads };
}

/** @param {Index} index @param {string} key @returns {Index} */
export function removeFromIndex(index, key) {
  return index.threads.some((e) => e.key === key) ? { v: 1, threads: index.threads.filter((e) => e.key !== key) } : index;
}

/** 次に作るスレッドの色の番号。作った順に COLOR_SLOTS 色を回す。 @param {Index} index */
export function nextColor(index) {
  if (index.threads.length === 0) return 0;
  return (Math.max(...index.threads.map((e) => e.color)) + 1) % COLOR_SLOTS;
}

/**
 * 消してよいスレッドのキー。起動しておらず、最後のレスから PRUNE_AFTER_MS たったものだけ。
 * 起動していないことだけでは消さない（Agent の一覧が一時的に空になることがある）。
 * @param {Index} index
 * @param {string[]} liveKeys
 * @param {number} now
 */
export function staleKeys(index, liveKeys, now) {
  return index.threads.filter((e) => !liveKeys.includes(e.key) && now - e.lastPostAt >= PRUNE_AFTER_MS).map((e) => e.key);
}

/** @param {Index} index */
export function serializeIndex(index) {
  return JSON.stringify(index);
}

const validEntry = (e) =>
  isObj(e) && typeof e.key === "string" && typeof e.address === "string" && typeof e.name === "string" &&
  typeof e.color === "number" && typeof e.lastPostAt === "number";

/** @param {string | null} text @returns {Index} 読めなければ空の一覧 */
export function deserializeIndex(text) {
  try {
    const x = text == null ? null : JSON.parse(text);
    if (isObj(x) && x.v === 1 && Array.isArray(x.threads) && x.threads.every(validEntry)) {
      return { v: 1, threads: x.threads.map((e) => ({ key: e.key, address: e.address, name: e.name, color: e.color, lastPostAt: e.lastPostAt })) };
    }
  } catch {
    // 壊れた一覧は空として扱う。次の保存で作り直される
  }
  return emptyIndex();
}

/**
 * 全 Agent が 1 本に書いていたころのスレッドを、端末ごとのスレッドに分ける。
 * 野次馬のレスは、同じ時刻（同じ生成）の Agent 本人のレスと同じスレッドに入れる。
 * 同じ時刻の Agent 本人のレスがない野次馬のレス（雑談）は捨てる。
 * @param {Thread} legacy
 * @param {Record<string, string>} liveKeys 起動している端末のアドレスからキーへの対応
 * @param {number} now
 * @returns {{threads: Thread[], dropped: number}}
 */
export function migrate(legacy, liveKeys, now) {
  // 同じ時刻のレスのうち、Agent 本人のレスの端末（最初のもの）。野次馬が先に並んでいるときに使う。
  const firstAt = {};
  for (const p of legacy.posts) if (p.agent !== null && !(p.at in firstAt)) firstAt[p.at] = p.agent;

  const byAddress = {};
  const order = [];
  let dropped = 0;
  let prev = null; // すぐ前の Agent 本人のレス
  for (const p of legacy.posts) {
    let address;
    if (p.agent !== null) {
      address = p.agent;
      prev = p;
    } else {
      address = prev !== null && prev.at === p.at ? prev.agent : (firstAt[p.at] ?? null);
    }
    if (address === null) {
      dropped++;
      continue;
    }
    if (!(address in byAddress)) {
      byAddress[address] = [];
      order.push(address);
    }
    byAddress[address].push(p);
  }

  const threads = order.map((address) => {
    const posts = byAddress[address];
    const own = posts.filter((p) => p.agent !== null);
    const owner = {
      key: liveKeys[address] ?? threadKey(address, 0),
      address,
      name: own[own.length - 1].name,
      color: legacy.colors[address] ?? 0,
    };
    return { ...newThread(posts[0].at, owner), posts: posts.slice(-MAX_POSTS) };
  });
  return { threads, dropped };
}
