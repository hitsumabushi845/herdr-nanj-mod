// なんJ 実況スレ。稼働中の Agent の画面を読み、なんJ 口調のレスを 2ch 風のスレッドに流す。
// スレッドは Agent の端末ごとに 1 本で、上部のタブで切り替える。
// 判定と整形は同じフォルダのモジュールにあり、このファイルは herdr との橋渡しと描画だけを受け持つ。
// Agent の端末には何も送らない。使うのは `hc read` と agent.focus だけ。

import { View, div } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import {
  agents, hc, exec, home, checking, readTextFile, writeTextFile,
  shared, setShared, run, theme, props, closeOverlay,
} from "herdr";
import { parseConfig, DEFAULTS } from "./config.js";
import { createEngine, holdsLease, needsReload, applyEnabled } from "./engine.js";
import { stamp, shortStamp, segments, threadKey, threadFile } from "./thread.js";
import { agentNames } from "./names.js";
import { buildTabs, selectTab, markSeen } from "./tabs.js";
import { claudeArgs, extractText, CLAUDE_TIMEOUT_MS } from "./claude.js";

const TICK_MS = 15000;
const POLL_MS = 3000; // 他のコピーの書き込み、次スレの依頼、タブの選択と既読を見る間隔
const SHOWN_POSTS = 200; // 描くのは新しいほうからこの件数まで
const NARROW_PX = 260;
const TABS_PX = 32; // タブの列の高さ

const CLASSIC = {
  bg: "#efefef", text: "#000000", meta: "#333333", name: "#008000", title: "#ff0000", anchor: "#0000ff",
  line: "#c8c8c8", button: "#dddddd", buttonText: "#000000",
  agents: ["#1e5fa8", "#b22222", "#8b5a00", "#6a1b9a", "#00695c", "#ad1457", "#37474f", "#5d4037"],
};

function themed() {
  const t = theme();
  return {
    bg: t.surface, text: t.foreground, meta: t.muted, name: t.done, title: t.blocked, anchor: t.accent,
    line: t.border, button: t.raised, buttonText: t.foreground,
    agents: [t.ansi1, t.ansi2, t.ansi3, t.ansi4, t.ansi5, t.ansi6, t.ansi9, t.ansi12],
  };
}

export default class Nanj extends View {
  init(_props, cx) {
    this.id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.dir = home() + "/.config/herdr-nanj";
    this.cfg = { ...DEFAULTS };
    this.leader = false;
    this.revN = (shared("nanj.rev") ?? {}).n;
    this.rotateAt = (shared("nanj.rotate") ?? {}).at;
    this.created = {}; // 端末のアドレスから作成時刻（created_ms）への対応
    this.texts = {}; // スレッドのキーから、ファイルを最後に読み書きしたときの中身への対応
    this.indexText = null;
    this.ensured = new Set(); // 保存から読もうとしたキー
    this.catching = false;
    this.shownKey = null;
    this.follow = true;
    this.width = 440;
    this.scroll = ScrollHandle.new();
    const threadPath = (key) => `${this.dir}/threads/${threadFile(key)}`;
    this.engine = createEngine({
      listAgents: () => this.listAgents(),
      readScreen: async (address) => {
        const r = await hc(["read", address, "--lines", "40"]);
        if (r.code !== 0) throw new Error(r.stderr.slice(0, 200));
        return r.stdout;
      },
      generate: async (system, user) => {
        const r = await exec("claude", claudeArgs(this.cfg, system, user), { cwd: this.dir, timeout: CLAUDE_TIMEOUT_MS });
        if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 200) || `claude が終了コード ${r.code} で終わりました`);
        const text = extractText(r.stdout);
        if (text === null) throw new Error("claude の出力を読めませんでした");
        return text;
      },
      loadThread: async (key) => {
        this.texts[key] = await readTextFile(threadPath(key));
        return this.texts[key];
      },
      saveThread: async (key, text) => {
        try {
          await writeTextFile(threadPath(key), text, this.texts[key] ?? null);
        } catch (e) {
          // 別のコピーが先に書いていた。上書きせず、保存されている内容を正として読み直す。
          await this.engine.reload(key, Date.now());
          throw e;
        }
        this.texts[key] = text;
      },
      removeThread: async (key) => {
        const r = await exec("rm", ["-f", threadPath(key)]);
        if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 200));
        delete this.texts[key];
      },
      loadIndex: async () => {
        this.indexText = await readTextFile(this.dir + "/index.json");
        return this.indexText;
      },
      saveIndex: async (text) => {
        try {
          await writeTextFile(this.dir + "/index.json", text, this.indexText);
        } catch (e) {
          await this.engine.reload(null, Date.now());
          throw e;
        }
        this.indexText = text;
      },
      loadLegacy: () => readTextFile(this.dir + "/thread.json"),
      archiveLegacy: async () => {
        const r = await exec("mv", ["thread.json", "thread.json.migrated"], { cwd: this.dir });
        if (r.code !== 0) throw new Error(r.stderr.trim().slice(0, 200));
      },
      config: () => this.cfg,
      rand: Math.random,
      changed: (key) => {
        this.revN = `${Date.now()}-${Math.random()}`;
        setShared("nanj.rev", { key, n: this.revN });
      },
    });
    if (checking()) return;

    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", this.dir + "/threads"]);
      await this.loadConfig();
      await this.engine.init(Date.now());
      cx.notify();
      await this.pump();
      cx.notify();
    });
    cx.timer.every(TICK_MS, (cx) => {
      cx.spawn(async (cx) => {
        await this.pump();
        cx.notify();
      });
    });
    // 値を比べるだけの軽い見回り。変化があったときだけ読み直して描き直す。
    cx.timer.every(POLL_MS, (cx) => {
      this.housekeep();
      if (!this.wantsCatchUp()) return;
      cx.spawn(async (cx) => {
        await this.catchUp(Date.now());
        this.housekeep();
        cx.notify();
      });
    });
  }

  /** 設定で除外していない Agent。スレッドのキーは、端末の作成時刻を読めていれば付く。 */
  listAgents() {
    const out = [];
    for (const a of agents()) {
      if (this.cfg.exclude_spaces.includes(a.space_name)) continue;
      const created = this.created[a.address];
      out.push({
        address: a.address, status: a.status, space: a.space, space_name: a.space_name, tab_name: a.tab_name,
        key: typeof created === "number" ? threadKey(a.address, created) : null,
      });
    }
    return out;
  }

  /** タブに出す Agent のキー（タブの順）。 */
  liveKeys() {
    return this.listAgents().filter((a) => a.key !== null).map((a) => a.key);
  }

  /** 端末の作成時刻を覚える。agents() にはないので、端末ごとに 1 回だけ hc get で読む。読めなければ次にまた読む。 */
  async learnCreated() {
    const now = agents().map((a) => a.address);
    // いなくなった端末は忘れる。同じアドレスが別の端末に使われたときに、古い時刻を使わないため。
    for (const address of Object.keys(this.created)) if (!now.includes(address)) delete this.created[address];
    for (const address of now) {
      if (address in this.created) continue;
      try {
        const r = await hc(["get", address, "--json"]);
        const ms = r.code === 0 ? JSON.parse(r.stdout).created_ms : null;
        if (typeof ms === "number") this.created[address] = ms;
      } catch (_e) {
        // 次の見回りでまた読む
      }
    }
  }

  /** 見回りで、非同期の取り込みが要るか。 */
  wantsCatchUp() {
    if (this.catching) return false;
    if (!this.leader && (shared("nanj.rev") ?? {}).n !== this.revN) return true;
    if (this.leader && (shared("nanj.rotate") ?? {}).at !== this.rotateAt) return true;
    if (agents().some((a) => !(a.address in this.created))) return true;
    return this.liveKeys().some((k) => !this.ensured.has(k));
  }

  /** 他のコピーの書き込みを取り込み、表示するスレッドを読み、生成役なら次スレの依頼を処理する。 */
  async catchUp(now, wasLeader = this.leader) {
    if (this.catching) return;
    this.catching = true;
    try {
      await this.learnCreated();
      const keys = this.liveKeys();
      const rev = shared("nanj.rev") ?? {};
      if (needsReload(wasLeader, this.leader, rev.n, this.revN)) {
        this.revN = rev.n;
        await this.engine.reload(null, now);
        // 引き継いだときは、手元のスレッドがどれも古いかもしれないので、すべて読み直す。
        const stale = this.leader ? [...new Set([...Object.keys(this.engine.threads), ...keys])] : [rev.key, selectTab(shared("nanj.tab"), keys).key];
        for (const key of stale) if (typeof key === "string") await this.engine.reload(key, now);
      }
      await this.engine.ensure(keys, now);
      for (const key of keys) this.ensured.add(key);
      const rotate = shared("nanj.rotate") ?? {};
      if (this.leader && rotate.at !== this.rotateAt) {
        this.rotateAt = rotate.at;
        if (typeof rotate.key === "string") await this.engine.rotate(rotate.key, now);
      }
    } finally {
      this.catching = false;
    }
  }

  /** タブの選択と既読の位置を shared に反映する。render の外で呼ぶ。 */
  housekeep() {
    if (this.engine.migrated) {
      // 移行したレスは、未読として数えない
      setShared("nanj.seen", { ...(shared("nanj.seen") ?? {}), ...this.engine.migrated });
      this.engine.migrated = null;
    }
    const sel = selectTab(shared("nanj.tab"), this.liveKeys());
    if (sel.save) setShared("nanj.tab", sel.key);
    const seen = markSeen(shared("nanj.seen"), sel.key, sel.key === null ? null : this.engine.threads[sel.key]);
    if (seen) setShared("nanj.seen", seen);
  }

  async loadConfig() {
    try {
      this.cfg = parseConfig(await readTextFile(this.dir + "/config.json"));
    } catch (_e) {
      this.cfg = { ...DEFAULTS };
    }
  }

  /** 表示に要るものを読み、生成役なら 1 回分進める。生成役は shared のリースで 1 つに絞る。 */
  async pump() {
    const now = Date.now();
    const wasLeader = this.leader;
    this.leader = holdsLease(shared("nanj.leader"), this.id, now);
    if (this.leader) setShared("nanj.leader", { id: this.id, at: now });
    await this.loadConfig();
    await this.catchUp(now, wasLeader);
    this.housekeep();
    if (!this.leader) return;
    // 設定の enabled は、初めてのときと値が変わったときに停止の状態へ反映する。
    const next = applyEnabled(shared("nanj.paused"), shared("nanj.enabled"), this.cfg.enabled);
    if (next.applied !== shared("nanj.enabled")) setShared("nanj.enabled", next.applied);
    if (next.paused !== shared("nanj.paused")) setShared("nanj.paused", next.paused);
    const paused = next.paused;
    if (this.engine.paused !== paused) this.engine.setPaused(paused);
    await this.engine.tick(now);
    this.housekeep();
    if (this.engine.paused && !paused) {
      // 失敗が続いてエンジンが自分で止まった
      setShared("nanj.error", this.engine.error);
      setShared("nanj.paused", true);
    } else if (!this.engine.paused) {
      if (shared("nanj.error") !== this.engine.error) setShared("nanj.error", this.engine.error);
    }
  }

  togglePause() {
    const paused = shared("nanj.paused") === true;
    if (paused) setShared("nanj.error", null);
    setShared("nanj.paused", !paused);
  }

  render(cx) {
    const c = this.cfg.palette === "theme" ? themed() : CLASSIC;
    const t = theme();
    const visible = this.listAgents();
    const liveAgents = visible.filter((a) => a.key !== null);
    const selected = selectTab(shared("nanj.tab"), liveAgents.map((a) => a.key)).key;
    const tabs = buildTabs(liveAgents, agentNames(visible), this.engine.threads, shared("nanj.seen"), selected);
    const thread = selected === null ? null : (this.engine.threads[selected] ?? null);
    if (selected !== this.shownKey) {
      // 別のスレッドを表示したら、末尾への追従を有効に戻す
      this.shownKey = selected;
      this.follow = true;
    }
    const paused = shared("nanj.paused") === true;
    const error = shared("nanj.error") ?? this.engine.error;
    const posts = thread ? thread.posts.slice(-SHOWN_POSTS) : [];
    const live = new Set(agents().map((a) => a.address));
    const narrow = this.width < NARROW_PX;
    const overlay = (props() ?? {}).overlay;
    const agentColor = (n) => c.agents[n % c.agents.length];
    if (this.follow && posts.length > 0) this.scroll.scroll_to_item(posts.length - 1);

    const button = (id, label, onClick) =>
      div().id(id).flex_none().px(8).py(2).rounded(4).bg(c.button).text_color(c.buttonText).text_size(12)
        .cursor_pointer().hover((s) => s.opacity(0.8))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { onClick(cx); cx.notify(); })
        .child(label);

    const tab = (tb) =>
      h_flex().id(`tab-${tb.key}`).flex_none().items_center().gap(5).px(8).py(3).rounded(4)
        .when(tb.selected, (el) => el.bg(c.button))
        .cursor_pointer().hover((s) => s.opacity(0.8))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { setShared("nanj.tab", tb.key); cx.notify(); })
        .child(div().flex_none().size(8).rounded(4).bg(t[tb.status] ?? t.idle))
        .child(div().text_size(12).text_color(tb.color === null ? c.text : agentColor(tb.color))
          .when(tb.selected, (el) => el.font_semibold()).child(tb.name))
        .when(tb.unread > 0, (el) => el.child(
          div().flex_none().px(5).rounded(7).bg(c.title).text_color(c.bg).text_size(11).child(String(tb.unread))));

    const focus = (post) => () => {
      if (post.agent !== null && live.has(post.agent)) run("agent.focus", { terminal: post.agent });
    };

    const row = (post) => {
      const own = post.agent !== null;
      const nameColor = own ? agentColor(thread.color) : c.name;
      const who = (id, label, color) => {
        const el = div().id(id).text_color(color).child(label);
        return own ? el.cursor_pointer().hover((s) => s.opacity(0.7)).on_click(focus(post)) : el;
      };
      return v_flex().id(`post-${post.no}`).gap(2)
        .child(h_flex().flex_wrap().gap(6).text_color(c.meta)
          .child(div().child(String(post.no)))
          .child(who(`name-${post.no}`, post.name, nameColor).font_semibold())
          .child(div().child(narrow ? shortStamp(post.at) : stamp(post.at)))
          .child(who(`id-${post.no}`, `ID:${post.id}`, c.meta)))
        .children(post.body.split("\n").map((line, i) =>
          h_flex().id(`line-${post.no}-${i}`).flex_wrap().pl(12).text_color(c.text)
            .children(segments(line).map((s) =>
              div().min_w(0).text_color(s.anchor === null ? c.text : c.anchor).child(s.text)))));
    };

    const root = v_flex().id("nanj-root").size_full().bg(c.bg).text_size(13).text_color(c.text)
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); });

    if (tabs.length === 0) {
      return root
        .child(h_flex().flex_none().px(8).py(6).gap(6).items_center().border_b_1().border_color(c.line)
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(error ? c.title : c.meta)
            .child(error ?? (paused ? "停止中" : "実況中")))
          .child(button("nanj-pause", paused ? "再開" : "停止", () => this.togglePause()))
          .when(Boolean(overlay), (el) => el.child(button("nanj-close", "×", () => closeOverlay(overlay)))))
        .child(div().flex_1().p(12).text_color(c.meta).child("起動している Agent がありません"));
    }

    return root
      // 横スクロールの列は高さを決めておく。決めないと縦いっぱいに広がる。
      .child(h_flex().id("nanj-tabs").flex_none().h(TABS_PX).px(6).gap(2).items_center().overflow_x_scrollbar()
        .border_b_1().border_color(c.line).children(tabs.map(tab)))
      .child(v_flex().flex_none().px(8).py(6).gap(4).border_b_1().border_color(c.line)
        .child(div().text_color(c.title).font_semibold().child((thread && thread.title) ?? "スレ立て待ち"))
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(error ? c.title : c.meta)
            .child(error ?? (paused ? "停止中" : "実況中")))
          .child(button("nanj-pause", paused ? "再開" : "停止", () => this.togglePause()))
          .when(thread !== null, (el) => el.child(button("nanj-next", "次スレ", () => setShared("nanj.rotate", { key: selected, at: Date.now() }))))
          .when(Boolean(overlay), (el) => el.child(button("nanj-close", "×", () => closeOverlay(overlay))))))
      .child(v_flex().id("nanj-posts").flex_1().min_h(0).px(8).py(6).gap(8).overflow_y_scrollbar().track_scroll(this.scroll)
        .on_scroll_wheel((e, cx) => {
          // 上へ動かしたら追従を止める。位置は読めないので、戻すのは「最新へ」ボタン。
          if (e.delta.y > 0 && this.follow) { this.follow = false; cx.notify(); }
        })
        .children(posts.map(row)))
      .when(!this.follow, (el) => el.child(h_flex().flex_none().justify_center().py(4).border_t_1().border_color(c.line)
        .child(button("nanj-latest", "▼ 最新へ", () => { this.follow = true; }))));
  }
}
