# Public Attendance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** アカウント不要の公開出欠URLと、依頼者本人の出欠回答を追加する。

**Architecture:** 既存の `requests` と `request_responses` を中心に、公開トークン列と公開回答者テーブルを追加する。ログイン不要の専用APIと `attendance.html` を用意し、ブラウザ保存した回答者キーのハッシュ照合で同じ端末からの変更を許可する。

**Tech Stack:** HTML/CSS/Vanilla JavaScript、Node.js 18+、Express、libSQL/SQLite、Node.js標準 `crypto`

## Global Constraints

- 追加の外部API、SaaS、有料ライブラリを使用しない。
- 公開回答の名前は必須、50文字以内とする。
- 公開URLを知る人全員が名前と回答結果を閲覧できる。
- 回答者キーはサーバーに平文保存しない。
- 日程確定後は回答変更を拒否する。

---

### Task 1: API回帰テスト

**Files:**
- Modify: `tools/e2e.mjs`

**Interfaces:**
- Consumes: 既存の認証ヘルパーと `/api/requests` API
- Produces: 公開出欠APIと依頼者本人回答の受け入れ条件

- [ ] **Step 1: 失敗するE2Eテストを書く**

`tools/e2e.mjs` の出欠確認シナリオへ、`public_access:true` で作成した結果に `public_url` があること、未認証GET、名前なしPUTの400、初回PUTで `respondent_key` が返ること、同じキーで回答変更できること、不正キーが403になること、GET結果に回答者名と変更後回答が含まれることを追加する。通常出欠では `recipient_ids` に送信者IDが含まれ、送信者のPUTが成功することも検証する。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node tools/e2e.mjs`

Expected: 公開出欠URLまたは公開APIが未実装のためFAIL。

- [ ] **Step 3: テスト内容を固定する**

公開取得の返却形を `{request, respondents}`、公開回答の返却形を `{ok, respondent_key, respondent, saved}` とし、後続実装はこの契約へ合わせる。

### Task 2: 公開出欠の保存モデルとAPI

**Files:**
- Modify: `server/server.js`
- Test: `tools/e2e.mjs`

**Interfaces:**
- Consumes: `POST /api/requests` の `public_access:boolean`
- Produces: `GET /api/attendance/:token`、`PUT /api/attendance/:token/response`

- [ ] **Step 1: DBマイグレーションを追加する**

`requests.public_token` を追加し、`public_attendance_respondents(request_id, respondent_id, key_hash, display_name, created_at, updated_at)` を作成する。`public_token`、`(request_id, key_hash)` に一意インデックスを付ける。

- [ ] **Step 2: 作成APIへ公開モードを実装する**

出欠確認かつ `public_access===true` の場合だけ32バイトの公開トークンを生成する。宛先は送信者を必ず含め、通常出欠でも送信者を重複なく含める。通常依頼では `public_access` を無視する。

- [ ] **Step 3: 公開取得APIを実装する**

トークンで出欠確認を検索し、件名・本文・候補・確定状態・依頼者表示名・登録ユーザーと公開回答者の表示名・回答だけを返す。存在しないトークンは404にする。

- [ ] **Step 4: 公開回答APIを実装する**

名前と候補別回答を検証する。初回は24バイトの回答者キーと公開回答者IDを生成し、キーのSHA-256だけを保存する。更新はキーのハッシュ一致を必須にし、回答者名と既存回答を更新する。不正キーは403、確定後は409にする。

- [ ] **Step 5: APIテストを通す**

Run: `node tools/e2e.mjs`

Expected: 公開出欠と依頼者本人回答を含む全項目がPASS。

### Task 3: ログイン済み画面の公開モード

**Files:**
- Modify: `index.html`
- Test: `test/ui-color-regression.html`

**Interfaces:**
- Consumes: `POST /api/requests` の `public_access` と返却 `request.public_url`
- Produces: 「誰でも回答OK」タブ、共有URLコピー、依頼者本人の受信一覧

- [ ] **Step 1: UI回帰テストを追加する**

出欠確認時だけ `public` モードが一番左に存在すること、通常依頼では存在しないこと、公開モードで `public_access:true` を送ることを静的回帰テストへ追加する。

- [ ] **Step 2: 宛先タブと送信処理を実装する**

`openRequestForm('attend')` の初期モードを `public` にし、`REQ_MODES` の表示列先頭に「誰でも回答OK」を追加する。公開モードでは個別宛先選択を隠し、送信ボディへ `public_access:true` を付ける。

- [ ] **Step 3: 依頼詳細へ共有URLを表示する**

公開出欠の詳細に読み取り専用URLとコピー操作を表示する。依頼者本人を `myRequests()` の対象に含め、回答UIを表示する。

- [ ] **Step 4: UI回帰テストを通す**

Run: ブラウザで `test/ui-color-regression.html` を開き、全項目PASSを確認する。

### Task 4: ログイン不要の公開回答画面

**Files:**
- Create: `attendance.html`
- Modify: `server/server.js`
- Test: `tools/e2e.mjs`

**Interfaces:**
- Consumes: `GET /api/attendance/:token` と `PUT /api/attendance/:token/response`
- Produces: `/a/:token` の公開回答・結果画面

- [ ] **Step 1: 公開ページのルートを追加する**

`/a/:token` を `attendance.html` へ配信し、パスからトークンを読む。

- [ ] **Step 2: 回答フォームを実装する**

名前入力と各候補の○・△・×を表示する。`localStorage` のキー `ops_attendance_respondent_<request-id>` へ回答者キーを保存し、再訪時は既存回答をフォームへ反映する。

- [ ] **Step 3: 結果表示を実装する**

候補ごとの○・△・×人数、回答者名、個別回答を常時表示する。全ユーザー入力を `esc()` でエスケープし、確定後はフォームを無効化して結果だけを表示する。

- [ ] **Step 4: 全体検証を行う**

Run: `node tools/e2e.mjs`

Expected: 全E2E項目PASS。続けてローカルブラウザで公開URLを開き、初回回答、再読込、回答変更、別ブラウザ相当の結果閲覧を確認する。

### Task 5: 完了確認

**Files:**
- Verify: `server/server.js`
- Verify: `index.html`
- Verify: `attendance.html`
- Verify: `tools/e2e.mjs`

**Interfaces:**
- Consumes: Tasks 1-4の実装
- Produces: リリース可能な検証結果

- [ ] **Step 1: 無料要件を確認する**

依存関係と差分を確認し、新しい外部API、SaaS、npm依存が追加されていないことを確認する。

- [ ] **Step 2: 差分とテスト結果を確認する**

Run: `git diff --check`

Run: `node tools/e2e.mjs`

Expected: 空白エラーなし、全テストPASS。

- [ ] **Step 3: ブラウザ検証を行う**

ログイン済み画面で公開出欠を作成し、公開画面を別セッションで開いて名前必須、回答、結果閲覧、同一ブラウザでの変更を確認する。

