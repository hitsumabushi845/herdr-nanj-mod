import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { DEFAULTS } from "../mods/nanj/config.js";
import { newThread, append, setTitle, serialize, serializeIndex, deserializeIndex, PRUNE_AFTER_MS } from "../mods/nanj/thread.js";
import {
  createEngine, holdsLease, needsReload, applyEnabled, LEASE_MS, MAX_FAILURES, TITLE_REFRESH_MS, PRUNE_EVERY_MS,
} from "../mods/nanj/engine.js";

const agent = (address, status, space_name = "api", tab_name = "1", key = `${address}@1`) =>
  ({ address, status, space: "s-" + space_name, space_name, tab_name, key });
const reply = (body = "テスト回しとるンゴ", title) => JSON.stringify({ ...(title ? { title } : {}), posts: [{ who: "agent", body }] });
const owner = (address, name = "api", color = 0) => ({ key: `${address}@1`, address, name, color });
const K1 = "t1@1";
const K2 = "t2@1";

/** 偽の依存。呼び出しを記録し、テストごとに差し替えられる。 */
function fake(over = {}) {
  const f = {
    agents: [agent("t1", "working")],
    screens: { t1: "⏺ 作業中やで" },
    cfg: { ...DEFAULTS, chat_interval_min: 0 },
    files: {},
    index: null,
    legacy: null,
    archived: 0,
    removed: [],
    failIndex: 0,
    log: { read: [], generate: [], saveThread: [], loadThread: [], saveIndex: 0, changed: [] },
    respond: async () => reply(),
  };
  Object.assign(f, over);
  f.deps = {
    listAgents: () => f.agents,
    readScreen: async (address) => {
      f.log.read.push(address);
      if (!(address in f.screens)) throw new Error("no such terminal");
      return f.screens[address];
    },
    generate: async (system, user) => {
      f.log.generate.push({ system, user });
      return f.respond(user);
    },
    loadThread: async (key) => { f.log.loadThread.push(key); return f.files[key] ?? null; },
    saveThread: async (key, text) => { f.log.saveThread.push(key); f.files[key] = text; },
    removeThread: async (key) => { f.removed.push(key); delete f.files[key]; },
    loadIndex: async () => f.index,
    saveIndex: async (text) => {
      if (f.failIndex > 0) { f.failIndex--; throw new Error("index disk full"); }
      f.log.saveIndex++;
      f.index = text;
    },
    loadLegacy: async () => f.legacy,
    archiveLegacy: async () => { f.archived++; f.legacy = null; },
    config: () => f.cfg,
    rand: () => 0,
    changed: (key) => { f.log.changed.push(key); },
  };
  return f;
}

async function started(over) {
  const f = fake(over);
  const e = createEngine(f.deps);
  await e.init(0);
  return { f, e };
}

const two = () => ({ agents: [agent("t1", "working"), agent("t2", "working", "web")], screens: { t1: "t1 の画面", t2: "t2 の画面" } });

describe("tick", () => {
  it("作業中の Agent がなければ、10 分ぶんの tick でモデルも画面も呼ばない", async () => {
    const { f, e } = await started({ agents: [agent("t1", "idle"), agent("t2", "blocked")] });
    for (let now = 0; now <= 600000; now += 15000) await e.tick(now);
    expect(f.log.generate.length).toBe(0);
    expect(f.log.read.length).toBe(0);
    expect(f.log.saveThread.length).toBe(0);
  });

  it("作業中の Agent を見たら、その Agent のスレッドを作り、スレタイを頼んでレスを保存する", async () => {
    const { f, e } = await started({ respond: async () => reply("plan 回しとるで", "【悲報】ワイ、plan が終わらない") });
    await e.tick(0);
    expect(f.log.generate.length).toBe(1);
    expect(f.log.generate[0].user).toContain("スレタイ");
    expect(f.log.generate[0].user).toContain("作業中やで");
    expect(f.log.generate[0].user).toContain("次のレスは 1 番");
    expect(e.threads[K1]).toMatchObject({ key: K1, address: "t1", name: "api", color: 0, title: "【悲報】ワイ、plan が終わらない" });
    expect(e.threads[K1].posts).toEqual([{ no: 1, name: "api", id: "t1", agent: "t1", at: 0, body: "plan 回しとるで" }]);
    expect(JSON.parse(f.files[K1]).posts.length).toBe(1);
    expect(deserializeIndex(f.index).threads).toEqual([{ key: K1, address: "t1", name: "api", color: 0, lastPostAt: 0 }]);
    expect(f.log.changed).toContain(K1);
  });

  it("応答にスレタイがなければ、Agent の名前から付ける", async () => {
    const { e } = await started();
    await e.tick(0);
    expect(e.threads[K1].title).toBe("【実況】api スレ");
  });

  it("スレタイが決まったあとは頼まない", async () => {
    const { f, e } = await started();
    await e.tick(0);
    f.screens.t1 = "⏺ 次の作業やで";
    await e.tick(90000);
    expect(f.log.generate.length).toBe(2);
    expect(f.log.generate[1].user).not.toContain("スレタイ");
    expect(f.log.generate[1].user).toContain("テスト回しとるンゴ");
  });

  it("スレタイが 30 分より古くなったら、次のレスと一緒に付け直す", async () => {
    expect(TITLE_REFRESH_MS).toBe(1800000);
    const { f, e } = await started({ respond: async () => reply("a", "【朗報】最初の題") });
    await e.tick(0);
    f.screens.t1 = "別の作業";
    f.respond = async () => reply("b", "【速報】新しい題");
    await e.tick(1799000);
    expect(e.threads[K1].title).toBe("【朗報】最初の題");
    f.screens.t1 = "さらに別の作業";
    await e.tick(1799000 + 90000);
    expect(f.log.generate.at(-1).user).toContain("付け直す");
    expect(e.threads[K1].title).toBe("【速報】新しい題");
    expect(e.threads[K1].posts.map((p) => p.no)).toEqual([1, 2, 3]);
  });

  it("付け直しを頼んでも応答にスレタイがなければ、今のスレタイを残して次も頼む", async () => {
    const { f, e } = await started({ respond: async () => reply("a", "【朗報】最初の題") });
    await e.tick(0);
    f.respond = async () => reply("b");
    f.screens.t1 = "別の作業";
    await e.tick(1800000);
    expect(e.threads[K1].title).toBe("【朗報】最初の題");
    f.screens.t1 = "さらに別の作業";
    await e.tick(1800000 + 90000);
    expect(f.log.generate.at(-1).user).toContain("付け直す");
  });

  it("生成が終わらないうちは次の生成を始めない", async () => {
    let release;
    const { f, e } = await started({ respond: () => new Promise((r) => { release = () => r(reply()); }) });
    const first = e.tick(0);
    await new Promise((r) => setTimeout(r, 0));
    await e.tick(30000);
    expect(f.log.generate.length).toBe(1);
    release();
    await first;
    expect(e.threads[K1].posts.length).toBe(1);
  });

  it("working から idle になったら完了としてレスを作る", async () => {
    const { f, e } = await started();
    await e.tick(0);
    f.agents = [agent("t1", "idle")];
    await e.tick(30000);
    expect(f.log.generate.length).toBe(2);
    expect(f.log.generate[1].user).toContain("完了");
    expect(e.threads[K1].posts.length).toBe(2);
  });

  it("除外した space の Agent の画面は読まない", async () => {
    const { f, e } = await started({ cfg: { ...DEFAULTS, exclude_spaces: ["api"] } });
    await e.tick(0);
    expect(f.log.read.length).toBe(0);
    expect(f.log.generate.length).toBe(0);
  });

  it("応答が 0 件でも失敗にしない", async () => {
    const { f, e } = await started({ respond: async () => '{"posts":[]}' });
    await e.tick(0);
    expect(e.threads[K1]).toBeUndefined();
    expect(e.error).toBeNull();
    expect(f.log.saveThread.length).toBe(0);
  });
});

describe("Agent ごとのスレッド", () => {
  it("2 つの Agent のレスは、それぞれのスレッドにだけ入る", async () => {
    const { f, e } = await started(two());
    await e.tick(0);
    await e.tick(15000);
    expect(f.log.generate.length).toBe(1);
    await e.tick(30000);
    expect(e.threads[K1].posts.map((p) => p.agent)).toEqual(["t1"]);
    expect(e.threads[K2].posts.map((p) => p.agent)).toEqual(["t2"]);
    expect(e.threads[K2]).toMatchObject({ key: K2, address: "t2", name: "web", color: 1 });
    expect(Object.keys(f.files).sort()).toEqual([K1, K2]);
    expect(deserializeIndex(f.index).threads.map((x) => x.key)).toEqual([K1, K2]);
    expect(f.log.changed).toEqual(expect.arrayContaining([K1, K2]));
  });

  it("直近のレスとスレタイは、そのスレッドのものだけを使う", async () => {
    const { f, e } = await started({ ...two(), respond: async (user) => reply(user.includes("t1 の画面") ? "t1だけの話" : "t2だけの話") });
    await e.tick(0);
    await e.tick(30000);
    expect(f.log.generate[1].user).toContain("t2 の画面");
    expect(f.log.generate[1].user).not.toContain("t1だけの話");
    expect(f.log.generate[1].user).toContain("まだスレタイがない");
    expect(f.log.generate[1].user).toContain("次のレスは 1 番");
    f.screens.t1 = "t1 の画面その 2";
    await e.tick(120000);
    expect(f.log.generate[2].user).toContain("t1だけの話");
    expect(f.log.generate[2].user).not.toContain("t2だけの話");
    expect(f.log.generate[2].user).toContain("次のレスは 2 番");
  });

  it("キーの付いていない Agent は見ない。キーが付いたらレスが付く", async () => {
    const { f, e } = await started({ agents: [agent("t1", "working", "api", "1", null)] });
    await e.tick(0);
    await e.tick(30000);
    expect(f.log.read.length).toBe(0);
    expect(f.log.generate.length).toBe(0);
    expect(e.threads).toEqual({});
    f.agents = [agent("t1", "working")];
    await e.tick(60000);
    expect(e.threads[K1].posts.length).toBe(1);
  });

  it("保存されたスレッドがあれば、続きの番号で書く", async () => {
    let t = setTitle(newThread(0, owner("t1")), "前からの題", 0);
    for (let i = 0; i < 41; i++) t = append(t, [{ who: "yajiuma", body: "x" }], null, i, () => 0);
    const { f, e } = await started({ files: { [K1]: serialize(t) } });
    await e.tick(5000);
    expect(f.log.generate[0].user).toContain("次のレスは 42 番");
    expect(e.threads[K1].posts.at(-1)).toMatchObject({ no: 42, name: "api" });
    expect(e.threads[K1].title).toBe("前からの題");
  });

  it("Agent の名前が変わったら、スレッドと一覧の名前も変える", async () => {
    const { f, e } = await started({ files: { [K1]: serialize(newThread(0, owner("t1", "古い名前"))) } });
    await e.tick(0);
    expect(e.threads[K1].name).toBe("api");
    expect(deserializeIndex(f.index).threads[0].name).toBe("api");
  });

  it("一覧が壊れていてもスレッドは読め、次の保存で一覧が作り直される", async () => {
    const t = append(newThread(0, owner("t1")), [{ who: "yajiuma", body: "前のレス" }], null, 1, () => 0);
    const { f, e } = await started({ files: { [K1]: serialize(t) }, index: "{壊れた" });
    await e.tick(5000);
    expect(e.threads[K1].posts.map((p) => p.no)).toEqual([1, 2]);
    expect(deserializeIndex(f.index).threads.map((x) => x.key)).toEqual([K1]);
    expect(e.error).toBeNull();
  });

  it("一覧の保存に失敗しても、スレッドは保存され、理由を出す", async () => {
    const { f, e } = await started({ failIndex: 1 });
    await e.tick(0);
    expect(JSON.parse(f.files[K1]).posts.length).toBe(1);
    expect(e.threads[K1].posts.length).toBe(1);
    expect(e.error).toContain("index disk full");
    expect(e.paused).toBe(false);
    f.screens.t1 = "次の画面";
    await e.tick(90000);
    expect(e.error).toBeNull();
    expect(deserializeIndex(f.index).threads).toHaveLength(1);
  });

  it("スレッドの読み込みに失敗したら、新しいスレッドで上書きせず、次にやり直す", async () => {
    const { f, e } = await started();
    const load = f.deps.loadThread;
    f.deps.loadThread = async () => { throw new Error("io"); };
    await e.tick(0);
    expect(f.log.generate.length).toBe(0);
    expect(f.log.saveThread.length).toBe(0);
    f.deps.loadThread = load;
    await e.tick(30000);
    expect(e.threads[K1].posts.length).toBe(1);
  });

  it("雑談は、作業中の Agent のスレッドに野次馬のレスとして入る", async () => {
    const { f, e } = await started({ cfg: { ...DEFAULTS, chat_interval_min: 10 } });
    await e.tick(0);
    await e.tick(600000); // 待ちが先に出る
    await e.tick(630000);
    const last = f.log.generate.at(-1).user;
    expect(last).toContain("雑談");
    expect(last).not.toContain("<screen>");
    expect(last).toContain("テスト回しとるンゴ");
    expect(e.threads[K1].posts.at(-1).agent).toBeNull();
    expect(Object.keys(e.threads)).toEqual([K1]);
  });

  it("生成の途中で次スレにしたら、レスは新しいスレッドに入り、次スレが取り消されない", async () => {
    let release;
    const { f, e } = await started();
    await e.tick(0);
    f.screens.t1 = "次の画面";
    f.respond = () => new Promise((r) => { release = () => r(reply("あとから届いたレス")); });
    const running = e.tick(90000);
    await new Promise((r) => setTimeout(r, 0));
    await e.rotate(K1, 91000);
    release();
    await running;
    expect(e.threads[K1].posts.map((p) => [p.no, p.body])).toEqual([[1, "あとから届いたレス"]]);
    expect(e.threads[K1].startedAt).toBe(91000);
    expect(e.threads[K1].title).toBe("【実況】api スレ");
  });

  it("rotate は、そのスレッドだけを同じ持ち主の空のスレッドにする", async () => {
    const { f, e } = await started(two());
    await e.tick(0);
    await e.tick(30000);
    await e.rotate(K1, 40000);
    expect(e.threads[K1]).toEqual(newThread(40000, owner("t1")));
    expect(JSON.parse(f.files[K1]).posts).toEqual([]);
    expect(e.threads[K2].posts.length).toBe(1);
    await e.rotate("none@1", 50000);
  });
});

describe("失敗", () => {
  it("生成が 3 回続けて失敗したら止まり、理由を出す", async () => {
    expect(MAX_FAILURES).toBe(3);
    const { f, e } = await started({ respond: async () => { throw new Error("claude が見つからない"); } });
    for (const now of [0, 90000, 180000]) {
      f.screens.t1 = "画面 " + now;
      await e.tick(now);
    }
    expect(e.paused).toBe(true);
    expect(e.error).toContain("claude が見つからない");
    f.screens.t1 = "さらに別の画面";
    await e.tick(400000);
    expect(f.log.generate.length).toBe(3);
  });

  it("読めない応答は失敗に数え、スレッドを作らない", async () => {
    const { f, e } = await started({ respond: async () => "JSON ちゃうで" });
    for (const now of [0, 90000, 180000]) {
      f.screens.t1 = "画面 " + now;
      await e.tick(now);
    }
    expect(e.threads).toEqual({});
    expect(e.paused).toBe(true);
    expect(f.log.saveThread.length).toBe(0);
  });

  it("成功すると失敗の数が戻る", async () => {
    let n = 0;
    const { f, e } = await started({ respond: async () => { n++; if (n === 3) return reply(); throw new Error("x"); } });
    for (const now of [0, 90000, 180000, 270000, 360000]) {
      f.screens.t1 = "画面 " + now;
      await e.tick(now);
    }
    expect(e.paused).toBe(false);
    expect(f.log.generate.length).toBe(5);
  });

  it("再開すると理由が消え、また生成する", async () => {
    const { f, e } = await started({ respond: async () => { throw new Error("x"); } });
    for (const now of [0, 90000, 180000]) {
      f.screens.t1 = "画面 " + now;
      await e.tick(now);
    }
    e.setPaused(false);
    expect(e.error).toBeNull();
    f.respond = async () => reply();
    f.screens.t1 = "再開後の画面";
    await e.tick(300000);
    expect(e.threads[K1].posts.length).toBe(1);
  });

  it("止めている間は何もしない", async () => {
    const { f, e } = await started();
    e.setPaused(true);
    await e.tick(0);
    expect(f.log.read.length).toBe(0);
    expect(f.log.generate.length).toBe(0);
  });

  it("完了の Agent の端末が消えていたら、生成せず、失敗にも数えない", async () => {
    const { f, e } = await started();
    await e.tick(0);
    f.agents = [agent("t1", "idle")];
    delete f.screens.t1;
    await e.tick(30000);
    await e.tick(60000);
    expect(f.log.generate.length).toBe(1);
    expect(e.error).toBeNull();
    expect(e.paused).toBe(false);
  });

  it("作業中の Agent の画面が読めなければ、その Agent はいないものとして扱う", async () => {
    const { f, e } = await started({ screens: {} });
    await e.tick(0);
    expect(f.log.generate.length).toBe(0);
    expect(e.error).toBeNull();
  });

  it("スレッドの保存に失敗しても落ちず、理由を出す", async () => {
    const { f, e } = await started();
    f.deps.saveThread = async () => { throw new Error("disk full"); };
    await e.tick(0);
    expect(e.threads[K1].posts.length).toBe(1);
    expect(e.error).toContain("disk full");
    expect(e.paused).toBe(false);
  });
});

describe("スレッドは Agent ごとに 1 本のまま続く", () => {
  it("1000 レスに達しても同じスレッドに続けて書き、番号を続ける", async () => {
    let full = setTitle(newThread(0, owner("t1")), "ずっと続くスレ", 0);
    for (let i = 0; i < 1000; i++) full = append(full, [{ who: "yajiuma", body: "x" }], null, i, () => 0);
    const { f, e } = await started({ files: { [K1]: serialize(full) } });
    await e.tick(5000);
    expect(e.threads[K1].title).toBe("ずっと続くスレ");
    expect(e.threads[K1].startedAt).toBe(0);
    expect(e.threads[K1].posts.length).toBe(1000);
    expect(e.threads[K1].posts.at(-1)).toMatchObject({ no: 1001, name: "api" });
    expect(f.log.generate[0].user).toContain("次のレスは 1001 番");
  });

  it("作業中なしが長く続いたあとで作業が始まっても、同じスレッドに続けて書く", async () => {
    const { f, e } = await started();
    await e.tick(0);
    f.agents = [agent("t1", "idle")];
    await e.tick(30000);
    await e.tick(60000);
    f.agents = [agent("t1", "working")];
    f.screens.t1 = "翌日の作業";
    await e.tick(30000 + 24 * 3600000);
    expect(e.threads[K1].startedAt).toBe(0);
    expect(e.threads[K1].posts.map((p) => p.no)).toEqual([1, 2, 3]);
  });
});

describe("移行", () => {
  const post = (no, a, at) => ({ no, name: a ? "n-" + a : "風吹けば名無し", id: a ?? "x" + no, agent: a, at, body: "b" + no });
  const legacy = () => serialize({ ...newThread(0), title: "旧題", titleAt: 1, colors: { t1: 2, t9: 5 },
    posts: [post(1, "t1", 10), post(2, null, 10), post(3, "t9", 20), post(4, null, 30), post(5, "t1", 40)] });
  const idle = { agents: [agent("t1", "idle")] };

  it("1 本のスレッドを端末ごとのファイルに分け、元のファイルを残す名前に変える", async () => {
    const { f, e } = await started({ ...idle, legacy: legacy() });
    await e.tick(100);
    expect(Object.keys(f.files).sort()).toEqual(["t1@1", "t9@0"]);
    expect(JSON.parse(f.files["t1@1"]).posts.map((p) => p.no)).toEqual([1, 2, 5]);
    expect(JSON.parse(f.files["t9@0"]).posts.map((p) => p.no)).toEqual([3]);
    expect(deserializeIndex(f.index).threads.map((x) => [x.key, x.color])).toEqual([["t1@1", 2], ["t9@0", 5]]);
    expect(f.archived).toBe(1);
    expect(e.migrated).toEqual({ "t1@1": 5, "t9@0": 3 });
    expect(e.threads["t1@1"].posts.length).toBe(3);
    expect(f.log.changed).toContain(null);
  });

  it("起動中の Agent のキーがわからない間は、移行もレスの生成もしない", async () => {
    const { f, e } = await started({ agents: [agent("t1", "working", "api", "1", null)], legacy: legacy() });
    await e.tick(100);
    expect(f.files).toEqual({});
    expect(f.archived).toBe(0);
    expect(f.log.generate.length).toBe(0);
    f.agents = [agent("t1", "working")];
    await e.tick(200);
    expect(f.archived).toBe(1);
    expect(Object.keys(f.files).sort()).toEqual(["t1@1", "t9@0"]);
  });

  it("除外した space の Agent のキーは待たない", async () => {
    const { f, e } = await started({ agents: [agent("t1", "idle"), agent("t5", "idle", "secret", "1", null)],
      cfg: { ...DEFAULTS, exclude_spaces: ["secret"] }, legacy: legacy() });
    await e.tick(100);
    expect(f.archived).toBe(1);
  });

  it("一覧の保存で止まっても、やり直してレスが 2 重にならない", async () => {
    const { f, e } = await started({ ...idle, legacy: legacy(), failIndex: 1 });
    await e.tick(100);
    expect(f.archived).toBe(0);
    expect(e.error).toContain("index disk full");
    await e.tick(200);
    expect(f.archived).toBe(1);
    expect(JSON.parse(f.files["t1@1"]).posts.map((p) => p.no)).toEqual([1, 2, 5]);
    expect(e.error).toBeNull();
  });

  it("一覧があるのに元のファイルも残っていたら、名前を変えるだけにする", async () => {
    const t = append(newThread(0, owner("t1")), [{ who: "yajiuma", body: "新しい" }], null, 1, () => 0);
    const { f, e } = await started({ ...idle, legacy: legacy(), files: { [K1]: serialize(t) }, index: serializeIndex({ v: 1, threads: [] }) });
    await e.tick(100);
    expect(f.archived).toBe(1);
    expect(JSON.parse(f.files[K1]).posts.map((p) => p.body)).toEqual(["新しい"]);
    expect(e.migrated).toBeNull();
  });

  it("移行のあとのレスは、元の番号の続きになる", async () => {
    const { f, e } = await started({ legacy: legacy() });
    await e.tick(100);
    expect(e.threads[K1].posts.at(-1)).toMatchObject({ no: 6, agent: "t1" });
    expect(f.log.generate[0].user).toContain("まだスレタイがない");
  });

  it("Agent の一覧が空の間は移行しない", async () => {
    const { f, e } = await started({ agents: [], legacy: legacy() });
    await e.tick(100);
    expect(f.files).toEqual({});
    expect(f.archived).toBe(0);
    f.agents = [agent("t1", "idle")];
    await e.tick(200);
    expect(JSON.parse(f.files["t1@1"]).posts.map((p) => p.no)).toEqual([1, 2, 5]);
  });

  it("名前を変えるだけのときも、保存されている一覧を使い続ける", async () => {
    const kept = { key: "t7@1", address: "t7", name: "old", color: 4, lastPostAt: 50 };
    const { f, e } = await started({ legacy: legacy(), index: null });
    f.index = serializeIndex({ v: 1, threads: [kept] });
    await e.tick(100);
    expect(f.archived).toBe(1);
    expect(deserializeIndex(f.index).threads.map((x) => x.key)).toEqual(["t7@1", K1]);
    expect(e.threads[K1].color).toBe(5);
  });

  it("元のファイルがなければ何もしない", async () => {
    const { f, e } = await started(idle);
    await e.tick(100);
    expect(f.archived).toBe(0);
    expect(e.migrated).toBeNull();
  });
});

describe("古いスレッド", () => {
  const entry = (key, lastPostAt) => ({ key, address: key.split("@")[0], name: "n", color: 0, lastPostAt });
  const NOW = PRUNE_AFTER_MS + 86400000;
  const withIndex = (threads, over = {}) => ({ agents: [agent("t1", "idle")], index: serializeIndex({ v: 1, threads }),
    files: Object.fromEntries(threads.map((t) => [t.key, serialize(newThread(0, { ...t }))])), ...over });

  it("起動しておらず、最後のレスから 7 日たったスレッドを消す", async () => {
    const { f, e } = await started(withIndex([entry("t5@1", 0), entry("t6@1", NOW - PRUNE_AFTER_MS + 86400000), entry(K1, 0)]));
    await e.tick(NOW);
    expect(f.removed).toEqual(["t5@1"]);
    expect(deserializeIndex(f.index).threads.map((x) => x.key)).toEqual(["t6@1", K1]);
    expect(e.index.threads.map((x) => x.key)).toEqual(["t6@1", K1]);
  });

  it("Agent の一覧が空でも、7 日たっていないスレッドは消さない", async () => {
    const { f, e } = await started(withIndex([entry("t6@1", NOW - 86400000)], { agents: [] }));
    await e.tick(NOW);
    expect(f.removed).toEqual([]);
  });

  it("Agent の一覧が空か、キーを読めていない Agent がある間は消さず、そろったら消す", async () => {
    const { f, e } = await started(withIndex([entry("t5@1", 0)], { agents: [] }));
    await e.tick(NOW);
    expect(f.removed).toEqual([]);
    f.agents = [agent("t1", "idle", "api", "1", null)];
    await e.tick(NOW + 15000);
    expect(f.removed).toEqual([]);
    f.agents = [agent("t1", "idle")];
    await e.tick(NOW + 30000);
    expect(f.removed).toEqual(["t5@1"]);
  });

  it("削除は 1 時間に 1 回だけ試す", async () => {
    expect(PRUNE_EVERY_MS).toBe(3600000);
    const { f, e } = await started(withIndex([entry("t5@1", 0)]));
    await e.tick(NOW);
    f.index = serializeIndex({ v: 1, threads: [entry("t7@1", 0)] });
    await e.reload(null, NOW);
    await e.tick(NOW + 15000);
    expect(f.removed).toEqual(["t5@1"]);
    await e.tick(NOW + PRUNE_EVERY_MS);
    expect(f.removed).toEqual(["t5@1", "t7@1"]);
  });
});

describe("読み込み", () => {
  it("init は一覧を読む。壊れていれば空で始まる", async () => {
    const { e } = await started({ index: "{壊れた" });
    expect(e.index.threads).toEqual([]);
    expect(e.threads).toEqual({});
  });
  it("ensure は、まだ読んでいないスレッドだけを読む", async () => {
    const t = append(newThread(0, owner("t1")), [{ who: "yajiuma", body: "保存済み" }], null, 1, () => 0);
    const { f, e } = await started({ files: { [K1]: serialize(t) } });
    expect(await e.ensure([K1, K2], 5)).toBe(true);
    expect(e.threads[K1].posts[0].body).toBe("保存済み");
    expect(e.threads[K2]).toBeUndefined();
    expect(await e.ensure([K1, K2], 6)).toBe(false);
    expect(f.log.loadThread).toEqual([K1, K2]);
  });
  it("ensure で読み込みに失敗したキーは、次にまた読む", async () => {
    const { f, e } = await started();
    const load = f.deps.loadThread;
    f.deps.loadThread = async () => { throw new Error("io"); };
    await e.ensure([K1], 5);
    f.deps.loadThread = load;
    f.files[K1] = serialize(newThread(0, owner("t1")));
    expect(await e.ensure([K1], 6)).toBe(true);
    expect(e.threads[K1]).toBeDefined();
  });
  it("reload は保存された内容を読み直す。失敗したら手元のスレッドを残す", async () => {
    const { f, e } = await started();
    await e.tick(0);
    f.files[K1] = serialize(append(newThread(1, owner("t1")), [{ who: "yajiuma", body: "外から" }], null, 2, () => 0));
    await e.reload(K1, 3);
    expect(e.threads[K1].posts[0].body).toBe("外から");
    f.deps.loadThread = async () => { throw new Error("too large"); };
    await e.reload(K1, 5);
    expect(e.threads[K1].posts[0].body).toBe("外から");
  });
  it("reload でファイルがなくなっていたら、手元のスレッドも外す", async () => {
    const { f, e } = await started();
    await e.tick(0);
    delete f.files[K1];
    await e.reload(K1, 3);
    expect(e.threads[K1]).toBeUndefined();
  });
  it("別のキーのスレッドが入ったファイルは使わない", async () => {
    const { e } = await started({ files: { [K1]: serialize(newThread(0, owner("t2"))) } });
    await e.ensure([K1], 1);
    expect(e.threads[K1]).toBeUndefined();
  });
});

describe("holdsLease", () => {
  it("リースがない、自分のもの、45 秒以上古いときに持てる", () => {
    expect(LEASE_MS).toBe(45000);
    expect(holdsLease(null, "a", 0)).toBe(true);
    expect(holdsLease(undefined, "a", 0)).toBe(true);
    expect(holdsLease({ id: "a", at: 0 }, "a", 999999)).toBe(true);
    expect(holdsLease({ id: "b", at: 0 }, "a", 44999)).toBe(false);
    expect(holdsLease({ id: "b", at: 0 }, "a", 45000)).toBe(true);
    expect(holdsLease("壊れた値", "a", 0)).toBe(true);
  });
});

describe("applyEnabled", () => {
  it("初めてのときは設定の enabled に従う", () => {
    expect(applyEnabled(undefined, undefined, true)).toEqual({ paused: false, applied: true });
    expect(applyEnabled(undefined, undefined, false)).toEqual({ paused: true, applied: false });
  });
  it("設定の enabled が変わったら、その値に合わせる", () => {
    expect(applyEnabled(false, true, false)).toEqual({ paused: true, applied: false });
    expect(applyEnabled(true, false, true)).toEqual({ paused: false, applied: true });
  });
  it("設定が変わっていなければ、ボタンで決めた状態を残す", () => {
    expect(applyEnabled(true, true, true)).toEqual({ paused: true, applied: true });
    expect(applyEnabled(false, false, false)).toEqual({ paused: false, applied: false });
  });
});

describe("needsReload", () => {
  it("生成役を引き継いだときは、手元のスレッドが古いので読み直す", () => {
    expect(needsReload(false, true, "r1", "r1")).toBe(true);
  });
  it("生成役でないコピーは、他のコピーが書いたら読み直す", () => {
    expect(needsReload(false, false, "r2", "r1")).toBe(true);
    expect(needsReload(false, false, "r1", "r1")).toBe(false);
  });
  it("生成役を続けている間は読み直さない", () => {
    expect(needsReload(true, true, "r2", "r1")).toBe(false);
  });
  it("生成役を降りたときは、書かれていれば読み直す", () => {
    expect(needsReload(true, false, "r2", "r1")).toBe(true);
    expect(needsReload(true, false, "r1", "r1")).toBe(false);
  });
});

describe("mod の決まり", () => {
  const dir = new URL("../mods/nanj/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  it("main.js 以外は herdr と gpui を import しない", () => {
    for (const f of files.filter((f) => f !== "main.js")) {
      expect(readFileSync(new URL(f, dir), "utf8"), f).not.toMatch(/from\s+["'](herdr|gpui-kit|gpui-base)["']/);
    }
  });
  it("Agent の端末に入力を送る呼び出しがない", () => {
    expect(files).toContain("main.js");
    for (const f of files) {
      expect(readFileSync(new URL(f, dir), "utf8"), f).not.toMatch(/["'](send|keys|interrupt|kill|put)["']|terminal\.(paste|kill)/);
    }
  });
});
