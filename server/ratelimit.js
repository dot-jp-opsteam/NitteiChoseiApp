/* =========================================================
   ログイン不要の入口を守る、ごく簡単な回数制限

   面談の申請ページ（/i/<合言葉>）と公開の出欠回答ページ（/a/<共有URL>）は、
   ログインを求めない。合言葉さえ知っていれば誰でも叩けるうえ、
   配布先が広いので合言葉が外へ漏れることも織り込んでおく必要がある。
   守りが無いと、1回600枠の申請を延々と送りつけて interviews を溢れさせたり、
   回答者の行を無限に増やしたりできてしまう。

   外部の道具（express-rate-limit 等）は入れない。依存を増やさない方針と、
   インスタンスが1つである前提（readDB のキャッシュ・stream.js と同じ）から、
   プロセス内の数え上げで十分なため。
   インスタンスを増やす日が来たら、ここは作り直しが必要。

   数え方は固定窓。窓が変わる境目では最大2倍まで通るが、
   ここで止めたいのは「機械で延々と叩く」動きなので、その粗さで足りる。
   ========================================================= */
'use strict';

/* 数えた記録の置き場。放っておくと際限なく増えるので、
   古いものは掃除する（sweep）。 */
const buckets = new Map();   // `${name}|${key}` -> { n, at }

const WINDOW_MS = 60 * 1000;
/* 一度に抱える相手の数の上限。これを超えたら古い順に捨てる。
   捨てられた相手は数え直しになるが、上限に達するのは
   多数のIPから同時に叩かれているときなので、その状況では
   どのみち1つのIPあたりの回数は伸びない */
const MAX_BUCKETS = 10000;

function sweep(now) {
  for (const [k, v] of buckets) {
    if (now - v.at > WINDOW_MS) buckets.delete(k);
  }
  // 掃除しても多すぎるときは、古い順に落とす（Mapは挿入順に並んでいる）
  if (buckets.size > MAX_BUCKETS) {
    const excess = buckets.size - MAX_BUCKETS;
    let i = 0;
    for (const k of buckets.keys()) {
      if (i++ >= excess) break;
      buckets.delete(k);
    }
  }
}

/**
 * 1回ぶん数えて、上限を超えたかを返す。
 *
 * @param {string} name   数える単位の名前（口ごとに分ける）
 * @param {string} key    相手を見分けるもの（ふつうはIPアドレス）
 * @param {number} limit  窓の中で許す回数
 * @param {object} opts   now（現在時刻。試験で固定するため）
 * @returns {{limited: boolean, remaining: number, retryAfter: number}}
 *          limited が true なら断ること。retryAfter は次に受け付けるまでの秒数
 */
function hit(name, key, limit, opts = {}) {
  const now = opts.now || Date.now();
  // 数える相手が分からないときは、全員まとめて1つの枠として扱う
  const id = `${name}|${key || 'unknown'}`;
  const cur = buckets.get(id);

  if (!cur || now - cur.at >= WINDOW_MS) {
    buckets.set(id, { n: 1, at: now });
    if (buckets.size > MAX_BUCKETS) sweep(now);
    return { limited: false, remaining: Math.max(0, limit - 1), retryAfter: 0 };
  }

  cur.n += 1;
  if (cur.n > limit) {
    return {
      limited: true,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((WINDOW_MS - (now - cur.at)) / 1000)),
    };
  }
  return { limited: false, remaining: Math.max(0, limit - cur.n), retryAfter: 0 };
}

/* Expressに挟む形にしたもの。断るときは429を返す。
   文言は利用者がそのまま読むので、機械的な言い方は避ける */
function limiter(name, limit, keyOf) {
  return (req, res, next) => {
    if (limit <= 0) return next();   // 0以下なら制限しない
    const r = hit(name, keyOf ? keyOf(req) : req.ip, limit);
    if (!r.limited) return next();
    res.set('Retry-After', String(r.retryAfter));
    return res.status(429).json({
      error: '短い時間に何度も送信されました。少し時間をおいてからお試しください。',
      code: 'rate_limited',
    });
  };
}

/* 試験用。数えた記録を空にする */
function _resetForTest() {
  buckets.clear();
}

module.exports = { hit, limiter, WINDOW_MS, MAX_BUCKETS, _resetForTest };
