/* メール送信ヘルパー（Gmail経由）

   SMTP_USER（送信元のGmailアドレス）と SMTP_PASS（Googleの「アプリパスワード」16文字）が
   両方そろっているときだけ有効になる。未設定のままでも他の機能は普通に動き、
   パスワード再設定の申請だけが「メール未設定です」と返るようにしている。

   ※SMTP_PASS はGoogleアカウントのログインパスワードではなくアプリパスワード。
     https://myaccount.google.com/apppasswords で発行する（2段階認証が必要）。
*/
const nodemailer = require('nodemailer');

const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM_NAME = process.env.MAIL_FROM_NAME || 'OPS日調アプリ';
const MAIL_ENABLED = !!(SMTP_USER && SMTP_PASS);

let transporter = null;
function getTransporter() {
  if (!MAIL_ENABLED) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      /* smtp.gmail.com はIPv6アドレスも返すが、Renderの無料プランは
         外向きのIPv6が使えず ENETUNREACH で失敗する。
         IPv4に固定しないとメールが1通も送れない（2026-07-29に判明） */
      family: 4,
      /* 接続できないときに延々と待たせない。既定では数分固まることがある */
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, html }) {
  const t = getTransporter();
  if (!t) throw new Error('メール送信が未設定です（SMTP_USER / SMTP_PASS）');
  return t.sendMail({
    from: `"${MAIL_FROM_NAME}" <${SMTP_USER}>`,
    to, subject, text, html,
  });
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
