// なんJ 実況スレ。稼働中の Agent の画面を読み、なんJ 口調のレスを 2ch 風のスレッドに流す。
// 判定と整形は同じフォルダのモジュールにあり、このファイルは herdr との橋渡しと描画だけを受け持つ。
// Agent の端末には何も送らない。使うのは `hc read` と agent.focus だけ。

import { View, div } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import {
  agents, hc, exec, home, checking, readTextFile, writeTextFile,
  shared, setShared, run, theme, props, closeOverlay,
} from "herdr";
import { parseConfig, DEFAULTS } from "./config.js";
import { createEngine, holdsLease, needsReload } from "./engine.js";
import { stamp, shortStamp, segments } from "./thread.js";
import { claudeArgs, extractText, CLAUDE_TIMEOUT_MS } from "./claude.js";

const TICK_MS = 15000;
const POLL_MS = 3000; // 他のコピーの書き込みと次スレの依頼を見る間隔
const SHOWN_POSTS = 200; // 描くのは新しいほうからこの件数まで
const NARROW_PX = 260;

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
    this.rev = shared("nanj.rev");
    this.rotateSeen = shared("nanj.rotate");
    this.lastText = null; // thread.json を最後に読み書きしたときの中身
    this.follow = true;
    this.width = 440;
    this.scroll = ScrollHandle.new();
    this.engine = createEngine({
      listAgents: () => agents(),
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
      load: async () => {
        this.lastText = await readTextFile(this.dir + "/thread.json");
        return this.lastText;
      },
      save: async (text) => {
        const path = this.dir + "/thread.json";
        try {
          await writeTextFile(path, text, this.lastText);
        } catch (e) {
          // 別のコピーが先に書いていた。上書きせず、保存されている内容を正として読み直す。
          await this.engine.reload(Date.now());
          throw e;
        }
        this.lastText = text;
      },
      config: () => this.cfg,
      rand: Math.random,
      changed: () => {
        this.rev = `${Date.now()}-${Math.random()}`;
        setShared("nanj.rev", this.rev);
      },
    });
    if (checking()) return;

    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", this.dir]);
      await this.loadConfig();
      if (typeof shared("nanj.paused") !== "boolean") setShared("nanj.paused", !this.cfg.enabled);
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
      const stale = !this.leader && shared("nanj.rev") !== this.rev;
      const rotate = this.leader && shared("nanj.rotate") !== this.rotateSeen;
      if (!stale && !rotate) return;
      cx.spawn(async (cx) => {
        await this.catchUp(Date.now());
        cx.notify();
      });
    });
  }

  /** 他のコピーの書き込みを取り込み、生成役なら次スレの依頼を処理する。 */
  async catchUp(now, wasLeader = this.leader) {
    const rev = shared("nanj.rev");
    if (needsReload(wasLeader, this.leader, rev, this.rev)) {
      this.rev = rev;
      await this.engine.reload(now);
    }
    const rotate = shared("nanj.rotate");
    if (this.leader && rotate !== this.rotateSeen) {
      this.rotateSeen = rotate;
      await this.engine.rotate(now);
    }
  }

  async loadConfig() {
    try {
      this.cfg = parseConfig(await readTextFile(this.dir + "/config.json"));
    } catch (_e) {
      this.cfg = { ...DEFAULTS };
    }
  }

  /** 生成役なら 1 回分進める。生成役は shared のリースで 1 つに絞る。 */
  async pump() {
    const now = Date.now();
    const wasLeader = this.leader;
    this.leader = holdsLease(shared("nanj.leader"), this.id, now);
    if (this.leader) setShared("nanj.leader", { id: this.id, at: now });
    await this.catchUp(now, wasLeader);
    if (!this.leader) return;
    await this.loadConfig();
    const paused = shared("nanj.paused") === true;
    if (this.engine.paused !== paused) this.engine.setPaused(paused);
    await this.engine.tick(now);
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
    const thread = this.engine.thread;
    const paused = shared("nanj.paused") === true;
    const error = shared("nanj.error") ?? this.engine.error;
    const posts = thread.posts.slice(-SHOWN_POSTS);
    const live = new Set(agents().map((a) => a.address));
    const narrow = this.width < NARROW_PX;
    const overlay = (props() ?? {}).overlay;
    if (this.follow && posts.length > 0) this.scroll.scroll_to_item(posts.length - 1);

    const button = (id, label, onClick) =>
      div().id(id).flex_none().px(8).py(2).rounded(4).bg(c.button).text_color(c.buttonText).text_size(12)
        .cursor_pointer().hover((s) => s.opacity(0.8))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { onClick(cx); cx.notify(); })
        .child(label);

    const focus = (post) => () => {
      if (post.agent !== null && live.has(post.agent)) run("agent.focus", { terminal: post.agent });
    };

    const row = (post) => {
      const own = post.agent !== null;
      const nameColor = own ? c.agents[(thread.colors[post.agent] ?? 0) % c.agents.length] : c.name;
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

    return v_flex().id("nanj-root").size_full().bg(c.bg).text_size(13).text_color(c.text)
      .on_size_change((size, cx) => { this.width = size.width; cx.notify(); })
      .child(v_flex().flex_none().px(8).py(6).gap(4).border_b_1().border_color(c.line)
        .child(div().text_color(c.title).font_semibold().child(thread.title ?? "スレ立て待ち"))
        .child(h_flex().gap(6).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(error ? c.title : c.meta)
            .child(error ?? (paused ? "停止中" : "実況中")))
          .child(button("nanj-pause", paused ? "再開" : "停止", () => this.togglePause()))
          .child(button("nanj-next", "次スレ", () => setShared("nanj.rotate", Date.now())))
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
