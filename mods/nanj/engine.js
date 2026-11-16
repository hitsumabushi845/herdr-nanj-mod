// 実況の 1 回分の処理。herdr の API は deps で受け取るので、Node 上でテストできる。

import { agentNames } from "./names.js";
import { screenKey } from "./screen.js";
import { canCall, record } from "./budget.js";
import { initialState, observe, pick, commit, drop, workingSince } from "./triggers.js";
import { newThread, append, nextNo, serialize, deserialize } from "./thread.js";
import { SYSTEM_PROMPT, RECENT_MAX, buildUserPrompt, parseResponse } from "./prompt.js";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("./thread.js").Thread} Thread */
/** @typedef {{address: string, status: "working" | "blocked" | "done" | "idle", space: string, space_name: string, tab_name: string}} AgentView */
/**
 * @typedef {object} Deps
 * @property {() => AgentView[]} listAgents
 * @property {(address: string) => Promise<string>} readScreen 読めなければ reject する
 * @property {(system: string, user: string) => Promise<string>} generate 失敗したら reject する
 * @property {() => Promise<string | null>} load
 * @property {(text: string) => Promise<void>} save
 * @property {() => Config} config
 * @property {() => number} rand
 * @property {() => void} changed スレッドか状態が変わったときに呼ぶ
 */

export const LEASE_MS = 45000;
export const MAX_FAILURES = 3;

/**
 * 生成役のリースを自分が持てるか。リースがない、自分のもの、LEASE_MS 以上古いときに true。
 * @param {{id: string, at: number} | null | undefined} lease
 * @param {string} myId
 * @param {number} now
 */
export function holdsLease(lease, myId, now) {
  if (lease === null || typeof lease !== "object" || typeof lease.id !== "string" || typeof lease.at !== "number") return true;
  return lease.id === myId || now - lease.at >= LEASE_MS;
}

/**
 * 保存されたスレッドを読み直す必要があるか。
 * 生成役を引き継いだとき（手元の内容が古い）と、生成役でないコピーが他のコピーの書き込みを見たときに true。
 * @param {boolean} wasLeader
 * @param {boolean} isLeader
 * @param {unknown} sharedRev shared に書かれている版
 * @param {unknown} seenRev このコピーが最後に取り込んだ版
 */
export function needsReload(wasLeader, isLeader, sharedRev, seenRev) {
  if (isLeader) return !wasLeader;
  return sharedRev !== seenRev;
}

/**
 * 設定の enabled を停止の状態に反映する。初めてのときと、enabled が前に反映した値から変わったときだけ
 * 設定に合わせる。変わっていなければ、ボタンで決めた状態を残す。
 * @param {unknown} paused shared にある停止の状態
 * @param {unknown} applied 前に反映した enabled
 * @param {boolean} enabled 今の設定
 * @returns {{paused: boolean, applied: boolean}}
 */
export function applyEnabled(paused, applied, enabled) {
  if (typeof paused !== "boolean" || applied !== enabled) return { paused: !enabled, applied: enabled };
  return { paused, applied: enabled };
}

const message = (e) => (e instanceof Error ? e.message : String(e));

/** @param {Deps} deps */
export function createEngine(deps) {
  let state = initialState();
  let calls = [];
  let failures = 0;
  let busy = false;

  const engine = {
    /** @type {Thread} */
    thread: newThread(0),
    paused: false,
    /** @type {string | null} */
    error: null,

    async init(now) {
      engine.thread = newThread(now);
      await engine.reload(now);
    },

    /** 保存された内容を読み直す。生成役でないコピーが、他のコピーの書き込みを取り込むために使う。 */
    async reload(now) {
      let text;
      try {
        text = await deps.load();
      } catch {
        return; // 読めないときは手元のスレッドを残す。空で上書きしない。
      }
      engine.thread = deserialize(text, now);
    },

    setPaused(paused) {
      engine.paused = paused;
      if (!paused) {
        engine.error = null;
        failures = 0;
      }
    },

    /** 手動の次スレ。スレッドが替わるのは、利用者がこれを選んだときだけ。 */
    async rotate(now) {
      engine.thread = newThread(now);
      await persist();
    },

    async tick(now) {
      if (engine.paused || busy) return;
      busy = true;
      try {
        await step(now);
      } finally {
        busy = false;
      }
    },
  };

  async function persist() {
    try {
      await deps.save(serialize(engine.thread));
      if (!engine.paused) engine.error = null;
    } catch (e) {
      engine.error = `スレッドの保存に失敗しました: ${message(e)}`;
    }
    deps.changed();
  }

  async function step(now) {
    const cfg = deps.config();
    const all = deps.listAgents().filter((a) => !cfg.exclude_spaces.includes(a.space_name));
    const names = agentNames(all);

    // 観測。作業中の Agent だけ画面を読む。読めない Agent は一覧にないものとして扱う。
    const screens = {};
    const obs = [];
    for (const a of all) {
      if (a.status !== "working") {
        obs.push({ address: a.address, status: a.status, key: null });
        continue;
      }
      try {
        screens[a.address] = await deps.readScreen(a.address);
        obs.push({ address: a.address, status: a.status, key: screenKey(screens[a.address]) });
      } catch {
        // この Agent は今回は見ない
      }
    }
    state = observe(state, obs, now);

    const trigger = pick(state, now, cfg);
    if (!trigger || !canCall(calls, trigger.kind, now, cfg.max_calls_per_hour)) return;

    let agent = null;
    let screen = null;
    if (trigger.address !== null) {
      const view = all.find((a) => a.address === trigger.address);
      try {
        if (!view) throw new Error("gone");
        screen = screens[trigger.address] ?? (await deps.readScreen(trigger.address));
      } catch {
        state = drop(state, trigger);
        return;
      }
      const since = workingSince(state, trigger.address);
      agent = {
        name: names[trigger.address], address: trigger.address, space: view.space_name, tab: view.tab_name,
        status: view.status, workingForSec: since === null ? 0 : Math.floor((now - since) / 1000),
      };
    }

    const user = buildUserPrompt({
      kind: trigger.kind, agent, screen,
      recent: engine.thread.posts.slice(-RECENT_MAX),
      needTitle: engine.thread.title === null,
      nextNo: nextNo(engine.thread),
    });
    calls = record(calls, now);
    state = commit(state, trigger, now);

    let parsed = null;
    let reason = "応答を読めませんでした";
    try {
      parsed = parseResponse(await deps.generate(SYSTEM_PROMPT, user));
    } catch (e) {
      reason = message(e);
    }
    if (!parsed) {
      failures++;
      if (failures >= MAX_FAILURES) {
        engine.paused = true;
        engine.error = `レスの生成に ${MAX_FAILURES} 回続けて失敗したので止めました: ${reason}`;
        deps.changed();
      }
      return;
    }
    failures = 0;
    if (parsed.posts.length === 0) return;

    const next = append(engine.thread, parsed.posts, agent ? { address: agent.address, name: agent.name } : null, now, deps.rand);
    engine.thread = next.title === null ? { ...next, title: parsed.title ?? `【実況】${agent ? agent.name : "なんJ"} スレ` } : next;
    await persist();
  }

  return engine;
}
