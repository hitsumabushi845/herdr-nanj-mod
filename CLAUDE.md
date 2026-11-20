# herdr-nanj-mod

Herdr app の mod `nanj` のリポジトリ。設計は `docs/superpowers/specs/2026-11-16-nanj-thread-design.md` にある。

## コマンド

- `pnpm test` は vitest を実行する。
- `pnpm run install:mod` は `mods/nanj` を `~/.config/herdr-app/mods/nanj` へコピーする。
- `pnpm run check` は `herdr-app check` でコピー先の mod を検査する。

mod を変えたら `install:mod` と `check` をこの順に実行する。

## 決まり

- mod は Agent の端末に入力を送らない。使ってよいのは `hc read` と `agent.focus` だけ。
- `mods/nanj/` の `main.js` 以外のファイルは `herdr`、`gpui-kit`、`gpui-base` を import しない。Node 上の vitest でテストするためである。
- コミットメッセージは日本語で書く。

## 確かめた事実

2026-11-16 に herdr-app 0.1.16 と実機で確かめた。

### claude の呼び出し

採用する引数は次のとおり。

```
claude -p --model <model> --tools "" --strict-mcp-config --setting-sources "" \
  --no-session-persistence --output-format json \
  --system-prompt <system> --json-schema <schema> <user>
```

- mod の `exec` から標準入力なしで呼べる。終了コードは 0 で、応答は 3 秒から 4 秒で返る。`exec` のタイムアウトは 60000 にする。
- 利用者のフック、プラグイン、CLAUDE.md の影響は出力に出ない。
- 標準出力は 1 つの JSON で、`structured_output` にスキーマどおりのオブジェクトが入る。`result` には同じ内容の JSON の文字列が入る。`is_error` が true のときは失敗として扱う。実際の出力の例は `test/fixtures/claude-output.json` にある。
- 実行するフォルダは `~/.config/herdr-nanj` にする。

### mod の置き場所

- 出荷時のレイアウト（`main`）には `mod.json` の `"place": "right"` を書いても自動では入らない。
- `mod.json` に `"overlay": { "kind": "window", "key": "nanj", "keep": true, "width": 440, "height": 620 }` を書くと、`herdr-app do mod.open --name nanj` で浮動ウィンドウとして開閉できる。
- `tab.new {mod: "nanj"}` と `pane.split {direction, mod: "nanj"}` でも置ける。

### 端末と Agent

- `agents()` と `hc ls --json` には、端末の作成時刻がない。`hc get <端末> --json` の `created_ms` にある。
- Agent は fish の端末の中で動く（`argv` は `fish -l`）。同じ端末で Agent を終了して起動し直しても、アドレスと `created_ms` は変わらない。
- 横スクロールの列（`overflow_x_scrollbar()`）は、高さを `h(n)` で決めないと縦いっぱいに広がる。

### mod のコピー

- コピーは一度表示されるまで始まらない。`tab.new {focus: false}` で作っただけのコピーは `init` も走らない。
- 2 つのコピーを動かして確かめるときは、浮動ウィンドウと、表示中のタブの `pane.split {mod}` を使う。
- `render` の中で `cx.spawn` して読み直す作りでは、生成役でないコピーが他のコピーの書き込みを取り込めなかった。原因は突き止めていない。読み直しはタイマーの中で行う。

### gpui-kit での描画

- 色の違う文字列は `h_flex().flex_wrap()` の中に `div().text_color(...)` を並べて描く。長い文字列の `div` は `min_w(0)` を付けると枠の幅で折り返す。アンカーのあとの長い本文はアンカーの次の行から始まる。
- 末尾への移動は `gpui-base` の `ScrollHandle.new()` を `init` で作り、`overflow_y_scrollbar().track_scroll(handle)` を付けた `v_flex` に対して `handle.scroll_to_item(最後の子の番号)` を呼ぶ。`VirtualListScrollHandle` 以外に `scroll_to_bottom` はない。
- 今のスクロールの位置を読む API はない。`on_scroll_wheel((e) => e.delta.y)` で利用者の操作を受け取れる。
- `Date` はローカル時刻を返す。
