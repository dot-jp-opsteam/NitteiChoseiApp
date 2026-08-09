/* =========================================================
   ブラウザのプッシュ通知（Web Push）
   ---------------------------------------------------------
   アプリを閉じていても、端末の通知欄に知らせを出すための仕組み。
   SSE（stream.js）は「タブを開いている間だけ」なので、
   「申請が来たことに誰も気づかない」を防ぐにはこちらが要る。

   費用は0円。VAPIDという鍵を1組自分で作れば、外部サービスは要らない。
   鍵は環境変数で渡す（リポジトリには絶対に置かない）。
     VAPID_PUBLIC_KEY   … 画面側にも配る公開鍵
     VAPID_PRIVATE_KEY  … サーバーだけが持つ秘密鍵
     VAPID_SUBJECT      … 連絡先。mailto: か https: で始まる文字列

   知らせるのは2種類だけで、どちらも「誰かが操作した瞬間」に送る。
     interview … 面談の申請が届いた（担当スタッフへ）
     request   … 依頼・参加確認が届いた（あて先の全員へ）
   決まった時刻に一斉送信する「前日リマインド」は入れていない。
   Renderの無料プランは15分で寝るので、その時刻に動かす人がおらず、
   外部のcronからサーバーを起こす仕掛けが別に要るため。

   オンオフは**端末ごと**に持つ。購読は端末ごとに1つ作られるもので、
   「スマホには出すがPCには出さない」が自然に扱えるようにしている。
   ========================================================= */
'use strict';

const webpush = require('web-push');

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:ops@dot-jp.or.jp';

const PUSH_ENABLED = !!(PUBLIC_KEY && PRIVATE_KEY);
if (PUSH_ENABLED) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
} else {
  console.log('Web Push: 未設定（VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY を確認してください）');
}

/* 知らせの種類。ここに無い名前で呼ばれたら何も送らない（打ち間違いで
   全員に届くより、届かないほうが安全なため） */
const KINDS = ['interview', 'request'];
const PREF_COL = { interview: 'pref_interview', request: 'pref_request' };

async function initPushTable(client) {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      pref_interview INTEGER NOT NULL DEFAULT 1,
      pref_request INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await client.execute(
    'CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id)');
}

/* 画面から届いた購読情報の形を確かめる。
   ここを通らなかったものは保存しない（あとで送るときに落ちるため） */
function readSubscription(body) {
  const endpoint = String((body && body.endpoint) || '');
  const keys = (body && body.keys) || {};
  const p256dh = String(keys.p256dh || '');
  const auth = String(keys.auth || '');
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) return null;
  if (!p256dh || !auth) return null;
  return { endpoint, p256dh, auth };
}

/* オンオフの指定。渡されなかった種類は「オン」として扱う */
function readPrefs(body) {
  const p = (body && body.prefs) || {};
  const out = {};
  for (const k of KINDS) out[k] = p[k] === false ? 0 : 1;
  return out;
}

async function saveSubscription(client, userId, body) {
  const sub = readSubscription(body);
  if (!sub) return null;
  const prefs = readPrefs(body);
  const now = new Date().toISOString();
  /* endpoint が主キー。同じ端末から入り直しても行が増えないようにしてある。
     機種変や再インストールで endpoint は変わるので、古い行は
     送信に失敗した時点（410）で消える */
  await client.execute({
    sql: `INSERT INTO push_subscriptions
            (endpoint, user_id, p256dh, auth, pref_interview, pref_request, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?)
          ON CONFLICT(endpoint) DO UPDATE SET
            user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
            pref_interview = excluded.pref_interview, pref_request = excluded.pref_request,
            updated_at = excluded.updated_at`,
    args: [sub.endpoint, userId, sub.p256dh, sub.auth,
      prefs.interview, prefs.request, now, now],
  });
  return { endpoint: sub.endpoint, prefs: { interview: !!prefs.interview, request: !!prefs.request } };
}

async function removeSubscription(client, userId, endpoint) {
  if (!endpoint) return;
  // 自分の端末しか消せないようにする（他人の通知を止められては困る）
  await client.execute({
    sql: 'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?',
    args: [String(endpoint), userId],
  });
}

/* いまこの端末がどう設定されているか。画面のチェックの初期値に使う */
async function getSubscriptionState(client, userId, endpoint) {
  if (!endpoint) return { found: false, prefs: { interview: true, request: true } };
  const rs = await client.execute({
    sql: 'SELECT pref_interview, pref_request FROM push_subscriptions WHERE endpoint = ? AND user_id = ?',
    args: [String(endpoint), userId],
  });
  const row = rs.rows[0];
  if (!row) return { found: false, prefs: { interview: true, request: true } };
  return {
    found: true,
    prefs: { interview: !!Number(row.pref_interview), request: !!Number(row.pref_request) },
  };
}

/* 送る本体。
   ・本筋の処理（申請の保存など）はもう終わっているので、失敗しても投げない
   ・相手が通知を消した／機種変した端末は 404 と 410 が返る。その行は消す */
async function sendToUsers(client, userIds, kind, payload) {
  if (!PUSH_ENABLED) return { sent: 0, removed: 0 };
  if (!KINDS.includes(kind)) return { sent: 0, removed: 0 };
  const ids = [...new Set((userIds || []).filter(Boolean).map(String))];
  if (!ids.length) return { sent: 0, removed: 0 };

  const holes = ids.map(() => '?').join(',');
  const rs = await client.execute({
    sql: `SELECT endpoint, p256dh, auth FROM push_subscriptions
           WHERE user_id IN (${holes}) AND ${PREF_COL[kind]} = 1`,
    args: ids,
  });
  if (!rs.rows.length) return { sent: 0, removed: 0 };

  const data = JSON.stringify({
    title: String(payload.title || 'OPS日調アプリ'),
    body: String(payload.body || ''),
    url: String(payload.url || '/'),
    tag: String(payload.tag || kind),
  });

  let sent = 0;
  const dead = [];
  await Promise.all(rs.rows.map(async (row) => {
    const sub = { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } };
    try {
      await webpush.sendNotification(sub, data);
      sent += 1;
    } catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) dead.push(row.endpoint);
      else console.warn('通知の送信に失敗しました', e && e.statusCode, e && e.body);
    }
  }));

  for (const endpoint of dead) {
    try {
      await client.execute({ sql: 'DELETE FROM push_subscriptions WHERE endpoint = ?', args: [endpoint] });
    } catch (e) { console.warn('無効な購読の削除に失敗しました', e); }
  }
  return { sent, removed: dead.length };
}

module.exports = {
  PUSH_ENABLED,
  PUBLIC_KEY,
  KINDS,
  initPushTable,
  saveSubscription,
  removeSubscription,
  getSubscriptionState,
  sendToUsers,
};
