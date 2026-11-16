// 確認用の仮の実装（Task 1）。Task 9 で置き換える。
import { View, div } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { exec, home, checking } from "herdr";

export default class NanjSpike extends View {
  init(_props, cx) {
    this.scroll = ScrollHandle.new();
    this.rows = Array.from({ length: 40 }, (_, i) => `レス ${i + 1} ` + "長い本文やで".repeat(i % 5 === 0 ? 12 : 1));
    this.note = "claude 未実行";
    this.wheel = "";
    if (checking()) return;
    cx.spawn(async (cx) => {
      const t0 = Date.now();
      try {
        const r = await exec("claude", ["-p", "--model", "haiku", "--tools", "", "--strict-mcp-config", "--setting-sources", "",
          "--no-session-persistence", "--output-format", "json", "--system-prompt", "一言だけ返す。", "なんJ 口調で一言。"],
          { cwd: home() + "/.config/herdr-nanj", timeout: 60000 });
        this.note = `code=${r.code} ${Date.now() - t0}ms out=${r.stdout.length} err=${r.stderr.slice(0, 80)} result=${(JSON.parse(r.stdout).result ?? "").slice(0, 40)}`;
      } catch (e) { this.note = "exec 失敗: " + String(e).slice(0, 120); }
      cx.notify();
    });
  }
  render(cx) {
    const d = new Date();
    this.scroll.scroll_to_item(this.rows.length - 1);
    return v_flex().id("nanj-root").size_full().bg("#efefef").text_size(13).text_color("#000000")
      .child(div().p(6).text_color("#ff0000").font_semibold().child(`【確認】${d.getHours()}:${d.getMinutes()} tz=${d.getTimezoneOffset()} ${this.note} ${this.wheel}`))
      .child(v_flex().id("nanj-list").flex_1().min_h(0).px(8).gap(6).overflow_y_scrollbar().track_scroll(this.scroll)
        .on_scroll_wheel((e, cx) => { this.wheel = `wheel dy=${Math.round(e.delta.y)}`; cx.notify(); })
        .children(this.rows.map((r, i) => v_flex().id(`r-${i}`)
          .child(h_flex().gap(6).flex_wrap()
            .child(div().child(String(i + 1)))
            .child(div().text_color("#008000").font_semibold().child("風吹けば名無し"))
            .child(div().child("2026/11/16(月) 19:32:10"))
            .child(div().child("ID:t17")))
          .child(h_flex().flex_wrap().pl(12)
            .child(div().text_color("#0000ff").child(">>1"))
            .child(div().min_w(0).child(" " + r))))));
  }
}
