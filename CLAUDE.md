# OPS日調アプリ — 作業の手引き

ドットジェイピー OPS業務用（面談の日程調整・イベント出欠・スタッフ間の日程調整）。
タスク（ふつうの依頼）を出す機能は別のアプリへ移したので、2026-10-05 に撤去した。**戻さないこと。**

**このアプリはスタッフ専用。** インターン生用のページ・画面は今後作らない（2026-10-05 の方針）。
インターン生向けの機能を足したり広げたりしないこと。

**絶対制約：料金が発生する方法は禁止。** 無料枠で完結する構成のみ。

## この地図の使い方

ファイルが大きいので、**全文を読まないこと**。下の表で当たりを付けて
`Grep` で関数名やセクション名を引き、必要な数十行だけ読む。
行番号は目安（編集で動く）。**セクション名は動かないので、そちらで引くこと**。

## ファイル構成

| ファイル | 中身 |
|---|---|
| `index.html` | フロント全部（画面・ロジック・テンプレート） |
| `style.css` | 全画面のCSS。`apply.html` と `attendance.html` も読む |
| `apply.html` | インターン生の面談申請（**ログイン不要**・別実装・ES5風） |
| `free.html` | 日程調整（**ログイン不要**・空き時間だけを集める。`apply.html` から派生） |
| `attendance.html` | 公開の出欠回答ページ（**ログイン不要**・`/style.css` を読む） |
| `book.html` | 予約スケジュールの予約ページ `/b/<合言葉>` と変更・キャンセル `/b/manage/<合言葉>`（**ログイン不要**・`style.css` は読まない・クラスは `bk-`） |
| `server/server.js` | Express API 本体 |
| `server/` の他 | `slots.js` 空き枠 / `google.js` カレンダー / `stream.js` SSE / `mail.js` / `ical.js` / `auth.js` / `dblock.js` |
| `demo/` | 左メニュー・ホームのホバーで流れる「相手の回答画面」の動画（mp4＋webm）。**手で編集せず** `node tools/record-demos.mjs` で作る |
| `server/booking.js` / `booking-routes.js` | 予約スケジュールの枠の計算（純粋関数）と API 一式（`/api/booking-pages` `/api/book/*`） |
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
| 4325 | 日程調整（旧「依頼」） | 一覧（未回答・回答済み・送った）。データ名は `requests` のまま |
| 4537 | 空き時間を確認 | 日程調整URL（`free.html`）の一覧・詳細 |
| **4781** | **出欠確認** | 集計・回答・確定・共有URL・ミニカレンダー |
| 5173 | 日程調整を出す | 「日程を決める」フォーム（`openRequestForm` / `submitRequest`） |
| 5086 | BOOT | 起動処理・自動ログイン |
| — | 予約スケジュール | 一覧・編集シート（`viewBooking` / `openBookingEditor` / `bkSave`）。CSSは `bkp-` |

出欠まわりでよく触る関数：
`openAttendDetail` 集計シート / `openAttendOption` 日程ごとの回答状況 /
`reqOptionsHTML` 候補の一覧 / `submitRequest` 送信 / `attendTally` 集計 /
`attendBest` 最有力 / `fmtSlot` 日時の表示

## `server/server.js` の地図

| 行の目安 | セクション |
|---|---|
| 1134 | データの見える範囲・変えてよい範囲（ロール別）。`mergeScoped` / `validateDiff` |
| 2511 | 一斉に使われる操作の専用API（日程調整・出欠・通知・面談）。`POST /api/requests` は `kind:'attend'` だけ受け付ける |
| 2980 | 全体予定表 |
| 3164 | iCalendar購読 |
| 末尾 | `PUBLIC_FILES`（**静的配信は許可制**。ファイルを増やしたらここに足す） |

## `style.css` の地図

`/* ---------- 名前 ---------- */` で区切ってある。`Grep` でその名前を引く。
出欠は558行あたり、シートは485行あたり、フォームは318行あたり。

## テスト（触ったら必ず走らせる）

```bash
node tools/test-fmt.mjs        # 102件・約1秒。HTMLから関数を切り出して動かす
node tools/e2e.mjs             # 553件・約3秒。実サーバーを8123番で起動して実APIを叩く
node tools/e2e.mjs --quiet     # 失敗したものだけ出す（ふだんはこちら）
node tools/e2e.mjs --only 出欠  # 見出しに その語 を含む区画だけ出す
node tools/test-stream.mjs     # SSE（27件）
node tools/test-ratelimit.mjs  # 公開ページの回数制限（23件）
# 確認用ページ（tools/make-test-page.mjs）は今後作らない・走らせない（2026-10-05 の指示）
node tools/record-demos.mjs    # demo/ の動画を撮り直す（要 Playwright と ffmpeg・約1分・8124番を使う）
node tools/test-booking.mjs    # 予約スケジュールの枠の計算（31件）
node tools/test-booking-e2e.mjs # 予約の通し（56件）。偽のGoogleを立てて8125番で起動
node tools/test-booking-e2e.mjs --serve  # 画面確認用に立てたままにする（URLが出る）
```

**e2eでは公開ページの回数制限を切ってある**（`PUBLIC_WRITE_PER_MIN=0`）。
1つのIPから100件を同時に送る検査があり、制限が効くと必ず落ちるため。
制限そのものの検査は `test-ratelimit.mjs` が受け持つ。

`e2e.mjs` には**HTMLやCSSの文字列を直接見る検査**が入っている。
仕様を変えたら、その検査を**消さずに新しい仕様へ書き換える**こと。

## 落とし穴（何度も踏んでいるもの）

- **リポジトリ直下のファイルだけを変えた push は、Render がビルドしない**（`rootDir: server`）。
  `index.html` `style.css` `demo/` などだけの変更は、main に入っても本番に出ない
  （2026-10-05 に動画だけ差し替えた push が出なかった）。出したいときは
  `server/package.json` の `version` を上げるなど、`server/` の中も一緒に変えること。
  Renderダッシュボードの Included Paths に `demo/**` が入っていなければ足す（ユーザー作業）

- **`apply.html` / `free.html` / `attendance.html` の見た目や流れを変えたら、
  `node tools/record-demos.mjs` で `demo/` の動画も撮り直す。** 動画が古いと、
  ホバーで見せる「相手の画面」が実物と食い違う（ホバー表示は `index.html` の `DEMOS`）

- **CSSのクラス名には接頭辞を付ける。** `empty` `mark` のような短い名前は既存と衝突し、
  テストは全部通ったまま画面だけ崩れる
- **`style.css` は `apply.html` の `<style>` に負けることがある。** 画面で必ず目視する
- **`PUBLIC_FILES` に無いファイルは配信されない**（404になる）
- **関数を消したら呼び出し口も grep する。** テストが通っても実行時に落ちる
- **`readDB()` の戻り値は書き換え禁止**（プロセス内キャッシュそのもの）。`readDBForWrite()` を使う
- **サーバーの時計は `process.env.TZ='Asia/Tokyo'` で固定してある。** Renderの実行環境はUTC
- **Renderは Build 成功後の Deploy 段階で落ちることがある。** ログに理由が出ないときは
  Manual Deploy → Deploy latest commit をやり直せば通る
- **初めてGoogleログインした人には intern の行ができる。これは塞がないこと**
  （2026-08-12に一度塞いで戻した）。intern のままでは requireAuth に弾かれて何も
  できないが、管理者のユーザー管理に姿が出るのでスタッフへ変えれば使えるようになる。
  `@dot-jp.or.jp` を持たない人を迎え入れる道はこれしかない
- **メールアドレスは本人・管理者・支部管理者にしか渡さない**（`scrubEmail`）。
  画面で他人のアドレスが要る機能を足すときは、ここを緩めるのではなく専用APIを作る
- **ログイン不要の口を足したら回数制限も付ける**（`server/ratelimit.js` の
  `limitPublicWrite` / `limitPublicRead`）。合言葉は配布先が広く、漏れる前提で考える

## 本番へ出すまで

`origin`（`dot-jp-opsteam/NitteiChoseiApp`）の main に push → Render が自動デプロイ →
https://ops-nittyou-app.onrender.com （入口は https://dot-jp-opsteam.github.io/NitteiChoseiApp/ ）

main への push は本番公開になるが、**ユーザーの許可なしで本番反映までしてよい**
（2026-10-05 に常時許可を受けた）。ただし push の前に、上のテストを全部通すこと。

無料プランは15分で寝るので、最初のアクセスに20〜60秒かかる。

**`_backup/` は全員分のメールアドレスとパスワードのハッシュが入る。publicリポジトリに絶対コミットしない。**
