# OPS日調アプリ — 作業の手引き

ドットジェイピー OPS業務用（面談の日程調整・イベント出欠・スタッフ間の依頼）。

**絶対制約：料金が発生する方法は禁止。** 無料枠で完結する構成のみ。

## この地図の使い方

ファイルが大きいので、**全文を読まないこと**。下の表で当たりを付けて
`Grep` で関数名やセクション名を引き、必要な数十行だけ読む。
行番号は目安（編集で動く）。**セクション名は動かないので、そちらで引くこと**。

## ファイル構成

| ファイル | 中身 |
|---|---|
| `index.html` | フロント全部（画面・ロジック・テンプレート）。5,200行 |
| `style.css` | 全画面のCSS。`apply.html` と `attendance.html` も読む |
| `apply.html` | インターン生の面談申請（**ログイン不要**・別実装・ES5風） |
| `attendance.html` | 公開の出欠回答ページ（**ログイン不要**・`/style.css` を読む） |
| `server/server.js` | Express API 本体。3,400行 |
| `server/` の他 | `slots.js` 空き枠 / `google.js` カレンダー / `stream.js` SSE / `mail.js` / `ical.js` / `auth.js` / `dblock.js` |
| `tools/` | テストと道具（下記） |
| `_specs/` | 設計書。**新機能の前にここを見る** |

## `index.html` の地図（セクション見出しで grep）

| 行の目安 | セクション | 主な中身 |
|---|---|---|
| 117 | アイコン | `ICON` 辞書・`ic()`。アイコンは全部インラインSVG |
| 279 | セッショントークン | `TOKEN_KEY` / `api()` / `getToken()` |
| 1028 | LOGIN | ログイン画面・Googleログイン |
| 1436 | テーマ切替 | `data-theme`。**既定はダーク** |
| 1545 | NAVIGATION | `NAV` / `render()` / `renderQuiet()` |
| 1775 | HOME | ホーム画面 |
| 1902 | カレンダー購読 | iPhone / Google への購読登録 |
| 2215 | 面談一覧・確定 | スタッフ側の面談画面 |
| 2596 | 全体予定表 | 共有カレンダー |
| 3164 | 面談可能時間帯 | 曜日ごとの受付時間 |
| 3439 | 支部管理 / 3552 ユーザー管理 | 管理者向け |
| 3930 | プロフィール | |
| 4157 | 依頼 | 依頼の一覧・作成・詳細 |
| **4284** | **出欠確認** | 集計・回答・確定・共有URL・依頼フォーム・ミニカレンダー |
| 5046 | メール履歴 | |
| 5086 | BOOT | 起動処理・自動ログイン |

出欠まわりでよく触る関数：
`openAttendDetail` 集計シート / `openAttendOption` 日程ごとの回答状況 /
`reqOptionsHTML` 候補の一覧 / `submitRequest` 送信 / `attendTally` 集計 /
`attendBest` 最有力 / `fmtSlot` 日時の表示

## `server/server.js` の地図

| 行の目安 | セクション |
|---|---|
| 1134 | データの見える範囲・変えてよい範囲（ロール別）。`mergeScoped` / `validateDiff` |
| 2225 | 一斉に使われる操作の専用API（依頼・出欠・通知・面談） |
| 2980 | 全体予定表 |
| 3164 | iCalendar購読 |
| 末尾 | `PUBLIC_FILES`（**静的配信は許可制**。ファイルを増やしたらここに足す） |

## `style.css` の地図

`/* ---------- 名前 ---------- */` で区切ってある。`Grep` でその名前を引く。
出欠は558行あたり、シートは485行あたり、フォームは318行あたり。

## テスト（触ったら必ず走らせる）

```bash
node tools/test-fmt.mjs        # 54件・約1秒。HTMLから関数を切り出して動かす
node tools/e2e.mjs             # 355件・約3秒。実サーバーを8123番で起動して実APIを叩く
node tools/e2e.mjs --quiet     # 失敗したものだけ出す（ふだんはこちら）
node tools/e2e.mjs --only 出欠  # 見出しに その語 を含む区画だけ出す
node tools/test-stream.mjs     # SSE
node tools/make-test-page.mjs  # test/デザイン確認用.html を作り直す（ログイン不要の見た目確認）
```

`e2e.mjs` には**HTMLやCSSの文字列を直接見る検査**が入っている。
仕様を変えたら、その検査を**消さずに新しい仕様へ書き換える**こと。

## 落とし穴（何度も踏んでいるもの）

- **CSSのクラス名には接頭辞を付ける。** `empty` `mark` のような短い名前は既存と衝突し、
  テストは全部通ったまま画面だけ崩れる
- **`style.css` は `apply.html` の `<style>` に負けることがある。** 画面で必ず目視する
- **`PUBLIC_FILES` に無いファイルは配信されない**（404になる）
- **関数を消したら呼び出し口も grep する。** テストが通っても実行時に落ちる
- **`readDB()` の戻り値は書き換え禁止**（プロセス内キャッシュそのもの）。`readDBForWrite()` を使う
- **サーバーの時計は `process.env.TZ='Asia/Tokyo'` で固定してある。** Renderの実行環境はUTC
- **Renderは Build 成功後の Deploy 段階で落ちることがある。** ログに理由が出ないときは
  Manual Deploy → Deploy latest commit をやり直せば通る

## 本番へ出すまで

`origin`（`dot-jp-opsteam/NitteiChoseiApp`）の main に push → Render が自動デプロイ →
https://ops-nittyou-app.onrender.com （入口は https://dot-jp-opsteam.github.io/NitteiChoseiApp/ ）

無料プランは15分で寝るので、最初のアクセスに20〜60秒かかる。

**`_backup/` は全員分のメールアドレスとパスワードのハッシュが入る。publicリポジトリに絶対コミットしない。**
