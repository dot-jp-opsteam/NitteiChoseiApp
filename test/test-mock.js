/* =========================================================
   デザイン確認用ページ（テスト専用）の中身
   ---------------------------------------------------------
   このファイルは本番では一切読み込まれない。
   server.js の PUBLIC_FILES にも登録していないため、
   本番URLからこのページに到達する経路は存在しない。

   やっていること：
   アプリ本体（index.html）の通信はすべて fetch() 1か所を通る。
   そこで本物の fetch を偽物に差し替え、サーバーの代わりに
   このファイルの中のダミーデータを返している。
   結果として、ログインを通らずに画面が出て、
   保存操作をしても本番のデータベースには一切届かない。

   アプリ本体のコードは1行も変えていない。

   URLの後ろに付けられるもの：
     ?role=intern        インターン生として開く（既定）
     ?role=staff         スタッフとして開く
     ?role=branch_admin  支部管理者として開く
     ?role=admin         管理者として開く
     ?empty=1            データ0件の状態を見る
     ?screen=login       ログイン画面を見る（何を入れても入れる）
   ========================================================= */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var ROLE = params.get('role') || 'intern';
  if (['intern', 'staff', 'branch_admin', 'admin'].indexOf(ROLE) < 0) ROLE = 'intern';
  var EMPTY = params.get('empty') === '1';

  // ログアウトを押した後にログイン画面を出すための目印。
  // 本体は logout() で location.reload() するので、タブに覚えさせておく必要がある
  var LOGGED_OUT_KEY = 'ops_test_logged_out';
  if (params.get('screen') === 'login') sessionStorage.setItem(LOGGED_OUT_KEY, '1');

  /* ---------- 日付の道具（今日を基準にした相対日時でデータを作る） ---------- */
  function at(dayOffset, hour, min) {
    var d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, min || 0, 0, 0);
    return d.toISOString();
  }
  var NOW = new Date().toISOString();

  /* ---------- 支部（本番と同じ全国37支部） ---------- */
  var BRANCH_NAMES = [
    '北海道', '宮城', '米沢', '福島', '栃木',
    '東京企業', '東京第一', '東京第二', '東京第三', '東京第四',
    '神奈川', '静岡', '愛知', '三重', '新潟', '石川', '福井',
    '京都第一', '京都第二', '大阪第一', '大阪第二', '奈良', '兵庫',
    '岡山', '広島第一', '広島第二', '香川', '山口',
    '福岡', '北九州', '大分', '長崎',
    '熊本企業', '熊本第一', '熊本第二', '宮崎', '鹿児島',
  ];
  var branches = BRANCH_NAMES.map(function (name, i) { return { id: 'b' + (i + 1), name: name }; });
  // ダミーの登場人物は全員この支部に置く（b5＝栃木）
  var HOME_BRANCH = 'b5';

  /* ---------- 人（架空。実在の人物とは関係ありません） ---------- */
  function user(id, nickname, role, branch_id, staff_id) {
    return {
      id: id,
      email: id + '@example.test',
      nickname: nickname,
      role: role,
      branch_id: branch_id,
      status: 'active',
      created_at: at(-120, 10),
      approved_at: at(-120, 10),
      avatar_url: null,
      staff_id: staff_id || null,
      needs_profile: false,
      has_password: true,
    };
  }

  var users = [
    user('u_admin', '運営 事務局', 'admin', HOME_BRANCH),
    user('u_badmin', '高橋 美咲', 'branch_admin', HOME_BRANCH),
    user('u_staff1', '東 玲奈', 'staff', HOME_BRANCH),
    user('u_staff2', '佐藤 健', 'staff', HOME_BRANCH),
    user('u_staff3', '中村 陽介', 'staff', HOME_BRANCH),
    user('u_int1', '田中 悠斗', 'intern', HOME_BRANCH, 'u_staff1'),
    user('u_int2', '鈴木 彩香', 'intern', HOME_BRANCH, 'u_staff1'),
    user('u_int3', '伊藤 大輝', 'intern', HOME_BRANCH, 'u_staff2'),
    user('u_int4', '渡辺 芽依', 'intern', HOME_BRANCH, 'u_staff2'),
    user('u_int5', '小林 翔太', 'intern', HOME_BRANCH, null),
  ];

  // どの人としてログインした状態にするか
  var ME_BY_ROLE = { intern: 'u_int1', staff: 'u_staff1', branch_admin: 'u_badmin', admin: 'u_admin' };
  var ME = users.filter(function (u) { return u.id === ME_BY_ROLE[ROLE]; })[0];

  /* ---------- 面談（申請中・確定済み・不成立をひと通り） ---------- */
  var interviews = [
    {
      id: 'iv_1', intern_id: 'u_int1', staff_id: 'u_staff1', status: 'fixed',
      choice1: at(3, 15, 0), choice2: at(4, 17, 0), choice3: at(5, 11, 0),
      meeting_type: 'meet', confirmed_datetime: at(3, 15, 0),
      note: '就職活動の進め方について相談したいです。', created_at: at(-2, 21, 12),
    },
    {
      id: 'iv_2', intern_id: 'u_int2', staff_id: 'u_staff1', status: 'applied',
      choice1: at(2, 18, 30), choice2: at(6, 13, 0), choice3: null,
      meeting_type: 'zoom', confirmed_datetime: null,
      note: '', created_at: at(-1, 9, 40),
    },
    {
      id: 'iv_3', intern_id: 'u_int3', staff_id: 'u_staff2', status: 'applied',
      choice1: at(4, 10, 0), choice2: null, choice3: null,
      meeting_type: 'meet', confirmed_datetime: null,
      note: 'イベントの運営について伺いたいです。', created_at: at(0, 8, 5),
    },
    {
      id: 'iv_4', intern_id: 'u_int4', staff_id: 'u_staff2', status: 'failed',
      choice1: at(-6, 16, 0), choice2: at(-5, 16, 0), choice3: null,
      meeting_type: 'meet', confirmed_datetime: null,
      note: '', created_at: at(-9, 22, 30),
    },
  ];

  /* ---------- イベント ---------- */
  var events = [
    {
      id: 'ev_1', creator_id: 'u_badmin', title: '7月度 支部定例ミーティング',
      description: '今月の活動報告と来月の予定共有を行います。',
      start_datetime: at(5, 19, 0), end_datetime: at(5, 20, 30),
      location: 'オンライン', branch_id: HOME_BRANCH, visibility: 'branch',
      color: '#6aa9f0', meet_url: 'https://meet.google.com/xxx-yyyy-zzz', zoom_url: '',
    },
    {
      id: 'ev_2', creator_id: 'u_staff1', title: '議員インターン 中間報告会',
      description: 'インターン生による中間報告。スタッフは全員参加をお願いします。',
      start_datetime: at(12, 13, 0), end_datetime: at(12, 17, 0),
      location: '宇都宮市文化会館 小ホール', branch_id: HOME_BRANCH, visibility: 'branch',
      color: '#3ddc97', meet_url: '', zoom_url: '',
    },
    {
      id: 'ev_3', creator_id: ME.id, title: '【自分メモ】資料づくり',
      description: '報告会のスライドを仕上げる。',
      start_datetime: at(9, 20, 0), end_datetime: at(9, 22, 0),
      location: '', branch_id: HOME_BRANCH, visibility: 'private',
      color: '#a98bf5', meet_url: '', zoom_url: '',
    },
  ];

  var event_responses = [
    { id: 'er_1', event_id: 'ev_1', user_id: 'u_int1', response: '○' },
    { id: 'er_2', event_id: 'ev_1', user_id: 'u_int2', response: '△' },
    { id: 'er_3', event_id: 'ev_1', user_id: 'u_int3', response: '×' },
    { id: 'er_4', event_id: 'ev_1', user_id: 'u_staff1', response: '○' },
    { id: 'er_5', event_id: 'ev_2', user_id: 'u_int1', response: '△' },
    { id: 'er_6', event_id: 'ev_2', user_id: 'u_staff2', response: '○' },
  ];

  /* ---------- メール履歴 ---------- */
  var emails = [
    {
      id: 'ml_1', sender_id: 'u_staff1', receiver_id: 'u_int1',
      subject: '面談日程が確定しました',
      body: 'お疲れ様です。\n面談日程が下記のとおり確定しましたのでお知らせします。\n\n方法：Google Meet\n\nよろしくお願いいたします。',
      sent_at: at(-2, 21, 30), delivered: true, kind: 'fixed',
    },
    {
      id: 'ml_2', sender_id: 'u_staff1', receiver_id: 'u_int1',
      subject: 'Google Meetリンクの送付',
      body: 'お疲れ様です。面談のGoogle Meetリンクをお送りします。\n\nhttps://meet.google.com/xxx-yyyy-zzz',
      sent_at: at(-1, 12, 0), delivered: false, kind: null,
    },
    {
      id: 'ml_3', sender_id: 'u_staff2', receiver_id: 'u_int4',
      subject: '面談が不成立となりました',
      body: 'お疲れ様です。\n今回はご希望の日程で調整がつきませんでした。\nお手数ですが、あらためて申請をお願いいたします。',
      sent_at: at(-5, 18, 0), delivered: true, kind: 'failed',
    },
  ];

  /* ---------- 通知 ---------- */
  var notifications = [
    { id: 'nt_1', type: '面談申請', msg: '鈴木 彩香さんが面談を申請しました', at: at(-1, 9, 40), branch_id: HOME_BRANCH },
    { id: 'nt_2', type: 'イベント作成', msg: '「7月度 支部定例ミーティング」が作成されました', at: at(-3, 11, 0), branch_id: HOME_BRANCH },
    { id: 'nt_3', type: '面談確定', msg: '田中 悠斗さんの面談日程が確定しました', at: at(-2, 21, 30), branch_id: HOME_BRANCH },
    { id: 'nt_4', type: '依頼', msg: '佐藤 健さんから「【デジマ】SNS投稿の担当わけ」が届きました', at: at(0, 11, 30), branch_id: HOME_BRANCH },
  ];

  /* ---------- インターン先マスタ ---------- */
  var internships = [
    { id: 'ip_1', name: '髙橋ひろし議員事務所', branch_id: HOME_BRANCH, created_by: 'u_staff1', created_at: at(-40, 14) },
    { id: 'ip_2', name: '宇都宮市議会 森田事務所', branch_id: HOME_BRANCH, created_by: 'u_staff2', created_at: at(-35, 10) },
    { id: 'ip_3', name: '足利市議会 大西事務所', branch_id: HOME_BRANCH, created_by: 'u_staff1', created_at: at(-20, 16) },
  ];

  /* ---------- 所属部署・インターン先の割り当て ---------- */
  var profiles = {
    u_badmin: { departments: ['事務局', '人財開発'] },
    u_staff1: { departments: ['デジマ', 'プロモーション'] },
    u_staff2: { departments: ['プログラム'] },
    u_staff3: { departments: ['クライアント', 'アライアンス'] },
    u_int1: { internship_id: 'ip_1' },
    u_int2: { internship_id: 'ip_1' },
    u_int3: { internship_id: 'ip_2' },
    u_int4: { internship_id: 'ip_3' },
    u_int5: {},   // まだインターン先が決まっていない人
  };

  /* ---------- 依頼 ---------- */
  var requests = [
    {
      id: 'rq_1', sender_id: 'u_badmin', branch_id: HOME_BRANCH,
      subject: '来週の定例、資料の準備をお願いします',
      body: 'お疲れ様です。\n7月度の定例ミーティングに向けて、各自の担当分の資料を前日までにご準備ください。\n\n形式は自由です。よろしくお願いします。',
      target_label: '支部の全スタッフ',
      recipient_ids: ['u_staff1', 'u_staff2', 'u_staff3'],
      read_by: [{ user_id: 'u_staff2', at: at(-2, 10) }],
      created_at: at(-3, 9, 20),
    },
    {
      id: 'rq_2', sender_id: 'u_staff1', branch_id: HOME_BRANCH,
      subject: '中間報告会のリハーサル日程について',
      body: 'お疲れ様です。\n中間報告会に向けたリハーサルを来週おこないます。\n参加できる日をこのあとの面談でお知らせください。',
      target_label: '髙橋ひろし議員事務所（インターン先）',
      recipient_ids: ['u_int1', 'u_int2'],
      read_by: [{ user_id: 'u_int2', at: at(-1, 20) }],
      created_at: at(-2, 18, 0),
    },
    {
      id: 'rq_3', sender_id: 'u_staff2', branch_id: HOME_BRANCH,
      subject: '【デジマ】SNS投稿の担当わけ',
      body: '今月のSNS投稿の担当を決めたいです。\n希望があれば今週中に連絡してください。',
      target_label: 'デジマ（部署）',
      recipient_ids: ['u_staff1'],
      read_by: [],
      created_at: at(0, 11, 30),
    },
  ];

  /* ---------- スタッフの空き時間 ---------- */
  var weekday = { on: true, s: '09:00', e: '21:00' };
  var weekend = { on: false, s: '10:00', e: '16:00' };
  var availability = {
    u_staff1: { weekly: { 0: weekend, 1: weekday, 2: weekday, 3: weekday, 4: weekday, 5: weekday, 6: { on: true, s: '10:00', e: '16:00' } }, blocks: [] },
    u_staff2: { weekly: { 0: weekend, 1: weekday, 2: weekday, 3: weekday, 4: weekday, 5: weekday, 6: weekend }, blocks: [] },
    u_staff3: { weekly: { 0: weekend, 1: weekday, 2: weekday, 3: weekday, 4: weekday, 5: weekday, 6: weekend }, blocks: [] },
  };

  /* ---------- ここまでを1つのDBにまとめる ---------- */
  var STORE = EMPTY
    ? {
        branches: branches, interviews: [], events: [], event_responses: [], emails: [],
        availability: {}, notifications: [], profiles: {}, internships: [], requests: [],
        seededAt: NOW, updatedAt: NOW,
      }
    : {
        branches: branches, interviews: interviews, events: events,
        event_responses: event_responses, emails: emails,
        availability: availability, notifications: notifications,
        profiles: profiles, internships: internships, requests: requests,
        seededAt: NOW, updatedAt: NOW,
      };

  function currentDB() {
    var db = JSON.parse(JSON.stringify(STORE));
    db.users = JSON.parse(JSON.stringify(users));
    return db;
  }

  /* =========================================================
     偽サーバー
     ========================================================= */
  function json(body, status) {
    return new Response(JSON.stringify(body === undefined ? {} : body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  function touch() { STORE.updatedAt = new Date().toISOString(); return STORE.updatedAt; }
  function uid() { return Math.random().toString(36).slice(2, 10); }

  var CONFIG = {
    googleLogin: true,       // ログイン画面のGoogleボタンも見えるようにしておく
    passwordReset: true,
    staffEmailDomain: 'dot-jp.or.jp',
  };

  function handle(path, method, body) {
    var loggedOut = sessionStorage.getItem(LOGGED_OUT_KEY) === '1';

    /* --- 起動 --- */
    if (path === '/api/bootstrap') {
      if (loggedOut) return json({ config: CONFIG, user: null, branches: branches });
      return json({ config: CONFIG, user: ME, db: currentDB() });
    }
    if (path === '/api/auth/config') return json(CONFIG);

    /* --- ログイン・ログアウト（テストなので中身は見ずに通す） --- */
    if (path === '/api/auth/login' || path === '/api/auth/register-intern' || path === '/api/auth/staff-signup') {
      sessionStorage.removeItem(LOGGED_OUT_KEY);
      return json({ ok: true, token: 'test-token', user: ME });
    }
    if (path === '/api/auth/logout') {
      sessionStorage.setItem(LOGGED_OUT_KEY, '1');
      return json({ ok: true });
    }
    /* --- プロフィール（ニックネーム・所属支部）の保存 --- */
    if (path === '/api/auth/complete-profile') {
      if (body && body.nickname) ME.nickname = String(body.nickname).trim();
      if (body && body.branch_id) ME.branch_id = body.branch_id;
      // users 一覧の中の自分も合わせて書き換える（画面のあちこちがこちらを見ているため）
      var self = users.filter(function (u) { return u.id === ME.id; })[0];
      if (self) { self.nickname = ME.nickname; self.branch_id = ME.branch_id; }
      return json({ ok: true, user: ME });
    }
    if (path === '/api/auth/me') {
      if (loggedOut) return json({ error: 'ログインしてください', code: 'unauthenticated' }, 401);
      return json({ user: ME });
    }

    /* --- DBの読み書き --- */
    if (path === '/api/db' && method === 'GET') return json(currentDB());
    if (path === '/api/db' && method === 'PUT') {
      // 本体は users を外して送ってくるので、users はこちらで保持し続ける
      var incoming = body || {};
      delete incoming._baseUpdatedAt;
      Object.keys(incoming).forEach(function (k) { if (k !== 'users') STORE[k] = incoming[k]; });
      return json({ updatedAt: touch() });
    }

    /* --- メール送信（本当には送らず、履歴にだけ残す） --- */
    if (path === '/api/mail/send') {
      STORE.emails = STORE.emails || [];
      STORE.emails.push({
        id: 'ml_' + uid(), sender_id: ME.id, receiver_id: (body && body.receiver_id) || null,
        subject: (body && body.subject) || '', body: (body && body.body) || '',
        sent_at: new Date().toISOString(), delivered: false, kind: (body && body.kind) || null,
      });
      touch();
      return json({ ok: true, sent: false, warning: 'テストページのため、実際には送信していません' });
    }

    /* --- 招待リンク --- */
    if (path.indexOf('/api/staff/intern-invite-url') === 0 || path.indexOf('/api/admin/staff-invite-url') === 0) {
      return json({ url: 'https://example.test/?staff=' + ME.id + '（テスト用のダミーです）', nickname: ME.nickname });
    }

    /* --- 担当スタッフの選択肢 --- */
    if (path.indexOf('/api/auth/staff-options') === 0 || path.indexOf('/api/me/staff') === 0) {
      return json({
        staff: users.filter(function (u) { return u.role === 'staff' || u.role === 'branch_admin'; })
          .map(function (u) { return { id: u.id, nickname: u.nickname }; }),
      });
    }
    if (path.indexOf('/api/auth/invite') === 0) return json({ staff: null });

    /* --- Googleカレンダー連携（未連携として見せる） --- */
    if (path.indexOf('/api/google/status') === 0) return json({ connected: false });

    /* --- 名簿取り込み（管理者画面） --- */
    if (path.indexOf('/api/admin/directory/status') === 0) return json({ count: 0, updatedAt: null });
    if (path.indexOf('/api/admin/directory/search') === 0) return json({ results: [] });

    /* --- ユーザーの追加・更新（テストではその場のメモリだけ書き換える） --- */
    if (path.indexOf('/api/admin/users/') === 0) {
      var id = decodeURIComponent(path.split('/').pop());
      var target = users.filter(function (u) { return u.id === id; })[0];
      if (target && body) Object.assign(target, body);
      return json({ ok: true, user: target || null });
    }
    if (path === '/api/admin/staff') {
      var created = user('u_' + uid(), (body && body.nickname) || '新しいスタッフ', (body && body.role) || 'staff', (body && body.branch_id) || HOME_BRANCH);
      users.push(created);
      return json({ ok: true, user: created });
    }

    /* --- それ以外は、とりあえず成功で返しておく --- */
    return json({ ok: true });
  }

  /* ---------- 本物の fetch を差し替える ---------- */
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, opts) {
    opts = opts || {};
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    // アプリのAPI以外（フォントの読み込みなど）は本物に通す
    if (url.indexOf('/api/') < 0) return realFetch(input, opts);

    var path = url.split('?')[0];
    var method = (opts.method || 'GET').toUpperCase();
    var body = null;
    if (opts.body) { try { body = JSON.parse(opts.body); } catch (e) { body = null; } }

    // 本番の待ち時間に近い見え方にするため、ほんの少しだけ遅らせる
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(handle(path, method, body)); }, 60);
    });
  };

  /* ---------- 画面の隅に「テスト中」の目印を出す ---------- */
  var ROLE_JP = { intern: 'インターン生', staff: 'スタッフ', branch_admin: '支部管理者', admin: '管理者' };
  document.addEventListener('DOMContentLoaded', function () {
    var tag = document.createElement('div');
    tag.textContent = 'テストページ（' + ROLE_JP[ROLE] + '／保存されません）';
    tag.style.cssText = 'position:fixed;right:10px;bottom:10px;z-index:99999;'
      + 'padding:6px 12px;border-radius:999px;font-size:12px;font-weight:600;'
      + 'background:#f4706f;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.25);'
      + 'pointer-events:none;font-family:inherit';
    document.body.appendChild(tag);
  });

  console.log('[テストページ] ログイン不要モードで動いています。役割：' + ROLE_JP[ROLE]);
})();
