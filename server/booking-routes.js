/* =========================================================
   予約スケジュール（Googleカレンダーの「予約スケジュール」と同じ動き）

   スタッフが予約スケジュールを何本でも作り、1本ごとに公開URL（/b/<合言葉>）が付く。
   インターン生はURLを開き、空いている枠を1つ選んで名前とメールアドレスを入れると、
   その場で予約が確定する。予約はスタッフのGoogleカレンダーに予定として入り、
   予約者はゲストとして招待される（確認・変更・取消のメールはGoogleが送る）。

   - 枠の計算は booking.js（純粋関数）。ここは材料集めと保存だけ
   - Googleの予定は freeBusy で「埋まっている時間」だけを聞く。中身は見ない
   - 予約は interviews に「確定済み（source:'booking'）」として入れる。
     面談一覧・全体予定表・申請ページの空き枠に、そのまま反映させるため
   - 面談申請（apply.html）とは別の入口。どちらも残す（2026-10-05 ユーザー判断）

   設計：_specs/2026-10-05-予約スケジュール-design.md
   ========================================================= */
'use strict';
const crypto = require('node:crypto');
const booking = require('./booking');

const STAFF_ROLES = ['staff', 'branch_admin', 'admin'];
const MAX_PAGES_PER_STAFF = 30;
const BUSY_CACHE_MS = 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

const isPageToken = (t) => typeof t === 'string' && /^[a-f0-9]{32}$/.test(t);
const isManageToken = (t) => typeof t === 'string' && /^[a-f0-9]{48}$/.test(t);
const isEmail = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

function pad(n) { return String(n).padStart(2, '0'); }
/* '10月5日(月) 10:00〜10:30'。サーバーの時計は日本時間 */
function fmtRange(startMs, endMs) {
  const s = new Date(startMs);
  const e = new Date(endMs);
  return `${s.getMonth() + 1}月${s.getDate()}日(${WEEKDAYS[s.getDay()]}) ${pad(s.getHours())}:${pad(s.getMinutes())}〜${pad(e.getHours())}:${pad(e.getMinutes())}`;
}

module.exports = function registerBookingRoutes(d) {
  const {
    app, client, requireAuth, google, GOOGLE_ENABLED,
    getTokenRow, accessTokenFor, saveInterview, getInterview, rowToInterview,
    insertNotification, push, mail, limitPublicRead, limitPublicWrite, removeExternalGoogleBlock,
  } = d;

  async function init() {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS booking_pages (
        id TEXT PRIMARY KEY,
        staff_id TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        active INTEGER NOT NULL DEFAULT 1,
        data TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    await client.execute('CREATE INDEX IF NOT EXISTS idx_booking_pages_staff ON booking_pages(staff_id)');
  }

  /* ---------- 読み出し ---------- */
  function rowToPage(r) {
    let config = {};
    try { config = JSON.parse(r.data) || {}; } catch { /* 壊れていても行は返す */ }
    // 古い形で保存されていても使えるよう、読むたびに整え直す
    const norm = booking.normalizeConfig(config);
    return {
      id: r.id, staff_id: r.staff_id, token: r.token, active: Number(r.active) === 1,
      config: norm.config || { ...booking.defaultConfig(), title: config.title || '(無題)' },
      created_at: r.created_at, updated_at: r.updated_at,
    };
  }
  async function pageByToken(token) {
    if (!isPageToken(token)) return null;
    const rs = await client.execute({ sql: 'SELECT * FROM booking_pages WHERE token = ?', args: [token] });
    return rs.rows[0] ? rowToPage(rs.rows[0]) : null;
  }
  async function pageById(id) {
    const rs = await client.execute({ sql: 'SELECT * FROM booking_pages WHERE id = ?', args: [String(id || '')] });
    return rs.rows[0] ? rowToPage(rs.rows[0]) : null;
  }
  async function activeStaff(id) {
    const rs = await client.execute({
      sql: `SELECT id, nickname, branch_id, avatar_url FROM users
            WHERE id = ? AND status = 'active' AND role IN ('staff','branch_admin','admin')`,
      args: [String(id || '')],
    });
    return rs.rows[0] || null;
  }
  async function fixedInterviewsOf(staffId) {
    const rs = await client.execute({
      sql: "SELECT * FROM interviews WHERE staff_id = ? AND status = 'fixed'",
      args: [staffId],
    });
    return rs.rows.map(rowToInterview);
  }
  /* 面談の [開始, 終了]。予約から入ったものは予約の長さ、ほかは30分 */
  function ivInterval(iv) {
    const s = new Date(iv.confirmed_datetime).getTime();
    return [s, s + (Number(iv.duration_min) || 30) * 60 * 1000];
  }
  function baseUrl(req) {
    return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  }

  /* ---------- スタッフごとの順番待ち ----------
     「空いているか確かめる → Googleに予定を作る → 保存する」の間に、
     同じスタッフへの別の予約が割り込むと、同じ枠に2件入ってしまう。
     スタッフごとに1本の列に並べて、1件ずつ通す。
     store 全体の列（withDBLock）を使わないのは、Googleとの通信を待つ間
     ほかの保存まで止めてしまうため */
  const staffChains = new Map();
  function withStaffLock(staffId, fn) {
    const prev = staffChains.get(staffId) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => undefined, () => undefined);
    staffChains.set(staffId, tail);
    tail.then(() => { if (staffChains.get(staffId) === tail) staffChains.delete(staffId); });
    return run;
  }

  /* ---------- Googleの「埋まっている時間」 ----------
     公開ページは誰でも開けるので、開くたびにGoogleへ聞くと上限に届きかねない。
     同じ問い合わせは60秒だけ使い回す。予約を確定する直前だけは必ず取り直す */
  const busyCache = new Map();
  async function googleBusy(staffId, calendars, fromMs, toMs, fresh) {
    const key = `${staffId}|${calendars.join(',')}|${fromMs}|${toMs}`;
    const hit = busyCache.get(key);
    if (!fresh && hit && Date.now() - hit.at < BUSY_CACHE_MS) return hit.busy;
    const tokenRow = await getTokenRow(staffId);
    if (!tokenRow) throw Object.assign(new Error('Google未連携'), { closed: true });
    const accessToken = await accessTokenFor(tokenRow);
    const busy = await google.freeBusy(accessToken, calendars,
      new Date(fromMs).toISOString(), new Date(toMs).toISOString());
    if (busyCache.size > 500) busyCache.clear();
    busyCache.set(key, { at: Date.now(), busy });
    return busy;
  }
  function forgetBusy(staffId) {
    for (const k of busyCache.keys()) if (k.startsWith(staffId + '|')) busyCache.delete(k);
  }

  /* 区間の並びから、ある区間を取り除く。
     日時を変えるとき、自分の今の予約（Googleにも予定として入っている）が
     「埋まっている時間」に混ざるので、それを抜くために使う */
  function subtract(list, [s, e]) {
    const out = [];
    list.forEach(([bs, be]) => {
      if (be <= s || bs >= e) { out.push([bs, be]); return; }
      if (bs < s) out.push([bs, s]);
      if (be > e) out.push([e, be]);
    });
    return out;
  }

  /* 枠の計算に要る材料をそろえる */
  async function slotInputs(page, fromMs, toMs, { fresh = false, exclude = null } = {}) {
    const ivs = (await fixedInterviewsOf(page.staff_id)).filter((iv) => !exclude || iv.id !== exclude.id);
    let gBusy = await googleBusy(page.staff_id, page.config.calendars, fromMs, toMs + 24 * 60 * 60 * 1000, fresh);
    if (exclude) gBusy = subtract(gBusy, ivInterval(exclude));
    return {
      now: Date.now(),
      busy: [...gBusy, ...ivs.map(ivInterval)],
      pageBookings: ivs.filter((iv) => iv.booking_page_id === page.id).map(ivInterval),
    };
  }

  /* 公開してよい状態か。止めてある・担当が抜けた・Google連携が無いときは受け付けない */
  async function openState(page) {
    if (!page) return { code: 404, error: 'このリンクは使えません。送ってくれた人に確認してください' };
    const staff = await activeStaff(page.staff_id);
    if (!staff) return { code: 404, error: 'このリンクは使えません。送ってくれた人に確認してください' };
    const closed = !page.active || !GOOGLE_ENABLED || !(await getTokenRow(page.staff_id));
    return { staff, closed };
  }

  function publicPageInfo(page, staff) {
    const c = page.config;
    const win = booking.bookingWindow(c, Date.now());
    return {
      title: c.title, duration: c.duration, color: c.color, description: c.description,
      location: c.location, phone: c.phone, questions: c.questions,
      verifyEmail: !!(c.verifyEmail && mail.MAIL_ENABLED),
      staff: { nickname: staff.nickname || '', avatar_url: staff.avatar_url || '' },
      window: { from: booking.ymdOf(new Date(win.from)), to: booking.ymdOf(new Date(win.to - 1)) },
    };
  }

  /* 'YYYY-MM-DD' と日数から、見る範囲を決める。1回に42日（月のカレンダー1枚）まで */
  function rangeOf(q) {
    const from = booking.isYmd(q.from) ? booking.parseYmd(q.from) : booking.parseYmd(booking.ymdOf(new Date()));
    const days = Math.min(42, Math.max(1, Math.floor(Number(q.days) || 7)));
    const to = new Date(from);
    to.setDate(from.getDate() + days);
    return { fromMs: from.getTime(), toMs: to.getTime() };
  }

  async function slotsResponse(page, q, exclude) {
    const { fromMs, toMs } = rangeOf(q);
    const inputs = await slotInputs(page, fromMs, toMs, { exclude });
    const starts = booking.computeSlots(page.config, { ...inputs, fromMs, toMs });
    return { days: booking.groupByDay(starts) };
  }

  /* ---------- 予約者の入力 ---------- */
  function readGuest(cfg, body) {
    const b = body || {};
    const last = String(b.last_name || '').trim();
    const first = String(b.first_name || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    const phone = String(b.phone || '').trim();
    if (!last || !first) return { error: '姓と名を入力してください' };
    if (last.length > 40 || first.length > 40) return { error: 'お名前が長すぎます' };
    if (!isEmail(email)) return { error: 'メールアドレスを正しく入力してください' };
    if (cfg.phone === 'required' && !phone) return { error: '電話番号を入力してください' };
    if (phone && (phone.length > 30 || !/^[0-9+\-() ]+$/.test(phone))) return { error: '電話番号を正しく入力してください' };
    const raw = b.answers && typeof b.answers === 'object' ? b.answers : {};
    const answers = [];
    for (const q of cfg.questions) {
      const v = String(raw[q.id] == null ? '' : raw[q.id]).trim().slice(0, 1000);
      if (q.required && !v) return { error: `「${q.label}」に回答してください` };
      if (v) answers.push({ id: q.id, label: q.label, value: v });
    }
    return {
      guest: { name: `${last} ${first}`, last, first, email, phone: cfg.phone === 'off' ? '' : phone, answers },
    };
  }

  /* ---------- メールアドレスの確認コード ----------
     「予約前にメールアドレスを確認する」を入れたスケジュールだけで使う。
     サーバーは1つだけ動かす前提（ratelimit.js と同じ）なので、手元に置いておけば足りる */
  const codes = new Map(); // `${pageId}|${email}` -> { code, exp, tries }
  function sweepCodes() {
    const now = Date.now();
    for (const [k, v] of codes) if (v.exp < now) codes.delete(k);
  }
  function needsCode(cfg) {
    return !!(cfg.verifyEmail && mail.MAIL_ENABLED);
  }
  function checkCode(page, email, code) {
    const key = `${page.id}|${email}`;
    const ent = codes.get(key);
    if (!ent || ent.exp < Date.now()) return '確認コードの有効期限が切れました。もう一度コードを送ってください';
    ent.tries++;
    if (ent.tries > 5) { codes.delete(key); return '確認コードを何度も間違えました。もう一度コードを送ってください'; }
    if (String(code || '').trim() !== ent.code) return '確認コードが正しくありません';
    return null;
  }

  /* ---------- Googleの予定 ---------- */
  function eventBody(page, iv, startMs) {
    const c = page.config;
    const endMs = startMs + c.duration * 60 * 1000;
    const lines = [
      `${c.title}`,
      '',
      `予約者：${iv.intern_name}（${iv.guest_email}）`,
      ...(iv.guest_phone ? [`電話番号：${iv.guest_phone}`] : []),
      ...(iv.answers || []).map((a) => `${a.label}：${a.value}`),
      '',
      '予約の変更・キャンセルはこちら：',
      iv.manage_url,
      '',
      'OPS日調アプリの予約スケジュールから予約されました。',
    ];
    const ev = {
      summary: `${c.title}（${iv.intern_name}）`,
      description: lines.join('\n'),
      start: { dateTime: new Date(startMs).toISOString(), timeZone: 'Asia/Tokyo' },
      end: { dateTime: new Date(endMs).toISOString(), timeZone: 'Asia/Tokyo' },
      attendees: [{ email: iv.guest_email, displayName: iv.intern_name }],
    };
    if ((c.location.type === 'place' || c.location.type === 'phone') && c.location.text) {
      ev.location = c.location.text;
    }
    return ev;
  }
  function meetUrlOf(ev) {
    if (!ev) return '';
    if (ev.hangoutLink) return ev.hangoutLink;
    const ep = ((ev.conferenceData && ev.conferenceData.entryPoints) || []).find((x) => x.entryPointType === 'video');
    return ep ? ep.uri : '';
  }

  /* 予約した時点でもう過ぎているリマインダーは「送った」ことにしておく。
     30分後の予約に「前日のリマインダー」を送っても意味が無いため */
  function passedReminders(reminders, startMs, nowMs) {
    return (reminders || []).filter((m) => startMs - m * 60 * 1000 <= nowMs);
  }

  /* 予約者に見せる形。担当のメールアドレスなどは含めない */
  function bookingView(iv, page, staff) {
    const [s, e] = ivInterval(iv);
    return {
      title: iv.booking_title || (page && page.config.title) || '',
      start: new Date(s).toISOString(), end: new Date(e).toISOString(),
      label: fmtRange(s, e),
      duration: Number(iv.duration_min) || 30,
      name: iv.intern_name, email: iv.guest_email,
      staff: staff ? staff.nickname : '',
      location: { type: iv.location_type || 'none', text: iv.location_text || '' },
      meet_url: iv.meet_url || '',
      manage_url: iv.manage_url,
      cancelled: iv.status !== 'fixed',
      past: s <= Date.now(),
    };
  }

  async function notifyStaff(iv, type, msg, title) {
    try {
      await insertNotification({ type, branch_id: iv.branch_id || null, msg });
    } catch (e) { console.warn('予約の通知を残せませんでした', e); }
    push.sendToUsers(client, [iv.staff_id], 'interview', {
      title, body: msg, url: '/', tag: 'interview',
    }).catch((e) => console.warn('予約のプッシュ通知に失敗しました', e));
  }

  /* 予約を取り消す。Googleの予定を消すと、Googleが予約者へ取消のメールを送る。
     Googleで消せなかったときは取り消さない（予約者の手元に予定が残ったまま
     「取り消した」と見せないため）。ただし連携そのものが外れていれば、こちらだけ取り消す */
  async function cancelBooking(iv, by) {
    if (iv.googleEventId && by !== 'google') {
      const tokenRow = await getTokenRow(iv.staff_id);
      if (tokenRow) {
        const accessToken = await accessTokenFor(tokenRow);
        await google.deleteEvent(accessToken, tokenRow.calendar_id, iv.googleEventId, { sendUpdates: 'all' });
      }
    }
    const next = {
      ...iv, status: 'failed', cancelled: true, cancelled_by: by,
      cancelled_at: new Date().toISOString(),
    };
    await saveInterview(next);
    forgetBusy(iv.staff_id);
    const who = { guest: `${iv.intern_name}さんが`, staff: '', google: 'Googleカレンダーで' }[by] || '';
    await notifyStaff(next, '予約キャンセル',
      `${who}予約「${iv.booking_title}」（${fmtRange(...ivInterval(iv))}）がキャンセルされました`,
      '予約がキャンセルされました');
    return next;
  }

  /* =========================================================
     スタッフ用（ログインが必要）
     ========================================================= */
  function requireStaff(req, res, next) {
    if (!STAFF_ROLES.includes(req.authUser.role)) return res.status(403).json({ error: '予約スケジュールを扱う権限がありません' });
    next();
  }
  function pageForStaff(page, req, upcoming) {
    return {
      id: page.id, active: page.active, config: page.config,
      url: `${baseUrl(req)}/b/${page.token}`,
      upcoming: upcoming || 0,
      created_at: page.created_at, updated_at: page.updated_at,
    };
  }

  app.get('/api/booking-pages', requireAuth, requireStaff, async (req, res) => {
    try {
      const me = req.authUser.id;
      const rs = await client.execute({ sql: 'SELECT * FROM booking_pages WHERE staff_id = ? ORDER BY created_at', args: [me] });
      const ivs = await fixedInterviewsOf(me);
      const now = Date.now();
      const pages = rs.rows.map(rowToPage).map((p) => pageForStaff(p, req,
        ivs.filter((iv) => iv.booking_page_id === p.id && ivInterval(iv)[0] > now).length));
      res.json({
        pages,
        googleConnected: GOOGLE_ENABLED && !!(await getTokenRow(me)),
        googleEnabled: GOOGLE_ENABLED,
        mailEnabled: mail.MAIL_ENABLED,
        defaults: booking.defaultConfig(),
        choices: {
          durations: booking.DURATIONS, reminders: booking.REMINDER_CHOICES,
          colors: booking.COLORS, maxDays: booking.MAX_DAYS_LIMIT,
        },
      });
    } catch (e) {
      console.error('予約スケジュールの一覧に失敗しました', e);
      res.status(500).json({ error: '読み込めませんでした' });
    }
  });

  /* 空きの確認に使えるカレンダーの一覧（自分のGoogleアカウントのもの） */
  app.get('/api/booking-pages/calendars', requireAuth, requireStaff, async (req, res) => {
    try {
      const tokenRow = GOOGLE_ENABLED ? await getTokenRow(req.authUser.id) : null;
      if (!tokenRow) return res.json({ calendars: [] });
      const accessToken = await accessTokenFor(tokenRow);
      res.json({ calendars: await google.listCalendars(accessToken) });
    } catch (e) {
      console.error('カレンダー一覧の取得に失敗しました', e);
      res.status(502).json({ error: 'Googleカレンダーの一覧を読めませんでした' });
    }
  });

  app.post('/api/booking-pages', requireAuth, requireStaff, async (req, res) => {
    try {
      const me = req.authUser.id;
      if (!GOOGLE_ENABLED || !(await getTokenRow(me))) {
        return res.status(400).json({ error: '先にGoogleカレンダーを連携してください' });
      }
      const norm = booking.normalizeConfig(req.body && req.body.config);
      if (norm.error) return res.status(400).json({ error: norm.error });
      const cnt = await client.execute({ sql: 'SELECT COUNT(*) AS c FROM booking_pages WHERE staff_id = ?', args: [me] });
      if (Number(cnt.rows[0].c) >= MAX_PAGES_PER_STAFF) {
        return res.status(400).json({ error: `予約スケジュールは${MAX_PAGES_PER_STAFF}本までです` });
      }
      const now = new Date().toISOString();
      const row = {
        id: 'bp_' + crypto.randomBytes(6).toString('hex'),
        staff_id: me, token: crypto.randomBytes(16).toString('hex'), active: 1,
        data: JSON.stringify(norm.config), created_at: now, updated_at: now,
      };
      await client.execute({
        sql: 'INSERT INTO booking_pages (id, staff_id, token, active, data, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
        args: [row.id, row.staff_id, row.token, row.active, row.data, row.created_at, row.updated_at],
      });
      res.json({ page: pageForStaff(rowToPage(row), req, 0) });
    } catch (e) {
      console.error('予約スケジュールの作成に失敗しました', e);
      res.status(500).json({ error: '作成できませんでした' });
    }
  });

  app.put('/api/booking-pages/:id', requireAuth, requireStaff, async (req, res) => {
    try {
      const page = await pageById(req.params.id);
      if (!page || page.staff_id !== req.authUser.id) return res.status(404).json({ error: '予約スケジュールが見つかりません' });
      const body = req.body || {};
      let config = page.config;
      if (body.config !== undefined) {
        const norm = booking.normalizeConfig(body.config);
        if (norm.error) return res.status(400).json({ error: norm.error });
        config = norm.config;
      }
      const active = body.active === undefined ? page.active : !!body.active;
      const now = new Date().toISOString();
      await client.execute({
        sql: 'UPDATE booking_pages SET data = ?, active = ?, updated_at = ? WHERE id = ?',
        args: [JSON.stringify(config), active ? 1 : 0, now, page.id],
      });
      forgetBusy(page.staff_id);
      const ivs = await fixedInterviewsOf(page.staff_id);
      res.json({
        page: pageForStaff({ ...page, config, active, updated_at: now }, req,
          ivs.filter((iv) => iv.booking_page_id === page.id && ivInterval(iv)[0] > Date.now()).length),
      });
    } catch (e) {
      console.error('予約スケジュールの更新に失敗しました', e);
      res.status(500).json({ error: '保存できませんでした' });
    }
  });

  /* スケジュールを消しても、すでに入った予約（面談）は残す */
  app.delete('/api/booking-pages/:id', requireAuth, requireStaff, async (req, res) => {
    try {
      const page = await pageById(req.params.id);
      if (!page || page.staff_id !== req.authUser.id) return res.status(404).json({ error: '予約スケジュールが見つかりません' });
      await client.execute({ sql: 'DELETE FROM booking_pages WHERE id = ?', args: [page.id] });
      res.json({ ok: true });
    } catch (e) {
      console.error('予約スケジュールの削除に失敗しました', e);
      res.status(500).json({ error: '削除できませんでした' });
    }
  });

  /* 面談一覧から、予約をキャンセルする（担当スタッフか管理者） */
  app.post('/api/interviews/:id/cancel-booking', requireAuth, requireStaff, async (req, res) => {
    try {
      const iv = await getInterview(req.params.id);
      if (!iv || iv.source !== 'booking') return res.status(404).json({ error: '予約が見つかりません' });
      if (req.authUser.role !== 'admin' && iv.staff_id !== req.authUser.id) {
        return res.status(403).json({ error: '自分が担当する予約だけキャンセルできます' });
      }
      if (iv.status !== 'fixed') return res.status(409).json({ error: 'この予約はすでにキャンセルされています' });
      const next = await withStaffLock(iv.staff_id, () => cancelBooking(iv, 'staff'));
      res.json({ ok: true, interview: next });
    } catch (e) {
      console.error('予約のキャンセルに失敗しました', e);
      res.status(502).json({ error: 'キャンセルできませんでした。時間をおいてやり直してください' });
    }
  });

  /* =========================================================
     公開（ログイン不要・回数制限あり）
     ========================================================= */
  const CLOSED_MSG = '現在、予約を受け付けていません';
  const GOOGLE_FAIL_MSG = '空き状況を確認できませんでした。時間をおいて開き直してください';

  app.get('/api/book/:token', limitPublicRead, async (req, res) => {
    try {
      const page = await pageByToken(req.params.token);
      const st = await openState(page);
      if (st.error) return res.status(st.code).json({ error: st.error });
      res.json({ ...publicPageInfo(page, st.staff), closed: st.closed });
    } catch (e) {
      console.error('予約ページの読み込みに失敗しました', e);
      res.status(500).json({ error: '読み込めませんでした' });
    }
  });

  app.get('/api/book/:token/slots', limitPublicRead, async (req, res) => {
    try {
      const page = await pageByToken(req.params.token);
      const st = await openState(page);
      if (st.error) return res.status(st.code).json({ error: st.error });
      if (st.closed) return res.status(409).json({ error: CLOSED_MSG });
      res.json(await slotsResponse(page, req.query));
    } catch (e) {
      console.error('予約の空き枠の取得に失敗しました', e.message || e);
      res.status(503).json({ error: GOOGLE_FAIL_MSG });
    }
  });

  app.post('/api/book/:token/verify', limitPublicWrite, async (req, res) => {
    try {
      const page = await pageByToken(req.params.token);
      const st = await openState(page);
      if (st.error) return res.status(st.code).json({ error: st.error });
      if (st.closed) return res.status(409).json({ error: CLOSED_MSG });
      if (!needsCode(page.config)) return res.status(400).json({ error: 'このページでは確認コードを使いません' });
      const email = String((req.body || {}).email || '').trim().toLowerCase();
      if (!isEmail(email)) return res.status(400).json({ error: 'メールアドレスを正しく入力してください' });
      sweepCodes();
      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      codes.set(`${page.id}|${email}`, { code, exp: Date.now() + CODE_TTL_MS, tries: 0 });
      await mail.sendMail({
        to: email,
        subject: `【確認コード】${page.config.title}`,
        text: `予約の確認コードは ${code} です。\n10分以内に予約画面へ入力してください。\n\nこのメールに心当たりがない場合は、破棄してください。`,
      });
      res.json({ ok: true });
    } catch (e) {
      console.error('確認コードの送信に失敗しました', e);
      res.status(502).json({ error: '確認コードを送れませんでした。時間をおいてやり直してください' });
    }
  });

  app.post('/api/book/:token', limitPublicWrite, async (req, res) => {
    try {
      const page = await pageByToken(req.params.token);
      const st = await openState(page);
      if (st.error) return res.status(st.code).json({ error: st.error });
      if (st.closed) return res.status(409).json({ error: CLOSED_MSG });
      const cfg = page.config;
      const g = readGuest(cfg, req.body);
      if (g.error) return res.status(400).json({ error: g.error });
      const startMs = new Date(String((req.body || {}).start || '')).getTime();
      if (!Number.isFinite(startMs)) return res.status(400).json({ error: '日時を選んでください' });
      if (needsCode(cfg)) {
        const bad = checkCode(page, g.guest.email, (req.body || {}).code);
        if (bad) return res.status(400).json({ error: bad, code_error: true });
      }

      const result = await withStaffLock(page.staff_id, async () => {
        const day = booking.parseYmd(booking.ymdOf(new Date(startMs))).getTime();
        let inputs;
        try {
          inputs = await slotInputs(page, day, day + 24 * 60 * 60 * 1000, { fresh: true });
        } catch (e) {
          console.error('予約時の空き確認に失敗しました', e.message || e);
          return { code: 503, error: GOOGLE_FAIL_MSG };
        }
        if (!booking.isBookable(cfg, inputs, startMs)) {
          return { code: 409, error: 'この時間は予約できなくなりました。別の時間を選んでください', taken: true };
        }
        const manageToken = crypto.randomBytes(24).toString('hex');
        const iv = {
          id: 'iv_' + crypto.randomBytes(6).toString('hex'),
          intern_id: '',
          intern_name: g.guest.name,
          staff_id: page.staff_id,
          branch_id: st.staff.branch_id || null,
          status: 'fixed',
          confirmed_datetime: new Date(startMs).toISOString(),
          choices: [new Date(startMs).toISOString()],
          note: '',
          source: 'booking',
          booking_page_id: page.id,
          booking_title: cfg.title,
          duration_min: cfg.duration,
          guest_email: g.guest.email,
          guest_phone: g.guest.phone,
          answers: g.guest.answers,
          manage_token: manageToken,
          manage_url: `${baseUrl(req)}/b/manage/${manageToken}`,
          location_type: cfg.location.type,
          location_text: cfg.location.text,
          reminders: cfg.reminders,
          reminders_sent: passedReminders(cfg.reminders, startMs, Date.now()),
          created_at: new Date().toISOString(),
        };
        const tokenRow = await getTokenRow(page.staff_id);
        const accessToken = await accessTokenFor(tokenRow);
        const ev = eventBody(page, iv, startMs);
        const meet = cfg.location.type === 'meet';
        if (meet) {
          ev.conferenceData = {
            createRequest: { requestId: iv.id, conferenceSolutionKey: { type: 'hangoutsMeet' } },
          };
        }
        const created = await google.createEvent(accessToken, tokenRow.calendar_id, ev,
          { sendUpdates: 'all', conferenceDataVersion: meet ? 1 : 0 });
        iv.googleEventId = created.id;
        iv.meet_url = meetUrlOf(created);
        try {
          await saveInterview(iv);
        } catch (e) {
          // 保存できなかった予約の予定を残さない（予約者に招待だけ届いてしまうため）
          await google.deleteEvent(accessToken, tokenRow.calendar_id, created.id, { sendUpdates: 'all' }).catch(() => {});
          throw e;
        }
        forgetBusy(page.staff_id);
        /* 予定を作ってから保存するまでの間にGoogleの変更通知が先に届くと、
           この予定が「外部の予定」として申請側の不可時間に取り込まれてしまう。
           保存し終えたここで、念のため掃除しておく */
        await removeExternalGoogleBlock(page.staff_id, created.id);
        return { iv };
      });
      if (result.error) return res.status(result.code).json({ error: result.error, taken: !!result.taken });

      codes.delete(`${page.id}|${g.guest.email}`);
      const iv = result.iv;
      await notifyStaff(iv, '面談予約',
        `${iv.intern_name}さんが「${cfg.title}」を予約しました（${fmtRange(...ivInterval(iv))}）`,
        '面談の予約が入りました');
      res.json({ ok: true, booking: bookingView(iv, page, st.staff) });
    } catch (e) {
      console.error('予約に失敗しました', e);
      res.status(500).json({ error: '予約できませんでした。時間をおいてやり直してください' });
    }
  });

  /* ---------- 予約の確認・変更・キャンセル（予約者用） ---------- */
  async function bookingByManageToken(token) {
    if (!isManageToken(token)) return null;
    const rs = await client.execute({
      sql: 'SELECT * FROM interviews WHERE data LIKE ?',
      args: [`%"manage_token":"${token}"%`],
    });
    const iv = rs.rows.map(rowToInterview).find((x) => x.manage_token === token && x.source === 'booking');
    return iv || null;
  }
  const NOT_FOUND = { error: 'この予約は見つかりません。届いたメールのリンクを確認してください' };

  async function manageContext(token) {
    const iv = await bookingByManageToken(token);
    if (!iv) return null;
    const page = await pageById(iv.booking_page_id);
    const staff = await activeStaff(iv.staff_id);
    const changeable = iv.status === 'fixed' && ivInterval(iv)[0] > Date.now();
    // 日時の変更は、スケジュールがまだ受け付けている間だけ。キャンセルはいつでも（開始まで）
    const reschedulable = changeable && !!page && page.active && !!staff && GOOGLE_ENABLED
      && !!(await getTokenRow(iv.staff_id));
    return { iv, page, staff, changeable, reschedulable };
  }

  app.get('/api/book/manage/:token', limitPublicRead, async (req, res) => {
    try {
      const ctx = await manageContext(req.params.token);
      if (!ctx) return res.status(404).json(NOT_FOUND);
      res.json({
        booking: bookingView(ctx.iv, ctx.page, ctx.staff),
        page: ctx.page && ctx.staff ? publicPageInfo(ctx.page, ctx.staff) : null,
        changeable: ctx.changeable,
        reschedulable: ctx.reschedulable,
      });
    } catch (e) {
      console.error('予約の読み込みに失敗しました', e);
      res.status(500).json({ error: '読み込めませんでした' });
    }
  });

  app.get('/api/book/manage/:token/slots', limitPublicRead, async (req, res) => {
    try {
      const ctx = await manageContext(req.params.token);
      if (!ctx) return res.status(404).json(NOT_FOUND);
      if (!ctx.reschedulable) return res.status(409).json({ error: 'この予約は日時を変更できません' });
      res.json(await slotsResponse(ctx.page, req.query, ctx.iv));
    } catch (e) {
      console.error('変更用の空き枠の取得に失敗しました', e.message || e);
      res.status(503).json({ error: GOOGLE_FAIL_MSG });
    }
  });

  app.patch('/api/book/manage/:token', limitPublicWrite, async (req, res) => {
    try {
      const first = await manageContext(req.params.token);
      if (!first) return res.status(404).json(NOT_FOUND);
      const startMs = new Date(String((req.body || {}).start || '')).getTime();
      if (!Number.isFinite(startMs)) return res.status(400).json({ error: '日時を選んでください' });

      const result = await withStaffLock(first.iv.staff_id, async () => {
        // 列に並んでいる間に取り消されているかもしれないので、読み直してから判断する
        const ctx = await manageContext(req.params.token);
        if (!ctx || !ctx.reschedulable) return { code: 409, error: 'この予約は日時を変更できません' };
        const { iv, page } = ctx;
        const day = booking.parseYmd(booking.ymdOf(new Date(startMs))).getTime();
        let inputs;
        try {
          inputs = await slotInputs(page, day, day + 24 * 60 * 60 * 1000, { fresh: true, exclude: iv });
        } catch (e) {
          return { code: 503, error: GOOGLE_FAIL_MSG };
        }
        if (!booking.isBookable(page.config, inputs, startMs)) {
          return { code: 409, error: 'この時間は予約できなくなりました。別の時間を選んでください', taken: true };
        }
        const durMs = page.config.duration * 60 * 1000;
        const tokenRow = await getTokenRow(iv.staff_id);
        const accessToken = await accessTokenFor(tokenRow);
        if (iv.googleEventId) {
          await google.updateEvent(accessToken, tokenRow.calendar_id, iv.googleEventId, {
            start: { dateTime: new Date(startMs).toISOString(), timeZone: 'Asia/Tokyo' },
            end: { dateTime: new Date(startMs + durMs).toISOString(), timeZone: 'Asia/Tokyo' },
          }, { sendUpdates: 'all' });
        }
        const before = ivInterval(iv);
        const next = {
          ...iv,
          confirmed_datetime: new Date(startMs).toISOString(),
          choices: [new Date(startMs).toISOString()],
          duration_min: page.config.duration,
          reminders_sent: passedReminders(iv.reminders, startMs, Date.now()),
          rescheduled_at: new Date().toISOString(),
        };
        await saveInterview(next);
        forgetBusy(iv.staff_id);
        if (iv.googleEventId) await removeExternalGoogleBlock(iv.staff_id, iv.googleEventId);
        return { iv: next, page, staff: ctx.staff, before };
      });
      if (result.error) return res.status(result.code).json({ error: result.error, taken: !!result.taken });
      const { iv, page, staff, before } = result;
      await notifyStaff(iv, '予約変更',
        `${iv.intern_name}さんが予約「${iv.booking_title}」の日時を変更しました（${fmtRange(...before)} → ${fmtRange(...ivInterval(iv))}）`,
        '予約の日時が変更されました');
      res.json({ ok: true, booking: bookingView(iv, page, staff) });
    } catch (e) {
      console.error('予約の変更に失敗しました', e);
      res.status(500).json({ error: '変更できませんでした。時間をおいてやり直してください' });
    }
  });

  app.delete('/api/book/manage/:token', limitPublicWrite, async (req, res) => {
    try {
      const first = await manageContext(req.params.token);
      if (!first) return res.status(404).json(NOT_FOUND);
      const result = await withStaffLock(first.iv.staff_id, async () => {
        const ctx = await manageContext(req.params.token);
        if (!ctx || !ctx.changeable) return { code: 409, error: 'この予約はキャンセルできません' };
        return { iv: await cancelBooking(ctx.iv, 'guest'), page: ctx.page, staff: ctx.staff };
      });
      if (result.error) return res.status(result.code).json({ error: result.error });
      res.json({ ok: true, booking: bookingView(result.iv, result.page, result.staff) });
    } catch (e) {
      console.error('予約のキャンセルに失敗しました', e);
      res.status(502).json({ error: 'キャンセルできませんでした。時間をおいてやり直してください' });
    }
  });

  /* =========================================================
     裏の処理
     ========================================================= */

  /* Googleカレンダーの変更通知（webhook）から呼ぶ。
     スタッフがGoogleカレンダー上で予約の予定を消したら、予約もキャンセルにする
     （Googleの予約スケジュールと同じ動き。予約者への取消メールはGoogleが送っている） */
  async function handleGoogleChanges(staffId, items) {
    const gone = new Set((items || []).filter((ev) => ev && ev.status === 'cancelled').map((ev) => ev.id));
    if (!gone.size) return;
    const ivs = (await fixedInterviewsOf(staffId))
      .filter((iv) => iv.source === 'booking' && iv.googleEventId && gone.has(iv.googleEventId));
    for (const iv of ivs) {
      try {
        await withStaffLock(staffId, async () => {
          const cur = await getInterview(iv.id);
          if (cur && cur.status === 'fixed') await cancelBooking(cur, 'google');
        });
      } catch (e) {
        console.warn(`Googleで消された予約の取り消しに失敗しました（${iv.id}）`, e.message || e);
      }
    }
  }

  /* リマインダーメール。5分おきに呼ぶ（keepalive がサーバーを起こしている） */
  async function sendDueReminders() {
    if (!mail.MAIL_ENABLED) return;
    try {
      const rs = await client.execute({
        sql: "SELECT * FROM interviews WHERE status = 'fixed' AND data LIKE ?",
        args: ['%"source":"booking"%'],
      });
      const now = Date.now();
      for (const iv of rs.rows.map(rowToInterview)) {
        if (iv.source !== 'booking' || !iv.guest_email) continue;
        const [s, e] = ivInterval(iv);
        if (s <= now) continue;
        const sent = new Set(iv.reminders_sent || []);
        const due = (iv.reminders || []).filter((m) => !sent.has(m) && s - m * 60 * 1000 <= now);
        if (!due.length) continue;
        const staff = await activeStaff(iv.staff_id);
        const place = iv.location_type === 'meet'
          ? (iv.meet_url ? `Google Meet：${iv.meet_url}` : 'Google Meet（リンクはカレンダーの招待をご覧ください）')
          : iv.location_text ? `場所：${iv.location_text}` : '';
        try {
          await mail.sendMail({
            to: iv.guest_email,
            subject: `【リマインド】${iv.booking_title} ${fmtRange(s, e)}`,
            text: [
              `${iv.intern_name} 様`,
              '',
              '予約の日時が近づいてきましたので、お知らせします。',
              '',
              `予約：${iv.booking_title}`,
              `日時：${fmtRange(s, e)}`,
              ...(staff ? [`担当：${staff.nickname}`] : []),
              ...(place ? [place] : []),
              '',
              '予約の変更・キャンセルはこちら：',
              iv.manage_url,
            ].join('\n'),
          });
          due.forEach((m) => sent.add(m));
          // 送っている間に取り消されていたら、取り消しを上書きしない
          const cur = await getInterview(iv.id);
          if (cur && cur.status === 'fixed') await saveInterview({ ...cur, reminders_sent: [...sent] });
        } catch (err) {
          console.warn(`リマインダーを送れませんでした（${iv.id}）`, err.message || err);
        }
      }
    } catch (e) {
      console.error('リマインダーの処理に失敗しました', e);
    }
  }

  return { init, handleGoogleChanges, sendDueReminders };
};
