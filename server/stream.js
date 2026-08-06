/* =========================================================
   つながっている画面へ「更新があった」ことを押し出す仕組み（SSE）

   面談の申請や確定は、これまで画面を再読み込みするまで気づけなかった。
   定期ポーリングが store の updatedAt しか見ておらず、
   専用テーブルに入る面談・通知では updatedAt が動かなかったため。

   ここでは中身を送らず「更新があった」ことだけを送る。
   中身を載せると、誰に何を見せるかの判定を /api/db と二重に持つことになる。
   受け取った画面が /api/db を取り直す。

   接続の一覧はこのプロセスのメモリに置く。
   Render 無料プランはインスタンスが1つなので成立する（readDB のキャッシュと同じ前提）。
   インスタンスを増やす日が来たら、ここは作り直しが必要。
   ========================================================= */

/* 無反応の接続は途中の経路で切られる。生きていることを知らせる間隔。
   Render の前段はおよそ100秒で切るので、その半分より短くしてある */
const HEARTBEAT_MS = 25000;

const clients = new Set();

/* つないできた画面を控える。戻り値をそのまま removeClient に渡す */
function addClient(res, user) {
  const c = {
    res,
    userId: user.id,
    branchId: user.branch_id || null,
    role: user.role,
  };
  clients.add(c);
  return c;
}
function removeClient(c) {
  clients.delete(c);
}

/* その通知がこの人に見えるか。
   server.js の listNotificationsFor と同じ規則にしてある。
   ここがずれると、届いた合図で取り直しても中身が増えず無駄になる */
function canSee(c, branchId) {
  if (c.role === 'admin') return true;
  if (branchId == null) return true;
  return c.branchId === branchId;
}

/* 見える人にだけ押し出す。書けない相手は切れているので一覧から外す */
function broadcast(branchId, payload) {
  const body = `event: refresh\ndata: ${JSON.stringify(payload || {})}\n\n`;
  for (const c of [...clients]) {
    if (!canSee(c, branchId)) continue;
    try { c.res.write(body); } catch { clients.delete(c); }
  }
}

function clientCount() {
  return clients.size;
}

let timer = null;
function startHeartbeat() {
  if (timer) return;
  timer = setInterval(() => {
    for (const c of [...clients]) {
      try { c.res.write(': ping\n\n'); } catch { clients.delete(c); }
    }
  }, HEARTBEAT_MS);
  // これがあるとテストでプロセスが終わらなくなるので、待ち行列には数えさせない
  if (timer.unref) timer.unref();
}
function stopHeartbeat() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  addClient, removeClient, broadcast, clientCount,
  startHeartbeat, stopHeartbeat, HEARTBEAT_MS,
};
