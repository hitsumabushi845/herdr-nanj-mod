// 実況の 1 回分の処理。herdr の API は deps で受け取るので、Node 上でテストできる。

import { agentNames } from "./names.js";
import { screenKey } from "./screen.js";
import { canCall, record } from "./budget.js";
import { initialState, observe, pick, commit, drop, workingSince } from "./triggers.js";
import {
  newThread, append, nextNo, setTitle, serialize, deserialize, migrate,
  emptyIndex, upsertIndex, removeFromIndex, nextColor, staleKeys, serializeIndex, deserializeIndex,
} from "./thread.js";
import { SYSTEM_PROMPT, RECENT_MAX, buildUserPrompt, parseResponse } from "./prompt.js";

/** @typedef {import("./config.js").Config} Config */
/** @typedef {import("./thread.js").Thread} Thread */
/** @typedef {import("./thread.js").Index} Index */
/**
 * @typedef {object} AgentView
 * @property {string} address
 * @property {"working" | "blocked" | "done" | "idle"} status
 * @property {string} space
 * @property {string} space_name
 * @property {string} tab_name
 * @property {string | null} key スレッドのキー。端末の作成時刻をまだ読めていなければ null
 */
/**
 * @typedef {object} Deps
 * @property {() => AgentView[]} listAgents
 * @property {(address: string) => Promise<string>} readScreen 読めなければ reject する
 * @property {(system: string, user: string) => Promise<string>} generate 失敗したら reject する
 * @property {(key: string) => Promise<string | null>} loadThread
 * @property {(key: string, text: string) => Promise<void>} saveThread
 * @property {(key: string) => Promise<void>} removeThread
 * @property {() => Promise<string | null>} loadIndex
 * @property {(text: string) => Promise<void>} saveIndex
 * @property {() => Promise<string | null>} loadLegacy 1 本にまとめていたころのスレッド（thread.json）
 * @property {() => Promise<void>} archiveLegacy thread.json を残す名前に変える
 * @property {() => Config} config
 * @property {() => number} rand
 * @property {(key: string | null) => void} changed 変わったスレッドのキー。一覧や状態だけが変わったときは null
 */

export const LEASE_MS = 45000;
export const MAX_FAILURES = 3;
/** スレタイがこれより古くなったら、次のレスと一緒に付け直す。 */
export const TITLE_REFRESH_MS = 1800000;
/** 古いスレッドを消す処理を走らせる間隔。 */
export const PRUNE_EVERY_MS = 3600000;

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
  let migrationDone = false;
  let lastPruneAt = null;
  /** 保存された内容を読もうとしたキー。読み込みに失敗したキーは入れず、次にまた読む。 */
  const loaded = new Set();

  const engine = {
    /** キーからスレッドへの対応。レスが 1 つ以上付いたスレッドと、保存から読んだスレッドだけが入る。 @type {Record<string, Thread>} */
    threads: {},
    /** @type {Index} */
    index: emptyIndex(),
    /** 移行した直後だけ、キーごとの最後のレス番号。呼び出し側が既読の位置に使い、読んだら null に戻す。 @type {Record<string, number> | null} */
    migrated: null,
    paused: false,
    /** @type {string | null} */
    error: null,

    async init(now) {
      await engine.reload(null, now);
    },

    /**
     * 保存された内容を読み直す。key が null なら一覧、キーならそのスレッド。
     * 読み込みに失敗したら手元の内容を残す。空で上書きしない。
     */
    async reload(key, now) {
      if (key === null) {
        try {
          engine.index = deserializeIndex(await deps.loadIndex());
        } catch {
          // 手元の一覧を残す
        }
        return;
      }
      await read(key, now);
    },

    /** まだ読んでいないキーのスレッドを読む。読んだものがあれば true。 */
    async ensure(keys, now) {
      let any = false;
      for (const key of keys) {
        if (loaded.has(key)) continue;
        if (await read(key, now)) any = true;
      }
      return any;
    },

    setPaused(paused) {
      engine.paused = paused;
      if (!paused) {
        engine.error = null;
        failures = 0;
      }
    },

    /** 手動の次スレ。そのスレッドだけを、同じ持ち主の空のスレッドにする。 */
    async rotate(key, now) {
      const t = engine.threads[key];
      if (!t || t.key === null) return;
      engine.threads[key] = newThread(now, { key: t.key, address: t.address, name: t.name, color: t.color });
      await persist(key, now);
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

  /** スレッドを保存から読む。読めたら（なかった場合も含めて）true、読み込みに失敗したら false。 */
  async function read(key, now) {
    let text;
    try {
      text = await deps.loadThread(key);
    } catch {
      loaded.delete(key);
      return false;
    }
    loaded.add(key);
    const t = text === null ? null : deserialize(text, now);
    // ない、壊れている、別のキーのスレッドが入っているファイルは、ないものとして扱う
    if (t !== null && t.key === key) engine.threads[key] = t;
    else delete engine.threads[key];
    return true;
  }

  /** スレッドのファイル、一覧の順に保存する。一覧だけ失敗しても、スレッドは残る。 */
  async function persist(key, now) {
    const thread = engine.threads[key];
    let failed = null;
    try {
      await deps.saveThread(key, serialize(thread));
      loaded.add(key);
    } catch (e) {
      failed = `スレッドの保存に失敗しました: ${message(e)}`;
    }
    if (failed === null) {
      engine.index = upsertIndex(engine.index, thread, now);
      try {
        await deps.saveIndex(serializeIndex(engine.index));
      } catch (e) {
        failed = `スレッドの一覧の保存に失敗しました: ${message(e)}`;
      }
    }
    if (failed !== null) engine.error = failed;
    else if (!engine.paused) engine.error = null;
    deps.changed(key);
  }

  /**
   * 1 本にまとめていたころのスレッドを、端末ごとのファイルに分ける。1 回だけ行う。
   * @returns {Promise<boolean>} 先へ進んでよければ true。待つ、または失敗したときは false で、次の tick でやり直す
   */
  async function migrateIfNeeded(all, now) {
    try {
      const legacyText = await deps.loadLegacy();
      if (legacyText === null) {
        migrationDone = true;
        return true;
      }
      const indexText = await deps.loadIndex();
      if (indexText !== null) {
        // 前回、名前を変える前に止まった。スレッドと一覧はもう書いてある。その一覧を使い続ける。
        engine.index = deserializeIndex(indexText);
        await deps.archiveLegacy();
        migrationDone = true;
        return true;
      }
      // 起動している端末のキーがそろうまで待つ。そろわないまま分けると、起動中の Agent のレスがタブに出ないスレッドに入る。
      // Agent の一覧が空のときも待つ。一時的に空になっただけかもしれない。
      if (all.length === 0 || all.some((a) => a.key === null)) return false;
      const liveKeys = {};
      for (const a of all) liveKeys[a.address] = a.key;
      const result = migrate(deserialize(legacyText, now), liveKeys, now);
      let index = emptyIndex();
      for (const t of result.threads) {
        await deps.saveThread(t.key, serialize(t));
        index = upsertIndex(index, t, now);
      }
      await deps.saveIndex(serializeIndex(index));
      await deps.archiveLegacy();
      engine.index = index;
      const migrated = {};
      for (const t of result.threads) {
        engine.threads[t.key] = t;
        loaded.add(t.key);
        migrated[t.key] = nextNo(t) - 1;
      }
      engine.migrated = migrated;
      migrationDone = true;
      if (!engine.paused) engine.error = null;
      deps.changed(null);
      return true;
    } catch (e) {
      engine.error = `スレッドの移行に失敗しました。次の見回りでやり直します: ${message(e)}`;
      return false;
    }
  }

  /** 起動しておらず、最後のレスから 7 日たったスレッドを消す。 */
  async function prune(liveKeys, now) {
    const keys = staleKeys(engine.index, liveKeys, now);
    if (keys.length === 0) return;
    for (const key of keys) {
      try {
        await deps.removeThread(key);
      } catch {
        continue; // 消せなかったものは一覧に残し、次にまた試す
      }
      engine.index = removeFromIndex(engine.index, key);
      delete engine.threads[key];
      loaded.delete(key);
    }
    try {
      await deps.saveIndex(serializeIndex(engine.index));
    } catch (e) {
      engine.error = `スレッドの一覧の保存に失敗しました: ${message(e)}`;
    }
    deps.changed(null);
  }

  async function step(now) {
    const cfg = deps.config();
    const all = deps.listAgents().filter((a) => !cfg.exclude_spaces.includes(a.space_name));
    if (!migrationDone && !(await migrateIfNeeded(all, now))) return;

    // キーの付いていない Agent（端末の作成時刻をまだ読めていない）は、いないものとして扱う
    const live = all.filter((a) => a.key !== null);
    const names = agentNames(all);

    // 一覧が空か、キーを読めていない Agent がある間は消さない。起動中の Agent のスレッドを、起動していないものと取り違える。
    const complete = all.length > 0 && all.every((a) => a.key !== null);
    if (complete && (lastPruneAt === null || now - lastPruneAt >= PRUNE_EVERY_MS)) {
      lastPruneAt = now;
      await prune(live.map((a) => a.key), now);
    }

    // 観測。作業中の Agent だけ画面を読む。読めない Agent は一覧にないものとして扱う。
    const screens = {};
    const obs = [];
    for (const a of live) {
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

    const view = live.find((a) => a.address === trigger.address);
    const chat = trigger.kind === "chat";
    let screen = null;
    try {
      if (!view) throw new Error("gone");
      if (!chat) screen = screens[trigger.address] ?? (await deps.readScreen(trigger.address));
    } catch {
      state = drop(state, trigger);
      return;
    }
    const name = names[view.address];

    // 書き込むのは、きっかけの対象の Agent のスレッドだけ。
    // 保存された内容を読めないときは、新しいスレッドで上書きせず、次の tick でやり直す。
    const key = view.key;
    if (!loaded.has(key) && !(await read(key, now))) return;
    let thread = engine.threads[key] ?? newThread(now, { key, address: view.address, name, color: nextColor(engine.index) });
    if (thread.name !== name) thread = { ...thread, name };

    const since = workingSince(state, view.address);
    const agent = chat ? null : {
      name, address: view.address, space: view.space_name, tab: view.tab_name,
      status: view.status, workingForSec: since === null ? 0 : Math.floor((now - since) / 1000),
    };

    // スレタイは、ないときと、付けてから TITLE_REFRESH_MS たったときに頼む。レスの生成に相乗りし、呼び出しは増やさない。
    const needTitle = thread.title === null || now - (thread.titleAt ?? thread.startedAt) >= TITLE_REFRESH_MS;
    const user = buildUserPrompt({
      kind: trigger.kind, agent, screen,
      recent: thread.posts.slice(-RECENT_MAX),
      needTitle,
      currentTitle: thread.title,
      nextNo: nextNo(thread),
    });
    calls = record(calls, now);
    state = commit(state, trigger, now);
    const before = engine.threads[key];

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
        deps.changed(null);
      }
      return;
    }
    failures = 0;
    if (parsed.posts.length === 0) return;

    // 生成の間に次スレにされていたら、新しいスレッドに書く。古いスレッドに足すと、次スレが取り消される。
    const current = engine.threads[key];
    const base = current && current !== before ? { ...current, name } : thread;
    // 雑談は野次馬のレスだけにする
    let next = append(base, parsed.posts, chat ? null : { address: view.address, name }, now, deps.rand);
    if (needTitle && parsed.title) next = setTitle(next, parsed.title, now);
    else if (next.title === null) next = setTitle(next, `【実況】${name} スレ`, now);
    engine.threads[key] = next;
    await persist(key, now);
  }

  return engine;
}
