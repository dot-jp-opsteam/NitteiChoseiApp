# 出欠確認候補の直接時刻入力 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** ダークモードで日付アイコンを視認可能にし、出欠確認候補の開始・終了時刻を数字だけで素早く入力できるようにする。

**Architecture:** index.html の出欠候補フォームで時刻選択肢を数値テキスト入力へ置換する。時刻正規化関数が数値を HH:MM に変換し、既存の REQFORM.opts の t1 / t2 と送信APIには正規化済みの文字列だけを渡す。テーマ固有CSSはダークテーマのネイティブ日付ピッカーアイコンだけを反転する。

**Tech Stack:** 単一HTMLのVanilla JavaScript/CSS、Node.js E2Eテスト（tools/e2e.mjs）。

## Global Constraints

- 新しいライブラリ・有料サービス・DB変更を追加しない。
- 保存・API送信の時刻は既存どおり24時間制 HH:MM を使う。
- 日付のみ・時間のみ・候補追加・公開出欠の既存挙動を変えない。
- 開始4桁で終了欄へ移動し、終了3桁は先頭を0で補う。

---

### Task 1: 数字時刻の正規化とフォーム検証

**Files:**
- Modify: index.html の setReqWithTime、syncReqOptions、reqOptionsHTML、submitRequest
- Test: tools/e2e.mjs の公開出欠フォーム検査

**Interfaces:**
- Produces: normalizeReqTime(raw, options) returns value, complete, valid.
- Produces: handleReqTimeInput(index, field, input) updates REQFORM.opts.
- Consumes: REQFORM.opts[index].t1 / t2 as HH:MM strings.

- [ ] **Step 1: 失敗するHTML構造テストを追加する**

```js
check('出欠候補は数値時刻入力を使う',
  appHtml.includes('inputmode="numeric"') && appHtml.includes('handleReqTimeInput('), true);
check('開始時刻4桁で終了欄へ自動移動する',
  appHtml.includes("document.getElementById('ro_b'+i)?.focus()"), true);
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: node tools/e2e.mjs

Expected: direct-input checks are NG because the form still uses select.

- [ ] **Step 3: 最小の時刻正規化と入力処理を実装する**

Replace each select ro_a / ro_b with text input using inputmode=numeric. normalizeReqTime removes non-numeric characters, converts four digits to HH:MM, and converts a three-digit end value to zero-padded HH:MM. On a valid completed start value, focus ro_b for the same candidate. Reject incomplete or invalid times before the existing end-after-start comparison.

- [ ] **Step 4: テストが通ることを確認する**

Run: node tools/e2e.mjs

Expected: all direct-input and existing attendance checks pass.

- [ ] **Step 5: コミットする**

```bash
git add index.html tools/e2e.mjs
git commit -m "feat: add direct attendance time input"
```

### Task 2: ダークモードの日付アイコンと回帰確認

**Files:**
- Modify: index.html のテーマCSSと候補日付入力スタイル
- Test: tools/e2e.mjs の公開出欠フォーム検査

**Interfaces:**
- Consumes: html data-theme=dark and candidate date inputs.
- Produces: dark mode only, the WebKit calendar picker indicator uses filter: invert(1).

- [ ] **Step 1: 失敗するテーマ装飾テストを追加する**

```js
check('ダークモードの候補日付アイコンを白くする',
  appHtml.includes('calendar-picker-indicator') && appHtml.includes('filter:invert(1)'), true);
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: node tools/e2e.mjs

Expected: the calendar icon check is NG because the selector is absent.

- [ ] **Step 3: ダークテーマ限定のCSSを追加する**

```css
[data-theme="dark"] .optrow input[type="date"]::-webkit-calendar-picker-indicator {
  filter: invert(1);
  opacity: 1;
}
```

Keep the selector limited to candidate rows and do not change the light theme.

- [ ] **Step 4: 全E2Eと構文・差分検査を実行する**

Run: node --check tools/e2e.mjs && node --check server/server.js && git diff --check && node tools/e2e.mjs

Expected: exit code 0 and all tests pass.

- [ ] **Step 5: ブラウザで入力体験を確認する**

Verify in dark mode:

```text
開始欄: 1146 → 11:46 → 終了欄へフォーカス
終了欄: 457 → 04:57
候補日付: 白いカレンダーアイコン
```

- [ ] **Step 6: コミットする**

```bash
git add index.html tools/e2e.mjs
git commit -m "fix: improve dark attendance date input"
```
