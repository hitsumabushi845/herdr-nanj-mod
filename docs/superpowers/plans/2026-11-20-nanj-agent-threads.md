# Agent ごとのスレッドとタブ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** mod `nanj` のスレッドを Agent の端末ごとに分け、上部のタブで切り替えられるようにする。

**Architecture:** スレッドは `~/.config/herdr-nanj/threads/<キー>.json` に 1 本ずつ保存し、一覧を `index.json` に持つ。`engine.js` は 1 本のスレッドの代わりにキーごとのスレッドを扱い、きっかけの対象の Agent のスレッドにだけ書く。タブの並び、選択、未読の計算は純粋な関数（`tabs.js`）に置き、`main.js` は `shared` との橋渡しと描画を受け持つ。

**Tech Stack:** いまと同じ（ビルドなしの JavaScript、gpui-kit、`herdr` モジュール、`hc`、`claude -p`、vitest、pnpm）。

**Spec:** `docs/superpowers/specs/2026-11-20-nanj-agent-threads-design.md`（元の設計は `2026-11-16-nanj-thread-design.md`）

## Global Constraints

- `CLAUDE.md` の「決まり」と「確かめた事実」に従う。mod は Agent の端末に入力を送らない。`main.js` 以外は `herdr`、`gpui-kit`、`gpui-base` を import しない。
- スレッドのキーは `<端末のアドレス>@<created_ms>`。`created_ms` は `hc get <端末> --json` から取る。取れない間は、その Agent のスレッドもレスも作らない。起動している Agent に `@0` のキーを使わない。
- 1 本のスレッドに、別の Agent のレスを入れない。
- 表示するスレッドは利用者のクリックと、表示中の Agent の終了のときにだけ替わる。
- 起動していないことだけを理由に、スレッドのファイルを消さない。消すのは、起動しておらず、最後のレスから 7 日（604800000 ミリ秒）たったスレッドだけ。
- 数値は元の設計のまま: 直近のレス 10 件、スレッドごとに 1000 レスまで、スレタイの付け直し 30 分、雑談 10 分、呼び出しの上限は全スレッドの合計。
- `shared` のキー: `nanj.tab`（選んだキー）、`nanj.seen`（`{キー: 最後に見たレス番号}`）、`nanj.rev`（`{key, n}`）、`nanj.rotate`（`{key, at}`）。`nanj.leader`、`nanj.paused`、`nanj.enabled`、`nanj.error` はいまのまま。
- mod を変えたら `pnpm run install:mod` と `pnpm run check` を通す。
- 作業は `feat/nanj-thread` ブランチ（PR #1）に積む。コミットメッセージは日本語で書き、yomiyasu スキルで推敲する。
- 利用者の Herdr app と herdr-core を止めない。実機の `~/.config/herdr-nanj/thread.json` は Task 6 の移行の確認まで触らない。

## Review Focus

1. `hc get` が失敗する、または `created_ms` がない。その Agent を飛ばし、スレッドもレスも作らず、次の見回りでまた読む。mod は落ちない。（Task 5、Task 6）
2. `index.json` が壊れている、またはない状態で、スレッドのファイルはある。起動している Agent のスレッドはキーから読め、次の保存で一覧が作り直される。（Task 5）
3. スレッドのファイルは書けて、一覧の書き込みが失敗する。レスは失われず、表示も壊れない。（Task 5）
4. 移行がスレッドを書いたあと `thread.json` の名前を変える前に止まる。やり直してもレスが 2 重にならない。（Task 5）
5. `agents()` が一時的に空を返す。選んだタブを書き換えず、スレッドも消さない。（Task 4、Task 5）

---

## ファイルの構成

```
mods/nanj/thread.js    変更: キー、スレッドの持ち主の情報、一覧、古いスレッドの判定、移行
mods/nanj/triggers.js  変更: 雑談のきっかけに Agent のアドレスを持たせる
mods/nanj/tabs.js      新規: タブの並び、選択、未読の計算
mods/nanj/engine.js    変更: キーごとのスレッド、読み書き、移行、古いスレッドの削除
mods/nanj/main.js      変更: created_ms の取得、ファイルの読み書き、タブの描画
test/*.test.js         各モジュールのテスト
README.md  RECIPE.md  CLAUDE.md  preview.png
```

---

### Task 1: スレッドのキー、持ち主、一覧

**Files:**
- Modify: `mods/nanj/thread.js`
- Test: `test/thread.test.js`

**Interfaces:**
- Produces:
  - `PRUNE_AFTER_MS = 604800000`
  - `threadKey(address: string, createdMs: number): string`（`"t16@1700000000000"`）
  - `threadFile(key: string): string`（`/` を `_` に置き換えて `.json` を付ける）
  - `type Owner = {key: string, address: string, name: string, color: number}`
  - `type Thread` に `key: string | null`、`address: string | null`、`name: string | null`、`color: number` を足す
  - `newThread(now: number, owner?: Owner): Thread`（`owner` がなければ持ち主の欄は null、`color` は 0）
  - `type IndexEntry = {key: string, address: string, name: string, color: number, lastPostAt: number}`
  - `type Index = {v: 1, threads: IndexEntry[]}`
  - `emptyIndex(): Index`
  - `upsertIndex(index: Index, thread: Thread, now: number): Index`（`lastPostAt` は最後のレスの `at`、レスがなければ `now`。名前が変わっていれば新しい名前にする）
  - `removeFromIndex(index: Index, key: string): Index`
  - `nextColor(index: Index): number`（一覧が空なら 0、あれば最大の色の番号に 1 を足して 8 で割った余り）
  - `staleKeys(index: Index, liveKeys: string[], now: number): string[]`
  - `serializeIndex(index: Index): string`、`deserializeIndex(text: string | null): Index`

- [ ] **Step 1: 失敗するテストを書く**

```js
expect(threadKey("t16", 1700000000000)).toBe("t16@1700000000000");
expect(threadFile("vps/t7@5")).toBe("vps_t7@5.json");
const owner = { key: "t16@5", address: "t16", name: "api", color: 3 };
expect(newThread(1, owner)).toMatchObject({ key: "t16@5", address: "t16", name: "api", color: 3, posts: [] });
expect(newThread(1)).toMatchObject({ key: null, address: null, name: null, color: 0 });
expect(deserialize(serialize(newThread(1, owner)), 9)).toEqual(newThread(1, owner));
// 持ち主の欄のない古い保存データは null と 0 で読む
expect(deserialize('{"v":1,"title":null,"startedAt":5,"posts":[],"colors":{}}', 9)).toMatchObject({ key: null, color: 0 });
// 持ち主の欄の型が違えば新しいスレッドにする
expect(deserialize('{"v":1,"title":null,"startedAt":5,"posts":[],"colors":{},"key":3}', 9)).toEqual(newThread(9));

let ix = emptyIndex();
expect(nextColor(ix)).toBe(0);
const t = append(newThread(1, owner), [{ who: "agent", body: "a" }], { address: "t16", name: "api" }, 50, () => 0);
ix = upsertIndex(ix, t, 60);
expect(ix.threads).toEqual([{ key: "t16@5", address: "t16", name: "api", color: 3, lastPostAt: 50 }]);
expect(nextColor(ix)).toBe(4);
expect(upsertIndex(ix, { ...t, name: "api/2" }, 70).threads).toHaveLength(1);
expect(upsertIndex(ix, { ...t, name: "api/2" }, 70).threads[0].name).toBe("api/2");
expect(upsertIndex(emptyIndex(), newThread(1, owner), 60).threads[0].lastPostAt).toBe(60);
expect(nextColor({ v: 1, threads: [{ ...ix.threads[0], color: 7 }] })).toBe(0);
expect(removeFromIndex(ix, "t16@5").threads).toEqual([]);
expect(deserializeIndex(serializeIndex(ix))).toEqual(ix);
for (const bad of [null, "{壊れた", '{"v":2}', '{"v":1,"threads":[{"key":1}]}']) expect(deserializeIndex(bad)).toEqual(emptyIndex());

// 起動しておらず、最後のレスから 7 日たったものだけ
const old = { key: "t1@1", address: "t1", name: "a", color: 0, lastPostAt: 0 };
expect(staleKeys({ v: 1, threads: [old] }, [], PRUNE_AFTER_MS)).toEqual(["t1@1"]);
expect(staleKeys({ v: 1, threads: [old] }, [], PRUNE_AFTER_MS - 1)).toEqual([]);
expect(staleKeys({ v: 1, threads: [old] }, ["t1@1"], PRUNE_AFTER_MS * 2)).toEqual([]);
```

いまの `thread.test.js` の `newThread(...)` との `toEqual` は足した欄を含めて通ること。

- [ ] **Step 2: 失敗を確かめる** → **Step 3: 実装** → **Step 4: `pnpm test` が通ることを確かめる** → **Step 5: コミット**（`feat: スレッドにキーと持ち主を持たせ、一覧を足す`）

---

### Task 2: いまのスレッドからの移行

**Files:**
- Modify: `mods/nanj/thread.js`
- Test: `test/thread.test.js`

**Interfaces:**
- Consumes: Task 1 の `Owner`、`newThread`、`threadKey`
- Produces: `migrate(legacy: Thread, liveKeys: Record<string, string>, now: number): {threads: Thread[], dropped: number}`（`liveKeys` は起動している端末のアドレスからキーへの対応）

規則は次のとおり。

- Agent 本人のレス（`agent` が null でない）は、その端末のスレッドに入れる。キーは `liveKeys[agent]`、なければ `threadKey(agent, 0)`。
- 野次馬のレスは同じ `at` の Agent 本人のレスと同じスレッドに入れる。同じ `at` に Agent 本人のレスが 2 つ以上の端末からあるときは、元の並びですぐ前にある Agent 本人のレスの端末に入れる。同じ `at` の Agent 本人のレスがなければ捨て、`dropped` に数える。
- レスの `no`、`at`、`name`、`id`、`body` は変えない。スレッドの中の並びは元の順のまま。
- スレッドの `name` はその端末の最後の Agent 本人のレスの `name`。`color` は、元の `colors[agent]`（なければ 0）。`title` と `titleAt` は null。`startedAt` は最初のレスの `at`。
- `threads` は、最初のレスが古い順に並べる。

- [ ] **Step 1: 失敗するテストを書く**

```js
const post = (no, agent, at, name = agent ? "n-" + agent : "風吹けば名無し") => ({ no, name, id: agent ?? "x" + no, agent, at, body: "b" + no });
const legacy = { ...newThread(0), title: "旧題", titleAt: 1, colors: { t1: 2, t2: 5 }, posts: [
  post(1, "t1", 10), post(2, null, 10), post(3, "t2", 20), post(4, null, 20), post(5, null, 30), post(6, "t1", 40, "改名後"),
] };
const r = migrate(legacy, { t1: "t1@111" }, 99);
expect(r.dropped).toBe(1);                                             // no 5 は雑談
expect(r.threads.map((t) => [t.key, t.posts.map((p) => p.no)])).toEqual([["t1@111", [1, 2, 6]], ["t2@0", [3, 4]]]);
expect(r.threads[0]).toMatchObject({ address: "t1", name: "改名後", color: 2, title: null, titleAt: null, startedAt: 10 });
expect(r.threads[1]).toMatchObject({ address: "t2", color: 5 });
expect(r.threads.reduce((n, t) => n + t.posts.length, 0) + r.dropped).toBe(legacy.posts.length);
expect(nextNo(r.threads[0])).toBe(7);                                  // 番号は元のまま続く
// 同じ at に 2 つの端末のレスがあるとき、野次馬はすぐ前の Agent のレスの端末へ
const both = { ...newThread(0), posts: [post(1, "t1", 10), post(2, null, 10), post(3, "t2", 10), post(4, null, 10)] };
expect(migrate(both, {}, 0).threads.map((t) => t.posts.map((p) => p.no))).toEqual([[1, 2], [3, 4]]);
expect(migrate(newThread(0), {}, 0)).toEqual({ threads: [], dropped: 0 });
```

- [ ] **Step 2: 失敗を確かめる** → **Step 3: 実装** → **Step 4: 通ることを確かめる** → **Step 5: コミット**（`feat: 1 本のスレッドを Agent ごとに振り分ける移行`）

---

### Task 3: 雑談の行き先

**Files:**
- Modify: `mods/nanj/triggers.js`
- Test: `test/triggers.test.js`

**Interfaces:**
- Produces: `pick` が返す雑談のきっかけは `{kind: "chat", address: string}`。対象は、作業中の Agent のうち最後のレスがいちばん古いもの（レスがまだない Agent を先にする）。`commit` は、雑談では `lastChatAt` だけを更新し、その Agent の `lastPostAt` は変えない。

- [ ] **Step 1: 失敗するテストを書く**

いまの雑談のテストの期待値 `{ kind: "chat", address: null }` を `{ kind: "chat", address: "t1" }` に替え、次を足す。

```js
// 作業中の 2 つのうち、最後のレスが古いほうのスレッドに書く
let s = observe(initialState(), [w("t1", "a"), w("t2", "a")], 0);
s = commit(s, progress("t1"), 0);
s = commit(s, progress("t2"), 30000);
s = observe(s, [w("t1", "a"), w("t2", "a")], 100000);
expect(pick(s, 100000, { ...cfg, min_interval_sec: 30, chat_interval_min: 1 })).toEqual({ kind: "chat", address: "t1" });
// 雑談を commit しても、その Agent の進捗の間隔は延びない
const after = commit(s, { kind: "chat", address: "t1" }, 100000);
expect(after.agents.t1.lastPostAt).toBe(0);
expect(pick(after, 100000, { ...cfg, chat_interval_min: 1 })).toBeNull();
```

- [ ] **Step 2: 失敗を確かめる** → **Step 3: 実装** → **Step 4: 通ることを確かめる** → **Step 5: コミット**（`feat: 雑談を作業中の Agent のスレッドに書く`）

---

### Task 4: タブの並び、選択、未読

**Files:**
- Create: `mods/nanj/tabs.js`
- Test: `test/tabs.test.js`

**Interfaces:**
- Consumes: `Thread`（Task 1）、`nextNo`
- Produces:
  - `type Tab = {key: string, address: string, name: string, status: string, color: number | null, unread: number, selected: boolean}`
  - `unread(thread: Thread | null, seenNo: number | undefined): number`（`seenNo` より大きい `no` のレスの数。`seenNo` がなければ全レス）
  - `selectTab(saved: unknown, keys: string[]): {key: string | null, save: boolean}`
  - `buildTabs(agents: {key: string | null, address: string, status: string}[], names: Record<string, string>, threads: Record<string, Thread>, seen: Record<string, number>, selected: string | null): Tab[]`
  - `markSeen(seen: Record<string, number>, key: string, thread: Thread | null): Record<string, number> | null`（変える必要がなければ null）

`selectTab` の規則は次のとおり。

- `keys` が空なら `{key: null, save: false}`。覚えた値は書き換えない。
- `saved` が `keys` にあれば `{key: saved, save: false}`。
- なければ `{key: keys[0], save: true}`。

`buildTabs` は、`key` が null の Agent を飛ばし、`agents` の順のまま返す。`color` はスレッドがあればその `color`、なければ null。選ばれているタブの `unread` は 0。

- [ ] **Step 1: 失敗するテストを書く**

```js
const th = (key, nos, color = 1) => ({ ...newThread(0, { key, address: key.split("@")[0], name: "n", color }), posts: nos.map((no) => ({ no, name: "n", id: "i", agent: null, at: no, body: "b" })) });
expect(unread(th("t1@1", [1, 2, 3]), 1)).toBe(2);
expect(unread(th("t1@1", [1, 2, 3]), undefined)).toBe(3);
expect(unread(th("t1@1", [5, 9]), 5)).toBe(1);                  // 連番でない番号（移行したスレッド）
expect(unread(null, 3)).toBe(0);

expect(selectTab("b", ["a", "b"])).toEqual({ key: "b", save: false });
expect(selectTab("gone", ["a", "b"])).toEqual({ key: "a", save: true });
expect(selectTab(undefined, ["a"])).toEqual({ key: "a", save: true });
expect(selectTab("b", [])).toEqual({ key: null, save: false });   // 一時的に空でも覚えた値を残す
expect(selectTab({ x: 1 }, ["a"])).toEqual({ key: "a", save: true });

const agents = [{ key: "t1@1", address: "t1", status: "working" }, { key: null, address: "t9", status: "idle" }, { key: "t2@2", address: "t2", status: "blocked" }];
const tabs = buildTabs(agents, { t1: "api", t2: "web", t9: "x" }, { "t1@1": th("t1@1", [1, 2], 4), "t2@2": th("t2@2", [1, 2, 3], 6) }, { "t2@2": 1 }, "t1@1");
expect(tabs).toEqual([
  { key: "t1@1", address: "t1", name: "api", status: "working", color: 4, unread: 0, selected: true },
  { key: "t2@2", address: "t2", name: "web", status: "blocked", color: 6, unread: 2, selected: false },
]);
expect(buildTabs([{ key: "t3@3", address: "t3", status: "idle" }], { t3: "new" }, {}, {}, null)[0]).toMatchObject({ color: null, unread: 0, selected: false });

expect(markSeen({}, "t1@1", th("t1@1", [1, 2]))).toEqual({ "t1@1": 2 });
expect(markSeen({ "t1@1": 2 }, "t1@1", th("t1@1", [1, 2]))).toBeNull();
expect(markSeen({ a: 1 }, "t1@1", null)).toBeNull();
```

- [ ] **Step 2: 失敗を確かめる** → **Step 3: 実装** → **Step 4: 通ることを確かめる** → **Step 5: コミット**（`feat: タブの並び、選択、未読の計算`）

---

### Task 5: エンジンをキーごとのスレッドに替える

**Files:**
- Modify: `mods/nanj/engine.js`
- Test: `test/engine.test.js`

**Interfaces:**
- Consumes: Task 1 から Task 3 のすべて
- Produces:
  - `PRUNE_EVERY_MS = 3600000`
  - `type AgentView` に `key: string | null` を足す
  - `type Deps`: `load` と `save` をやめ、次に替える。`loadThread(key: string): Promise<string | null>`、`saveThread(key: string, text: string): Promise<void>`、`removeThread(key: string): Promise<void>`、`loadIndex(): Promise<string | null>`、`saveIndex(text: string): Promise<void>`、`loadLegacy(): Promise<string | null>`、`archiveLegacy(): Promise<void>`、`changed(key: string | null): void`。ほかはいまのまま。
  - `type Engine`: `thread` をやめ、次に替える。`threads: Record<string, Thread>`、`index: Index`、`migrated: Record<string, number> | null`（移行した直後だけ、キーごとの最後のレス番号。`main.js` が既読の位置に使い、読んだら null に戻す）、`init(now)`、`tick(now)`、`reload(key: string | null, now)`（null は一覧だけ）、`ensure(keys: string[], now): Promise<boolean>`（まだ読んでいないキーのスレッドを読む。読んだものがあれば true）、`rotate(key: string, now)`、`setPaused`、`paused`、`error`。

`tick` の変更点は次のとおり。ほかの流れ（上限、失敗の数え方、スレタイ、0 件の応答）は変えない。

1. `key` が null の Agent はいないものとして扱う。観測にも入れない。
2. 移行: まだ済んでいなければ、`loadIndex()` が null で `loadLegacy()` が null でないときに行う。除外していない起動中の Agent のうち 1 つでも `key` が null なら、今回は移行もレスの生成もせずに終える。`migrate` の結果のスレッドをすべて `saveThread` し、一覧を `saveIndex` し、最後に `archiveLegacy()` する。途中で失敗したら `error` に理由を入れ、次の `tick` で最初からやり直す。`loadIndex()` が null でなく `loadLegacy()` が null でないとき（前回、名前を変える前に止まった）は、`archiveLegacy()` だけを行う。
3. きっかけの対象の Agent のスレッドは、`threads[key]`、なければ `loadThread(key)` の中身、それもなければ `newThread(now, {key, address, name, color: nextColor(index)})` とする。読んだスレッドの `name` が今の名前と違えば、今の名前にする。
4. レスを足したら、`saveThread`、`upsertIndex`、`saveIndex` の順に行い、`changed(key)` を呼ぶ。`saveIndex` が失敗しても `threads` と保存したスレッドは残し、`error` に理由を入れる。
5. 雑談は対象の Agent のスレッドに、`append(thread, posts, null, ...)` で野次馬のレスとして足す。プロンプトの `agent` と `screen` は null のまま、`recent` はそのスレッドのものを渡す。
6. `PRUNE_EVERY_MS` に 1 回、`staleKeys(index, 起動中のキー, now)` のスレッドを `removeThread` し、一覧から外して `saveIndex` する。除外していない起動中の Agent が 1 つもいないときも、7 日の条件があるので同じ処理でよい。
7. `rotate(key, now)` は、そのスレッドを同じ持ち主の空のスレッドに替えて保存する。

- [ ] **Step 1: 失敗するテストを書く**

`fake()` を新しい `Deps` に合わせる（`files: Record<string, string>` にスレッドと一覧を持ち、`legacy: string | null` を持つ）。`agent()` に `key`（既定は `` `${address}@1` ``）を足す。いまのテストは `e.thread` を `e.threads["t1@1"]` に替えて残す。次を足す。

```js
// 2 つの Agent のレスは、それぞれのスレッドにだけ入る
// 2 回の tick のあと: e.threads["t1@1"].posts と e.threads["t2@1"].posts の agent がそれぞれ t1 と t2 だけ。
// f.files に "t1@1" と "t2@1" と一覧がある。changed が "t1@1" と "t2@1" で呼ばれる
// 2 本目のスレッドの color は 1（作った順）

// 直近のレスは、そのスレッドのものだけを渡す: t2 のプロンプトに t1 のレスの本文が入らない
// スレタイはスレッドごと: 2 本とも最初のレスで needTitle のプロンプトになる

// key が null の Agent は readScreen も generate も呼ばない（Review Focus 1）。key が付いたら次の tick でレスが付く

// 保存されたスレッドがあれば続きに書く: f.files["t1@1"] に no 41 までのスレッド → 次のレスは 42、プロンプトに「次のレスは 42 番」
// 一覧が壊れていてもスレッドは読め、次の保存で一覧が作り直される（Review Focus 2）
// saveIndex が失敗しても、スレッドのファイルは書かれ、e.threads に残り、error に理由が入る（Review Focus 3）

// 移行: legacy に t1 と t9（起動していない）のレスがある。tick のあと f.files に "t1@1" と "t9@0" があり、
//   一覧に 2 件、archiveLegacy が 1 回、e.migrated が {"t1@1": 最後の番号, "t9@0": 最後の番号}
// 移行: 起動中の Agent の key が null の間は移行しない。generate も呼ばない。key が付いた tick で移行する
// 移行: saveIndex が 1 回失敗する → archiveLegacy は呼ばれない → 次の tick でやり直し、レスは 2 重にならない（Review Focus 4）
// 移行: 一覧があり legacy も残っている → archiveLegacy だけを呼ぶ
// 移行のあと、t1 の次のレスは legacy の最後の番号の続きになる

// 雑談は、対象の Agent のスレッドに野次馬のレスとして入る（posts.at(-1).agent が null、スレッドは "t1@1"）

// 古いスレッド: 一覧に lastPostAt が 8 日前で起動していない "t5@1" がある → tick で removeThread("t5@1")、一覧から消える
// 古いスレッド: 6 日前のものと、8 日前でも起動しているものは消さない
// 古いスレッド: listAgents が空を返しても、6 日前のものは消さない（Review Focus 5）
// 古いスレッドの削除は 1 時間に 1 回: 続けて tick しても removeThread は増えない

// rotate("t1@1") は t1 のスレッドだけを空にし、t2 のスレッドは変えない。持ち主の欄と color は残る
// reload("t1@1") は保存された内容を読み直す。読み込みに失敗したら手元のスレッドを残す
// ensure(["t1@1", "t2@1"]) は、まだ読んでいないスレッドだけを loadThread で読み、true を返す。2 回目は false
```

- [ ] **Step 2: 失敗を確かめる** → **Step 3: 実装** → **Step 4: 通ることを確かめる** → **Step 5: コミット**（`feat: エンジンを Agent ごとのスレッドに替える`）

---

### Task 6: 画面と橋渡し、実機での確認、文書

**Files:**
- Modify: `mods/nanj/main.js`、`README.md`、`RECIPE.md`、`CLAUDE.md`、`preview.png`
- Test: `test/engine.test.js` の「mod の決まり」が `tabs.js` を含めて通ること

**Interfaces:**
- Consumes: `createEngine`（Task 5）、`buildTabs`、`selectTab`、`markSeen`（Task 4）、`threadKey`、`threadFile`（Task 1）

橋渡しは次のとおり。

- `created_ms`: `this.created`（アドレスから時刻への対応）に覚える。`pump` と見回りの中で、覚えていない起動中の Agent について `hc(["get", address, "--json"])` を呼び、`created_ms` が数なら覚える。失敗したら覚えず、次にまた呼ぶ。`listAgents` は、覚えていれば `key: threadKey(address, created)`、なければ `key: null` を付けて返す。
- ファイル: `threads/` を `mkdir -p` で作る。`loadThread` と `saveThread` は `threads/<threadFile(key)>` を `readTextFile` と `writeTextFile` で読み書きし、キーごとに最後の中身を覚えて `expected` に渡す。不一致で失敗したら、上書きせず `engine.reload(key)` して reject する。`loadIndex` と `saveIndex` は `index.json`。`removeThread` は `exec("rm", ["-f", パス])`。`loadLegacy` は `thread.json`、`archiveLegacy` は `exec("mv", ["thread.json", "thread.json.migrated"])`（フォルダは `cwd` で指定）。
- `changed(key)`: `setShared("nanj.rev", { key, n })`。生成役でないコピーは、見回りで `nanj.rev` が変わっていたら `engine.reload(key)` と `engine.reload(null)` をする。生成役を引き継いだときは、読み込んであるスレッドをすべて読み直す。
- 表示するスレッドの読み込み: すべてのコピーが `pump` と見回りで `engine.ensure(起動中のキー)` を呼ぶ。
- タブに出す Agent は `exclude_spaces` に入っていない space のもので、`key` が付いたものとする。エンジンが見る Agent と同じにする。
- 選択: 見回りと `pump` で `selectTab(shared("nanj.tab"), 起動中のキー)` を呼び、`save` が true なら `setShared("nanj.tab", key)`。タブのクリックは `setShared("nanj.tab", key)`。
- 既読: 見回りと `pump` で `markSeen(shared("nanj.seen"), 選んだキー, そのスレッド)` を呼び、null でなければ `setShared`。`engine.migrated` があれば、その中身を `nanj.seen` に足してから null に戻す。`render` の中では `setShared` を呼ばない。
- 「次スレ」: `setShared("nanj.rotate", { key: 選んだキー, at })`。生成役が `engine.rotate(key)` を呼ぶ。

描画は次のとおり。

- いちばん上にタブの列（`h_flex`、横スクロール、下に線）。タブは状態の印（8 px の丸、色は `theme()` の `working`、`blocked`、`done`、`idle`）、名前（`color` があればその色、なければ本文の色）、未読が 1 以上なら数。選ばれているタブは背景を変える。クリックで選ぶ。`on_mouse_down` で伝播を止める。
- その下はいまの上端（スレタイ、状態、ボタン）とレスの一覧。対象は選んだスレッド。スレッドがまだなければ、スレタイの位置に「スレ立て待ち」。
- 起動している Agent（`key` が付いたもの）が 1 つもなければ、タブの列を出さず、一覧の位置に「起動している Agent がありません」。
- Agent 本人の名前の色はスレッドの `color`。
- 選んだスレッドが替わったら、末尾への追従を有効に戻す。

- [ ] **Step 1: `main.js` を実装する**
- [ ] **Step 2: `pnpm test`、`pnpm run install:mod`、`pnpm run check` を通す**
- [ ] **Step 3: 移行を実機で確かめる**

入れる前に `thread.json` のレスの数と、Agent 本人のレスの端末ごとの数、雑談の数を数えておく。入れたあと、`threads/` のファイルのレスの合計と、数えておいた雑談の数の和が、元のレスの数と同じこと、`thread.json.migrated` があること、`index.json` があることを確かめる。

- [ ] **Step 4: 表示と動きを実機で確かめる**

1. Agent を 2 つ以上動かし、`herdr-app shot` の画像で、タブが並び、選んだタブのスレッドにその Agent のレスと野次馬のレスだけが出ていることを確かめる。それぞれのファイルの `agent` が 1 種類だけであることも確かめる。
2. 選んでいないスレッドにレスが付いたあと、画像でタブに未読の数が出ていることを確かめる。
3. `herdr-app do agent.focus` で別の Agent に移り、`shared.json` の `nanj.tab` が変わらないことを確かめる。
4. `status` の `errors` が空であること、実況中の Agent の端末に入力がないことを確かめる。

タブのクリックと「次スレ」は CLI から押せないので、確かめられなかったこととして報告する。

- [ ] **Step 5: 文書を直す**

`README.md` の「画面」と、スレッドが 1 本だと書いた段落、`RECIPE.md` の「何が見えるか」「どう動くか」「何で作ったか」「注意」「完成の条件」を、Agent ごとのスレッドとタブに合わせる。`CLAUDE.md` の「確かめた事実」に、`created_ms` が `hc get` にしかないこと、Agent が fish の端末の中で動くので起動し直してもアドレスが変わらないことを足す。`preview.png` を、社内の固有名が写っていない画像に替える。写ってしまうときは、替えずにその旨を報告する。文書は yomiyasu スキルで推敲する。

- [ ] **Step 6: コミットして push する**（`feat: スレッドを Agent ごとに分け、タブで切り替える`、`docs: Agent ごとのスレッドに合わせて直す`）
