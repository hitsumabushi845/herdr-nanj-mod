import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { DEFAULTS } from "../mods/nanj/config.js";
import { newThread, append, serialize } from "../mods/nanj/thread.js";
import { createEngine, holdsLease, LEASE_MS, MAX_FAILURES } from "../mods/nanj/engine.js";

const agent = (address, status, space_name = "api", tab_name = "1") => ({ address, status, space: "s-" + space_name, space_name, tab_name });
const reply = (body = "テスト回しとるンゴ", title) => JSON.stringify({ ...(title ? { title } : {}), posts: [{ who: "agent", body }] });

/** 偽の依存。呼び出しを記録し、テストごとに差し替えられる。 */
function fake(over = {}) {
  const f = {
    agents: [agent("t1", "working")],
    screens: { t1: "⏺ 作業中やで" },
    cfg: { ...DEFAULTS, chat_interval_min: 0 },
    stored: null,
    log: { read: [], generate: [], save: 0, changed: 0 },
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
    load: async () => f.stored,
    save: async (text) => { f.log.save++; f.stored = text; },
    config: () => f.cfg,
    rand: () => 0,
    changed: () => { f.log.changed++; },
  };
  return f;
}

async function started(over) {
  const f = fake(over);
  const e = createEngine(f.deps);
  await e.init(0);
  return { f, e };
}

describe("tick", () => {
  it("作業中の Agent がなければ、10 分ぶんの tick でモデルも画面も呼ばない", async () => {
    const { f, e } = await started({ agents: [agent("t1", "idle"), agent("t2", "blocked")] });
    for (let now = 0; now <= 600000; now += 15000) await e.tick(now);
    expect(f.log.generate.length).toBe(0);
    expect(f.log.read.length).toBe(0);
    expect(f.log.save).toBe(0);
  });

  it("作業中の Agent を見たら、スレタイを頼んでレスを作り、保存する", async () => {
    const { f, e } = await started({ respond: async () => reply("plan 回しとるで", "【悲報】ワイ、plan が終わらない") });
    await e.tick(0);
    expect(f.log.generate.length).toBe(1);
    expect(f.log.generate[0].user).toContain("スレタイ");
    expect(f.log.generate[0].user).toContain("作業中やで");
    expect(f.log.generate[0].user).toContain("次のレスは 1 番");
    expect(e.thread.title).toBe("【悲報】ワイ、plan が終わらない");
    expect(e.thread.posts).toEqual([{ no: 1, name: "api", id: "t1", agent: "t1", at: 0, body: "plan 回しとるで" }]);
    expect(JSON.parse(f.stored).posts.length).toBe(1);
    expect(f.log.changed).toBeGreaterThan(0);
  });

  it("応答にスレタイがなければ、Agent の名前から付ける", async () => {
    const { e } = await started();
    await e.tick(0);
    expect(e.thread.title).toBe("【実況】api スレ");
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

  it("生成が終わらないうちは次の生成を始めない", async () => {
    let release;
    const { f, e } = await started({ respond: () => new Promise((r) => { release = () => r(reply()); }) });
    const first = e.tick(0);
    await new Promise((r) => setTimeout(r, 0));
    await e.tick(30000);
    expect(f.log.generate.length).toBe(1);
    release();
    await first;
    expect(e.thread.posts.length).toBe(1);
  });

  it("前の呼び出しから 20 秒以内は呼ばない", async () => {
    const { f, e } = await started({ agents: [agent("t1", "working"), agent("t2", "working", "web")], screens: { t1: "a", t2: "b" } });
    await e.tick(0);
    await e.tick(15000);
    expect(f.log.generate.length).toBe(1);
    await e.tick(30000);
    expect(f.log.generate.length).toBe(2);
    expect(e.thread.posts.map((p) => p.name)).toEqual(["api", "web"]);
  });

  it("working から idle になったら完了としてレスを作る", async () => {
    const { f, e } = await started();
    await e.tick(0);
    f.agents = [agent("t1", "idle")];
    await e.tick(30000);
    expect(f.log.generate.length).toBe(2);
    expect(f.log.generate[1].user).toContain("完了");
  });

  it("除外した space の Agent の画面は読まない", async () => {
    const { f, e } = await started({ cfg: { ...DEFAULTS, exclude_spaces: ["api"] } });
    await e.tick(0);
    expect(f.log.read.length).toBe(0);
    expect(f.log.generate.length).toBe(0);
  });

  it("雑談は Agent と画面なしで作り、野次馬のレスになる", async () => {
    const { f, e } = await started({ cfg: { ...DEFAULTS, chat_interval_min: 10 } });
    await e.tick(0);
    await e.tick(600000); // 待ちが先に出る
    await e.tick(630000);
    const last = f.log.generate.at(-1).user;
    expect(last).toContain("雑談");
    expect(last).not.toContain("<screen>");
    expect(e.thread.posts.at(-1).agent).toBeNull();
  });

  it("応答が 0 件でも失敗にしない", async () => {
    const { f, e } = await started({ respond: async () => '{"posts":[]}' });
    await e.tick(0);
    expect(e.thread.posts.length).toBe(0);
    expect(e.thread.title).toBeNull();
    expect(e.error).toBeNull();
    expect(f.log.save).toBe(0);
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

  it("読めない応答は失敗に数え、スレッドを変えない", async () => {
    const { f, e } = await started({ respond: async () => "JSON ちゃうで" });
    for (const now of [0, 90000, 180000]) {
      f.screens.t1 = "画面 " + now;
      await e.tick(now);
    }
    expect(e.thread.posts.length).toBe(0);
    expect(e.paused).toBe(true);
    expect(f.log.save).toBe(0);
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
    expect(e.thread.posts.length).toBe(1);
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

  it("保存に失敗しても落ちず、理由を出す", async () => {
    const { f, e } = await started();
    f.deps.save = async () => { throw new Error("disk full"); };
    await e.tick(0);
    expect(e.thread.posts.length).toBe(1);
    expect(e.error).toContain("disk full");
    expect(e.paused).toBe(false);
  });
});

describe("スレッドの立て直し", () => {
  it("1000 レスのスレッドは次の tick で新しくなる", async () => {
    let full = { ...newThread(0), title: "前スレ" };
    for (let i = 0; i < 1000; i++) full = append(full, [{ who: "yajiuma", body: "x" }], null, i, () => 0);
    const { e } = await started({ stored: serialize(full) });
    expect(e.thread.posts.length).toBe(1000);
    await e.tick(5000);
    expect(e.thread.posts.length).toBe(1);
    expect(e.thread.title).toBe("【実況】api スレ");
    expect(e.thread.startedAt).toBe(5000);
  });

  it("作業中なしが 30 分続いたあとで作業が始まると新しくなる", async () => {
    const { f, e } = await started();
    await e.tick(0);
    f.agents = [agent("t1", "idle")];
    await e.tick(30000);
    expect(e.thread.posts.length).toBe(2);
    await e.tick(60000);
    f.agents = [agent("t1", "working")];
    f.screens.t1 = "翌日の作業";
    await e.tick(30000 + 1800000);
    expect(e.thread.posts.length).toBe(1);
    expect(e.thread.startedAt).toBe(30000 + 1800000);
  });

  it("rotate で空のスレッドになり、保存する", async () => {
    const { f, e } = await started();
    await e.tick(0);
    await e.rotate(1000);
    expect(e.thread).toEqual(newThread(1000));
    expect(JSON.parse(f.stored).posts).toEqual([]);
  });
});

describe("読み込み", () => {
  it("壊れた保存データでも新しいスレッドで始まる", async () => {
    const { e } = await started({ stored: "{壊れた" });
    expect(e.thread).toEqual(newThread(0));
  });
  it("読み込みに失敗しても新しいスレッドで始まる", async () => {
    const f = fake();
    f.deps.load = async () => { throw new Error("no file"); };
    const e = createEngine(f.deps);
    await e.init(7);
    expect(e.thread).toEqual(newThread(7));
  });
  it("reload は保存された内容を読み直す", async () => {
    const { f, e } = await started();
    f.stored = serialize(append(newThread(1), [{ who: "yajiuma", body: "外から" }], null, 2, () => 0));
    await e.reload(3);
    expect(e.thread.posts[0].body).toBe("外から");
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

describe("mod の決まり", () => {
  const dir = new URL("../mods/nanj/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  it("main.js 以外は herdr と gpui を import しない", () => {
    for (const f of files.filter((f) => f !== "main.js")) {
      expect(readFileSync(new URL(f, dir), "utf8"), f).not.toMatch(/from\s+["'](herdr|gpui-kit|gpui-base)["']/);
    }
  });
  it("Agent の端末に入力を送る呼び出しがない", () => {
    for (const f of files.filter((f) => f !== "main.js")) {
      expect(readFileSync(new URL(f, dir), "utf8"), f).not.toMatch(/["'](send|keys|interrupt|kill|put)["']|terminal\.(paste|kill)/);
    }
  });
});
