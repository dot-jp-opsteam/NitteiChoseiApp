/* 日本の祝日を、年をまたいでも自動で出せるようにするための共通ファイル。

   以前は index.html と apply.html のそれぞれに「2026年ぶん」を手打ちした表があり、
   二重管理なうえ、年が変われば祝日の表示が丸ごと消えていた。
   ここでは祝日法の規則そのものをコードにしてあるので、翌年以降も勝手に出る。

   規則で決まらないもの（即位の礼のような一度きりの祝日や、法改正で年を跨いで
   移動した祝日）は EXCEPTIONS に数行足して上書きする。それ以外は触らなくてよい。

   index.html / apply.html の両方から <script src="/holidays.js"> で読む。
   apply.html に合わせて ES5 の書き方にしてある。
   ブラウザ以外（テスト）からは module.exports 経由で使える。 */
(function (global) {
  'use strict';

  /* ---------- 規則で決まらない年だけを書く上書き表 ----------
     key='YYYY-M-D'（月・日はゼロ埋めしない）。
     値が文字列なら「その名前の祝日にする」、null なら「祝日ではないことにする」。

     例（2020年の東京五輪で動いた祝日）：
       '2020-7-23': '海の日', '2020-7-20': null のように足す。
     いまは対象年が無いので空にしてある。 */
  var EXCEPTIONS = {};

  /* ---------- 毎年おなじ日にある祝日 ---------- */
  var FIXED = {
    '1-1': '元日',
    '2-11': '建国記念の日',
    '2-23': '天皇誕生日',
    '4-29': '昭和の日',
    '5-3': '憲法記念日',
    '5-4': 'みどりの日',
    '5-5': 'こどもの日',
    '8-11': '山の日',
    '11-3': '文化の日',
    '11-23': '勤労感謝の日',
  };

  /* ---------- 第n月曜に動く祝日（ハッピーマンデー） ---------- */
  var NTH_MONDAY = [
    { month: 1, nth: 2, name: '成人の日' },
    { month: 7, nth: 3, name: '海の日' },
    { month: 9, nth: 3, name: '敬老の日' },
    { month: 10, nth: 2, name: 'スポーツの日' },
  ];

  // その月の第n月曜が何日か。month は 1-12
  function nthMonday(year, month, nth) {
    var firstDow = new Date(year, month - 1, 1).getDay();  // 0=日
    var firstMonday = 1 + ((8 - firstDow) % 7);
    return firstMonday + (nth - 1) * 7;
  }

  /* 春分・秋分は天文の計算で決まるため、暦の上では前年に官報で告示されるまで確定しない。
     ここでは 1980〜2099年について実績と一致する近似式を使う。
     この範囲の外に出たら、そのときの官報に合わせて EXCEPTIONS で直すこと。 */
  function equinoxDay(year, isSpring) {
    var base = isSpring ? 20.8431 : 23.2488;
    return Math.floor(base + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
  }

  /* ---------- 1年ぶんの祝日をまとめて作る ----------
     何度も呼ばれるので、一度作った年は CACHE に取っておく */
  var CACHE = {};

  function buildYear(year) {
    var map = {};
    var key;

    // 1. 日が決まっているもの
    for (key in FIXED) {
      if (Object.prototype.hasOwnProperty.call(FIXED, key)) map[key] = FIXED[key];
    }

    // 2. 第n月曜のもの
    NTH_MONDAY.forEach(function (h) {
      map[h.month + '-' + nthMonday(year, h.month, h.nth)] = h.name;
    });

    // 3. 春分・秋分
    map['3-' + equinoxDay(year, true)] = '春分の日';
    map['9-' + equinoxDay(year, false)] = '秋分の日';

    /* 4. 振替休日。祝日が日曜に当たったら、その後ろで最初に来る
          「祝日でない日」を休みにする。連休の途中でも正しく後ろへずれる */
    var subs = {};
    for (key in map) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
      var p = key.split('-');
      var d = new Date(year, Number(p[0]) - 1, Number(p[1]));
      if (d.getDay() !== 0) continue;
      do {
        d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      } while (map[(d.getMonth() + 1) + '-' + d.getDate()]);
      // 年をまたぐ振替（12/31が日曜の祝日）は現行法では起きないが、念のため弾く
      if (d.getFullYear() === year) subs[(d.getMonth() + 1) + '-' + d.getDate()] = '振替休日';
    }
    for (key in subs) {
      if (Object.prototype.hasOwnProperty.call(subs, key)) map[key] = subs[key];
    }

    /* 5. 国民の休日。祝日と祝日に挟まれた平日は休みになる。
          いまのところ9月の敬老の日と秋分の日の間だけに起きるが、規則どおりに探す */
    var gaps = {};
    for (key in map) {
      if (!Object.prototype.hasOwnProperty.call(map, key)) continue;
      var q = key.split('-');
      var day = new Date(year, Number(q[0]) - 1, Number(q[1]));
      var mid = new Date(year, day.getMonth(), day.getDate() + 1);
      var next = new Date(year, day.getMonth(), day.getDate() + 2);
      var midKey = (mid.getMonth() + 1) + '-' + mid.getDate();
      var nextKey = (next.getMonth() + 1) + '-' + next.getDate();
      if (mid.getFullYear() !== year || next.getFullYear() !== year) continue;
      if (map[midKey]) continue;             // 真ん中が既に祝日なら関係ない
      if (mid.getDay() === 0) continue;      // 日曜は「国民の休日」にならない
      if (!map[nextKey]) continue;           // 挟まれていない
      gaps[midKey] = '国民の休日';
    }
    for (key in gaps) {
      if (Object.prototype.hasOwnProperty.call(gaps, key)) map[key] = gaps[key];
    }

    // 6. 例外の上書き。null は「祝日ではないことにする」
    for (key in EXCEPTIONS) {
      if (!Object.prototype.hasOwnProperty.call(EXCEPTIONS, key)) continue;
      var e = key.split('-');
      if (Number(e[0]) !== year) continue;
      var short = e[1] + '-' + e[2];
      if (EXCEPTIONS[key] === null) delete map[short];
      else map[short] = EXCEPTIONS[key];
    }

    return map;
  }

  function yearMap(year) {
    if (!CACHE[year]) CACHE[year] = buildYear(year);
    return CACHE[year];
  }

  /* 祝日の名前を返す。祝日でなければ undefined。
     m は 0-11（JavaScript の Date に合わせてある）。
     index.html と apply.html が今まで使っていた形と同じなので、呼び出し側は変えなくてよい */
  function holidayName(y, m, d) {
    return yearMap(y)[(m + 1) + '-' + d];
  }

  global.holidayName = holidayName;
  // テストから年ぶんまとめて確かめられるようにしておく
  global.holidaysOfYear = yearMap;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { holidayName: holidayName, holidaysOfYear: yearMap };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
