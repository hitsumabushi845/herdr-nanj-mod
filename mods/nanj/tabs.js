// タブの並び、選択、未読の計算。

/** @typedef {import("./thread.js").Thread} Thread */
/** @typedef {{key: string, address: string, name: string, status: string, color: number | null, unread: number, selected: boolean}} Tab */

/**
 * 未読のレスの数。
 * @param {Thread | null | undefined} thread
 * @param {unknown} seenNo 最後に見たレス番号。数でなければ、まだ何も見ていないものとする
 */
export function unread(thread, seenNo) {
  if (!thread) return 0;
  if (typeof seenNo !== "number" || thread.posts.length === 0) return thread.posts.length;
  // 最後の番号が既読の位置より小さいのは、次スレで番号が 1 に戻ったとき。戻ったあとのレスはすべて未読。
  if (thread.posts[thread.posts.length - 1].no < seenNo) return thread.posts.length;
  return thread.posts.filter((p) => p.no > seenNo).length;
}

/**
 * 表示するタブを決める。替わるのは、覚えたキーの Agent が起動していないときだけ。
 * 起動している Agent が 1 つもないときは、覚えた値を書き換えない（一覧が一時的に空になることがある）。
 * @param {unknown} saved 覚えているキー
 * @param {string[]} keys 起動している Agent のキー（タブの順）
 * @param {boolean} [pending] キーをまだ読めていない Agent がある。覚えたキーの Agent が終了したのか、
 *   まだ読めていないだけなのかを区別できないので、この間は覚え直さない
 * @returns {{key: string | null, save: boolean}} save が true なら key を覚え直す
 */
export function selectTab(saved, keys, pending = false) {
  if (typeof saved === "string" && keys.includes(saved)) return { key: saved, save: false };
  if (pending) return { key: typeof saved === "string" ? null : (keys[0] ?? null), save: false };
  if (keys.length === 0) return { key: null, save: false };
  return { key: keys[0], save: true };
}

/**
 * タブの列を作る。キーの付いていない Agent（作成時刻をまだ読めていない）は出さない。
 * @param {{key: string | null, address: string, status: string}[]} agents タブに出す Agent。この順に並べる
 * @param {Record<string, string>} names アドレスから名前への対応
 * @param {Record<string, Thread>} threads キーからスレッドへの対応
 * @param {unknown} seen キーから最後に見たレス番号への対応
 * @param {string | null} selected
 * @returns {Tab[]}
 */
export function buildTabs(agents, names, threads, seen, selected) {
  const seenOf = seen !== null && typeof seen === "object" ? seen : {};
  const tabs = [];
  for (const a of agents) {
    if (a.key === null) continue;
    const thread = threads[a.key] ?? null;
    const isSelected = a.key === selected;
    tabs.push({
      key: a.key,
      address: a.address,
      name: names[a.address] ?? a.address,
      status: a.status,
      color: thread ? thread.color : null,
      unread: isSelected ? 0 : unread(thread, seenOf[a.key]),
      selected: isSelected,
    });
  }
  return tabs;
}

/**
 * 表示中のスレッドを既読にした、新しい対応を返す。変える必要がなければ null。
 * @param {unknown} seen
 * @param {string | null} key 表示中のキー
 * @param {Thread | null | undefined} thread
 * @returns {Record<string, number> | null}
 */
export function markSeen(seen, key, thread) {
  if (key === null || !thread || thread.posts.length === 0) return null;
  const last = thread.posts[thread.posts.length - 1].no;
  const seenOf = seen !== null && typeof seen === "object" && !Array.isArray(seen) ? seen : {};
  if (seenOf[key] === last) return null;
  return { ...seenOf, [key]: last };
}
