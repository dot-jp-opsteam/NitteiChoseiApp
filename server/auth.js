/* =========================================================
   認証ヘルパー
   - セッショントークンの生成・検証（DBには sha256(token) のみ保存）
   - リクエストからの Bearer トークン取り出し
   すべてNode標準のcrypto/utilのみで実装（追加npm依存なし）

   ※以前はCookieでセッションを持っていたが、Cookieはブラウザ全体で共有されるため
     「タブごとに別のアカウントでログインする」ことができなかった。
     現在はトークンを Authorization ヘッダで受け取り、保管場所はブラウザ側の
     sessionStorage（タブごとに独立）に任せている。Cookieは一切使わない。
   ========================================================= */
const crypto = require('node:crypto');

/* 「次回から自動ログイン」にチェックを入れた場合の有効期限。
   出欠確認のリンクを配ってから回答が集まるまで数週間空くことがあり、
   7日だと配った相手が毎回ログインし直しになるため3か月にしてある */
const SESSION_TTL_REMEMBER_MS = 90 * 24 * 60 * 60 * 1000; // 90日（約3か月）
/* チェックなしの場合。タブを閉じればトークンごと消えるので、長く持たせる意味がない */
const SESSION_TTL_TAB_MS = 12 * 60 * 60 * 1000; // 12時間

/* ---------- セッショントークン ---------- */
function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
function sessionExpiry(remember) {
  return new Date(Date.now() + (remember ? SESSION_TTL_REMEMBER_MS : SESSION_TTL_TAB_MS)).toISOString();
}

/* ---------- リクエストからトークンを取り出す ----------
   Authorization: Bearer <token> のみを見る。Cookieは意図的に見ない
   （見てしまうと、トークンを持たない新しいタブがCookieでログインできてしまい、
     「タブごとに独立」「ショートカットからは毎回ログイン」が成立しなくなる） */
function getSessionTokenFromReq(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  return m ? m[1].trim() : null;
}

module.exports = {
  newSessionToken, hashToken, sessionExpiry, getSessionTokenFromReq,
};
