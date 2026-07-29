/* メール送信ヘルパー（Gmail経由）

   SMTP_USER（送信元のGmailアドレス）と SMTP_PASS（Googleの「アプリパスワード」16文字）が
   両方そろっているときだけ有効になる。未設定のままでも他の機能は普通に動き、
   パスワード再設定の申請だけが「メール未設定です」と返るようにしている。

   ※SMTP_PASS はGoogleアカウントのログインパスワードではなくアプリパスワード。
     https://myaccount.google.com/apppasswords で発行する（2段階認証が必要）。
*/
const nodemailer = require('nodemailer');
const dns = require('node:dns').promises;

const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'OPS日調アプリ';
const MAIL_ENABLED = !!(SMTP_USER && SMTP_PASS);

/* 【重要】Renderの無料プランは2025年9月から、SMTPポート（25 / 465 / 587）への
   外向き通信を全面的に遮断している。有料インスタンスなら465/587は使えるが、
   このアプリは「料金が発生する方法は禁止」が前提のため選べない。
   → Gmailの smtp.gmail.com:465 は、無料プランでは接続タイムアウトになり永久に送れない。
     https://render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports

   回避策は、遮断されていないポート2525を提供しているメール配信サービスを使うこと。
   Brevo（無料300通/日・カード登録不要）なら次の設定で動く：
     SMTP_HOST=smtp-relay.brevo.com
     SMTP_PORT=2525
     SMTP_USER / SMTP_PASS はBrevoが発行するSMTPキー
   送信元の表示アドレスは MAIL_FROM で別に指定できる（Brevoで認証済みのアドレス）。 */
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.gmail.com';
const SMTP_PORT = Number(process.env.SMTP_PORT || 465);
/* 465は接続時点からTLS、587と2525はSTARTTLSで途中から暗号化する */
const SMTP_SECURE = SMTP_PORT === 465;
/* 差出人として表示するアドレス。未指定ならログイン用のユーザー名をそのまま使う */
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;

/* 【なぜIPアドレスで接続しているか】
   nodemailer は smtp.gmail.com のIPv4とIPv6の候補を集めたうえで、
   そこから「ランダムに1つ」選んで接続する
   （node_modules/nodemailer/lib/shared/index.js の formatDNSValue）。
   ところがRenderの無料プランは外向きのIPv6が使えないため、
   IPv6を引いた回だけ ENETUNREACH で失敗する。
   つまり「送れたり送れなかったりする」状態になる（2026-07-29に判明）。

   createTransport の family:4 はこの選択には効かない。
   そこで自分でIPv4に解決し、ホストにはIPアドレスを渡している。
   nodemailer はIPリテラルを渡すとDNSを引き直さない（net.isIP による分岐）。
   証明書の検証に使うホスト名は tls.servername で別途渡す必要がある */
let transporter = null;

async function buildTransporter() {
  let host = SMTP_HOST;
  try {
    /* resolve4 ではなく lookup を使う。resolve4 はDNSサーバーに直接問い合わせるため
       環境によっては ECONNREFUSED で失敗する（開発機で実際に失敗した）。
       lookup はOSの名前解決を通すのでどの環境でも引ける */
    const { address } = await dns.lookup(SMTP_HOST, { family: 4 });
    if (address) host = address;
  } catch (e) {
    // 解決できなければホスト名のまま繋ぐ（IPv4が選ばれれば成功する）
    console.warn('smtp.gmail.com のIPv4解決に失敗しました:', e.message);
  }
  return nodemailer.createTransport({
    host,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    tls: { servername: SMTP_HOST },
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    /* 接続できないときに延々と待たせない。既定では数分固まることがある */
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
}

async function getTransporter() {
  if (!MAIL_ENABLED) return null;
  if (!transporter) transporter = await buildTransporter();
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const t = await getTransporter();
  if (!t) throw new Error('メール送信が未設定です（SMTP_USER / SMTP_PASS）');
  const msg = { from: `"${MAIL_FROM_NAME}" <${MAIL_FROM}>`, to, subject, text, html };
  try {
    return await t.sendMail(msg);
  } catch (e) {
    // GoogleのIPは入れ替わる。接続まわりの失敗のときだけ、
    // 引き直したIPで一度だけやり直す（認証エラー等はそのまま投げる）
    const code = String(e.code || e.message || '');
    if (!/ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ESOCKET/.test(code)) throw e;
    console.warn('SMTP接続に失敗したため、IPを引き直して再試行します:', code);
    transporter = await buildTransporter();
    return transporter.sendMail(msg);
  }
}

/* パスワード再設定の案内メール。
   受信環境を選ばないよう、本文にもURLをそのまま載せている */
async function sendPasswordResetMail({ to, nickname, url, minutes }) {
  const subject = '【OPS日調アプリ】パスワード再設定のご案内';
  const text = [
    `${nickname} さん`,
    '',
    'パスワードの再設定を受け付けました。',
    `下のURLを開いて、新しいパスワードを設定してください（${minutes}分以内）。`,
    '',
    url,
    '',
    'このURLは一度使うと無効になります。',
    'お心当たりがない場合は、このメールを削除してください。パスワードは変更されません。',
    '',
    '---',
    'OPS日調アプリ（ドットジェイピー）',
  ].join('\n');

  const html = `
  <div style="font-family:-apple-system,'Segoe UI',sans-serif;line-height:1.7;color:#1f2937">
    <p>${escapeHtml(nickname)} さん</p>
    <p>パスワードの再設定を受け付けました。<br>
       下のボタンから、新しいパスワードを設定してください（<strong>${minutes}分以内</strong>）。</p>
    <p style="margin:24px 0">
      <a href="${escapeHtml(url)}"
         style="display:inline-block;background:#14976b;color:#fff;text-decoration:none;
                padding:12px 24px;border-radius:10px;font-weight:700">パスワードを再設定する</a>
    </p>
    <p style="font-size:13px;color:#6b7280">ボタンが開かない場合は、次のURLをコピーしてブラウザに貼り付けてください。<br>
      <span style="word-break:break-all">${escapeHtml(url)}</span></p>
    <p style="font-size:13px;color:#6b7280">このURLは一度使うと無効になります。<br>
      お心当たりがない場合は、このメールを削除してください。パスワードは変更されません。</p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
    <p style="font-size:12px;color:#9ca3af">OPS日調アプリ（ドットジェイピー）</p>
  </div>`;

  return sendMail({ to, subject, text, html });
}

/* 面談の確定・不成立をインターン生に知らせるメール。
   本文はスタッフが画面で編集したものをそのまま送るため、改行だけHTMLに直して流し込む。
   件名には、他のメールに埋もれないよう共通の接頭辞を付ける */
async function sendInterviewMail({ to, nickname, subject, body }) {
  const text = [`${nickname} さん`, '', body, '', '---', 'OPS日調アプリ（ドットジェイピー）'].join('\n');
  const html = `
  <div style="font-family:-apple-system,'Segoe UI',sans-serif;line-height:1.7;color:#1f2937">
    <p>${escapeHtml(nickname)} さん</p>
    <div style="white-space:pre-wrap">${escapeHtml(body)}</div>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:20px 0">
    <p style="font-size:12px;color:#9ca3af">OPS日調アプリ（ドットジェイピー）<br>
      このメールは送信専用です。ご返信いただいてもお答えできません。</p>
  </div>`;
  return sendMail({ to, subject: `【OPS日調アプリ】${subject}`, text, html });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { MAIL_ENABLED, sendMail, sendPasswordResetMail, sendInterviewMail };
