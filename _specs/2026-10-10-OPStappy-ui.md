# OPStappy の画面・操作を Tappy に合わせる（2026-10-10）

## 確定した要件

- 名前は OPStappy。作成・管理は OPS スタッフのログインを維持する。
- 共有 URL を知る人はログインなしで回答し、全員の名前と集計を閲覧できる。
- Tappy の編集用パスワードを知る人への管理権限は導入しない（ユーザー回答「作成・管理はOPSスタッフのまま」）。
- 既存の表・回答・本人編集 URL は保持する。自動削除は導入しない。無料の構成を維持する。

## 本家で確認した画面と反映

参照: http://tap-py.com/create 、http://tap-py.com/usage 、http://tap-py.com/faq 、http://tap-py.com/img/sample5.jpg 。本家にテストイベント・回答を送信せず確認した。

- 作成画面: 青いイベント名・詳細欄、時間割形式／カレンダー形式ボタン。下段は白地で左に設定と縦横入力、右に灰色のプレビュー。
- 設定・入力を即時プレビューへ反映。最後の入力欄に名前を入れると次の空欄を追加。
- 時間割: Mon–Fri（任意で Sat/Sun）、数字の時間数、昼休みは末尾。
- カレンダー: M/D、HH:mm の見出し、終了時刻も含める。既存形式のデータは変更しない。
- 公開画面: 青い導入画面、白い下段に左「みんなの予定」、右に登録者名、共有 URL とコメント。名前を押して集計対象を切り替える。人数の濃淡表示とコメント欄。
- 回答は本家の現行ページで確認した「1. 空き時間 → 2. 名前 → 3. コメント」の順。本人の編集は既存の本人専用 URL を維持する。
- 作成済みの表は固定 ID を保持して編集する。空にした既存項目は非表示にして回答との対応を残す。

## 確認

以下の CLI テストはすべて成功（合計 1,031 件）。

| コマンド | 成功件数 |
|---|---:|
| `node tools/test-fmt.mjs` | 127 |
| `node tools/e2e.mjs --quiet` | 575 |
| `node tools/test-stream.mjs` | 27 |
| `node tools/test-ratelimit.mjs` | 23 |
| `node tools/test-booking.mjs` | 31 |
| `node tools/test-booking-editor.mjs` | 6 |
| `node tools/test-booking-e2e.mjs` | 56 |
| `node tools/test-login.mjs` | 21 |
| `node tools/test-tally.mjs` | 36 |
| `node tools/test-tally-e2e.mjs` | 129 |

`node tools/test-tally-e2e.mjs --serve` の localhost:8129 で、Playwright による追加 4 件と既存の再送・競合 3 件も成功。追加テストは `tools/test-opstappy-browser.mjs` の `runOPStappyBrowserTests(browser)` を呼び出す。既存テストは `tools/test-tally-browser.mjs` の `runTallyBrowserTests(page)`。

- 作成・集計・回答のデスクトップ表示と 320px／390px を確認。ページ横はみ出しなし、ページ JavaScript エラーなし。
- 公開画面のログイン不要フォームは Codex の実ブラウザでも確認。
- 同時更新時の競合拒否、通信失敗後の再送、既存回答の固定 ID の対応を維持。

この変更は確認した主要画面・操作の再現。Tappy 本体の未確認の内部処理まで同一とは扱わない。
