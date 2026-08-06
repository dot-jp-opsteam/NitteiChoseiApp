# Attendance Candidate Modes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 出欠確認で日付のみ・日付＋時間・時間のみを扱い、公開送信後に共有URL付き回答ページへ直行できるようにする。

**Architecture:** 既存の `requests.options` JSONへ `has_date`、`has_time`、`date`、`start_time`、`end_time` を追加し、従来の `start`、`end` との後方互換を保つ。ブラウザ側は共通の候補表示規則を持ち、サーバー側は候補形式を検証して、時間のみの場合だけカレンダー作成を省略する。

**Tech Stack:** Vanilla HTML/CSS/JavaScript、Node.js、Express、libSQL/Turso、Google Calendar API、既存 `tools/e2e.mjs`

## Global Constraints

- 新しい有料サービスや依存パッケージを追加しない。
- 既存候補は日付＋時間として扱う。
- 日付のみの内部時刻 `01:00〜01:30` は利用者画面に表示しない。
- 時間のみを確定した場合、アプリ内・Googleのどちらにも予定を登録しない。
- 未追跡の `test/ui-color-regression.html` は変更・コミットしない。

---

### Task 1: 候補データのAPI検証と確定処理

**Files:**
- Modify: `server/server.js:640-670,2150-2220,2416-2464`
- Test: `tools/e2e.mjs:440-530`

**Interfaces:**
- Consumes: `POST /api/requests` の `options: Array<{date?: string,start_time?: string,end_time?: string,has_date: boolean,has_time: boolean,start?: string,end?: string}>`
- Produces: `request.options` に `id` と形式フラグを保持し、`POST /api/requests/:id/confirm` が `{event: object|null, notification}` を返す。

- [ ] **Step 1: 失敗するAPIテストを追加する**

`tools/e2e.mjs` に、次を送信・取得・確定する検証を追加する。

```js
const dateOnly = { date: '2030-08-08', has_date: true, has_time: false };
const timed = { date: '2030-08-09', start_time: '19:00', end_time: '21:00', has_date: true, has_time: true };
const timeOnly = { start_time: '20:00', end_time: '22:00', has_date: false, has_time: true };
```

日付のみは `01:00〜01:30` を内部保存し、時間のみ確定は `event === null`、日付あり確定は `event !== null` になることを検証する。既存 `{start,end}` 候補も受理されることを残す。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node tools/e2e.mjs`
Expected: 新形式候補の保存または時間のみ確定の検証がFAIL。

- [ ] **Step 3: 候補正規化を実装する**

`server/server.js` に `normalizeAttendOption(raw, id)` と `attendOptionHasDate/Time` を追加する。日付のみはAsia/Tokyo相当のローカル `01:00〜01:30` からISOを生成し、時間のみは `start`/`end` を作らず表示用時刻を保持する。旧形式は両方trueとして保存する。

- [ ] **Step 4: 確定処理を分岐する**

`has_date === false` ではイベント作成を省略し、`confirmed` だけ更新する。日付ありでは既存の内部イベントを作る。Google連携がある送信者には `google.createEvent()` でタイトル、開始、終了だけを送り、日付のみでは `01:00〜01:30` を使う。Google未連携またはGoogle通信失敗でも内部確定は成功させ、ログへ警告する。

- [ ] **Step 5: APIテストを通す**

Run: `node tools/e2e.mjs`
Expected: 追加した候補形式・確定テストを含め全件成功。

- [ ] **Step 6: コミットする**

```bash
git add server/server.js tools/e2e.mjs
git commit -m feat-attendance-option-api
```

### Task 2: スタッフ側の候補入力と表示

**Files:**
- Modify: `index.html:4102-4338,4410-4669`
- Test: `tools/e2e.mjs`

**Interfaces:**
- Consumes: Task 1の候補形式。
- Produces: `REQFORM.noDate`、`REQFORM.withTime`、`setReqNoDate(on)`、`setReqWithTime(on)`、`fmtSlot(option)`。

- [ ] **Step 1: 失敗するHTML回帰テストを追加する**

`tools/e2e.mjs` で配信された `index.html` に、2つの切替、明日初期値、`+1日`、`+1時間`、公開送信後の `location.assign(request.public_url)` が含まれることを検証する。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node tools/e2e.mjs`
Expected: 新しい切替関数または遷移処理がないためFAIL。

- [ ] **Step 3: フォーム状態と切替を実装する**

`REQFORM` を次で初期化する。

```js
REQFORM={mode:'public',picked:[],kind:'attend',opts:[],noDate:false,withTime:false};
```

「日程を設定しない」ON時は `withTime=true` を強制し、ON中の時間OFF操作は受け付けない。候補一覧の全行を同じ形式で描画する。

- [ ] **Step 4: 候補初期値・追加を実装する**

最初の日付は明日、時間は保持値 `19:00〜21:00` とする。追加時は直前の日付を1日進め、時刻を各1時間進める。終了側が24時を超える場合は両方を `00:00〜01:00` にする。

- [ ] **Step 5: 表示・検証・送信後遷移を実装する**

`fmtSlot()` を3形式対応にし、確認文言も時間のみではカレンダー非登録を示す。`submitRequest()` は公開URLが返ったら状態保存後に `location.assign(attendShareUrl(request))` で同じタブを移動する。

- [ ] **Step 6: テストを通す**

Run: `node tools/e2e.mjs`
Expected: 全件成功。

- [ ] **Step 7: コミットする**

```bash
git add index.html tools/e2e.mjs
git commit -m feat-attendance-candidate-form
```

### Task 3: 公開回答ページの共有URLと候補表示

**Files:**
- Modify: `attendance.html:1-89`
- Test: `tools/e2e.mjs`

**Interfaces:**
- Consumes: Task 1が返す公開 `request.options`。
- Produces: `slotText(option)` と `copyShareUrl()`。

- [ ] **Step 1: 失敗する公開HTMLテストを追加する**

`tools/e2e.mjs` で `attendance.html` に `shareUrl`、`copyShareUrl`、3形式対応の `slotText` が存在することを検証する。

- [ ] **Step 2: テストが失敗することを確認する**

Run: `node tools/e2e.mjs`
Expected: 共有URL UIがないためFAIL。

- [ ] **Step 3: 最上部の共有URL UIを実装する**

回答内容カードより前に `location.href` の読み取り専用入力と「コピー」ボタンを表示する。Clipboard API失敗時は入力を選択し、「選択したURLをコピーしてください」と表示する。

- [ ] **Step 4: 3形式の候補表示を実装する**

旧形式を日付＋時間として扱い、日付のみは日付だけ、時間のみは `時間（日程未定）` と表示する。確定表示と集計表示も同じ関数を使う。

- [ ] **Step 5: テストを通す**

Run: `node tools/e2e.mjs`
Expected: 全件成功。

- [ ] **Step 6: コミットする**

```bash
git add attendance.html tools/e2e.mjs
git commit -m feat-public-attendance-sharing
```

### Task 4: 総合検証と本番反映

**Files:**
- Verify: `index.html`
- Verify: `attendance.html`
- Verify: `server/server.js`
- Verify: `tools/e2e.mjs`

**Interfaces:**
- Consumes: Tasks 1〜3の完成コード。
- Produces: GitHub `main` とRender本番。

- [ ] **Step 1: 構文・空白・自動テストを確認する**

```bash
node --check server/server.js
node --check tools/e2e.mjs
git diff --check
node tools/e2e.mjs
```

Expected: 構文エラーなし、空白エラーなし、全テスト成功。

- [ ] **Step 2: ブラウザで主要導線を確認する**

公開送信、即時遷移、URLコピー、3形式の表示、○△×回答、時間のみ確定時の非登録表示を確認する。ブラウザコンソールにエラーがないことを確認する。

- [ ] **Step 3: 差分範囲を確認する**

```bash
git status --short
git diff origin/main...HEAD --stat
```

Expected: 計画対象ファイルと設計・計画書だけ。`test/ui-color-regression.html` は未追跡のまま。

- [ ] **Step 4: mainをpushする**

```bash
git push origin main
```

- [ ] **Step 5: 本番を確認する**

`https://ops-nittyou-app.onrender.com/` と `/attendance.html` のHTTP 200、新しい識別子、無効公開トークンのJSON 404を読み取り確認する。本番データを使った書き込みテストは行わない。

