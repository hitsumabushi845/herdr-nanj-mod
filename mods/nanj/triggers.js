// レスを作るきっかけ。状態は書き換えず、新しい状態を返す。

/** @typedef {import("./budget.js").Kind} Kind */
/** @typedef {import("./config.js").Config} Config */
/** @typedef {{address: string, status: "working" | "blocked" | "done" | "idle", key: string | null}} Obs */
/** @typedef {{kind: Kind, address: string}} Trigger 雑談の address は、書き込むスレッドの Agent */
/**
 * @typedef {object} Rec Agent ごとの記録
 * @property {string} status
 * @property {string | null} key 最後に見た画面のキー
 * @property {string | null} postedKey 最後に進捗のレスを作ったときのキー
 * @property {number | null} lastPostAt この Agent の最後のレスの時刻
 * @property {number} waitFrom 待ちを数え始める時刻（画面が変わった時刻か、前の待ちのレスの時刻）
 * @property {number} waitGapMs 次の待ちまでの間隔
 * @property {number | null} workingSince
 */
/**
 * @typedef {object} State
 * @property {Record<string, Rec>} agents
 * @property {Trigger[]} queue 完了と入力待ちの待ち行列
 * @property {number | null} lastChatAt
 */

export const WAIT_FIRST_MS = 180000;

/** @returns {State} */
export function initialState() {
  return { agents: {}, queue: [], lastChatAt: null };
}

const sameTrigger = (a, b) => a.kind === b.kind && a.address === b.address;

/**
 * 今の Agent の一覧を取り込む。
 * @param {State} state
 * @param {Obs[]} obs key は working のときの screenKey
 * @param {number} now
 * @returns {State}
 */
export function observe(state, obs, now) {
  const agents = {};
  let queue = state.queue;
  for (const o of obs) {
    const prev = state.agents[o.address];
    const working = o.status === "working";
    if (!prev) {
      agents[o.address] = {
        status: o.status, key: working ? o.key : null, postedKey: null, lastPostAt: null,
        waitFrom: now, waitGapMs: WAIT_FIRST_MS, workingSince: working ? now : null,
      };
      continue;
    }
    const rec = { ...prev, status: o.status };
    if (working) {
      if (prev.status !== "working") {
        rec.workingSince = now;
        rec.waitFrom = now;
        rec.waitGapMs = WAIT_FIRST_MS;
        queue = queue.filter((t) => t.address !== o.address);
      }
      if (o.key !== null && o.key !== prev.key) {
        rec.key = o.key;
        rec.waitFrom = now;
        rec.waitGapMs = WAIT_FIRST_MS;
      }
    } else {
      rec.workingSince = null;
      let t = null;
      if (prev.status === "working" && (o.status === "done" || o.status === "idle")) t = { kind: "done", address: o.address };
      if (o.status === "blocked" && prev.status !== "blocked") t = { kind: "blocked", address: o.address };
      if (t && !queue.some((q) => sameTrigger(q, t))) queue = [...queue, t];
    }
    agents[o.address] = rec;
  }
  queue = queue.filter((t) => t.address === null || t.address in agents);

  return { agents, queue, lastChatAt: state.lastChatAt ?? now };
}

/**
 * 次に処理するきっかけを選ぶ。完了と入力待ち、進捗と待ち（最後のレスが古い Agent から）、雑談の順。
 * @param {State} state
 * @param {number} now
 * @param {Config} cfg
 * @returns {Trigger | null}
 */
export function pick(state, now, cfg) {
  if (state.queue.length > 0) return state.queue[0];
  const minGap = cfg.min_interval_sec * 1000;
  let best = null;
  let bestAt = Infinity;
  let chatTo = null; // 雑談の行き先: 作業中の Agent のうち、最後のレスがいちばん古いもの
  let chatAt = Infinity;
  for (const [address, r] of Object.entries(state.agents)) {
    if (r.status !== "working") continue;
    if ((r.lastPostAt ?? -Infinity) < chatAt) {
      chatTo = address;
      chatAt = r.lastPostAt ?? -Infinity;
    }
    if (r.lastPostAt !== null && now - r.lastPostAt < minGap) continue;
    let kind = null;
    if (r.key !== r.postedKey) kind = "progress";
    else if (now - r.waitFrom >= r.waitGapMs) kind = "wait";
    if (!kind) continue;
    const at = r.lastPostAt ?? -Infinity;
    if (at < bestAt) {
      best = { kind, address };
      bestAt = at;
    }
  }
  if (best) return best;
  if (chatTo !== null && cfg.chat_interval_min > 0 && state.lastChatAt !== null && now - state.lastChatAt >= cfg.chat_interval_min * 60000) {
    return { kind: "chat", address: chatTo };
  }
  return null;
}

/**
 * きっかけを処理したあとに呼ぶ。生成の成否によらず呼び、同じきっかけを繰り返さないようにする。
 * @param {State} state
 * @param {Trigger} trigger
 * @param {number} now
 * @returns {State}
 */
export function commit(state, trigger, now) {
  if (trigger.kind === "chat") return { ...state, lastChatAt: now };
  const queue = state.queue.filter((t) => !sameTrigger(t, trigger));
  const prev = state.agents[trigger.address];
  if (!prev) return { ...state, queue };
  const rec = { ...prev, lastPostAt: now };
  if (trigger.kind === "progress") rec.postedKey = prev.key;
  if (trigger.kind === "wait") {
    rec.waitFrom = now;
    rec.waitGapMs = prev.waitGapMs * 2;
  }
  return { ...state, queue, agents: { ...state.agents, [trigger.address]: rec } };
}

/**
 * 生成を試みずにきっかけを捨てる。
 * @param {State} state
 * @param {Trigger} trigger
 * @returns {State}
 */
export function drop(state, trigger) {
  return { ...state, queue: state.queue.filter((t) => !sameTrigger(t, trigger)) };
}

/**
 * その Agent が working になったのを最初に見た時刻。working でなければ null。
 * @param {State} state
 * @param {string} address
 */
export function workingSince(state, address) {
  return state.agents[address]?.workingSince ?? null;
}
