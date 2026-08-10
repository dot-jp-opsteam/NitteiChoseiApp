/* Googleカレンダーからのpush通知に、このアプリ自身が書き込んだ予定が
   混ざって戻ってくる問題への対処。

   面談を確定すると、担当スタッフ（連携していればインターン生も）の
   Googleカレンダーに直接イベントを作る（server.js の syncInterviewToGoogle）。
   このアプリはそのカレンダーをwatchしているため、自分で作ったこの
   イベントの変更通知も webhook 経由でそのまま返ってくる。

   これを区別せず「外部の予定」として不可時間（availability.blocks）に
   取り込むと、同じ面談の時間帯が
     ・面談一覧（interviews テーブルの confirmed_datetime）
     ・不可時間の一覧（availability.blocks の external-google）
   の両方に別々に現れ、ユーザーからは同じ予定が二重に登録されたように
   見えてしまう（2026-08-10 に発見）。

   ここでは、確定済み面談が持つ googleEventId / googleEventIdIntern の
   集合と照らし合わせて、そのIDを持つ変更は「外部の予定」から除く。 */

function excludeOwnEvents(items, ownEventIds) {
  if (!ownEventIds || !ownEventIds.size) return items || [];
  return (items || []).filter((ev) => !ownEventIds.has(ev && ev.id));
}

/* 面談の確定を取り消す／別日時で確定し直すと、古いGoogleイベントは
   deleteGoogleEventFor で実際に削除される。しかし、そのイベントが
   一度でも webhook 経由で「外部の予定」として不可時間（blocks）に
   取り込まれていた場合、Google側の削除だけではそのブロックは消えず、
   もう存在しない予定が不可時間に残り続けてしまう（2026-08-10 発見）。

   ここでは、削除したGoogleイベントIDに一致する external-google ブロックを
   blocks から取り除く。一致が無ければ何も変えない。 */
function removeBlocksByEventId(blocks, googleEventId) {
  if (!googleEventId) return blocks || [];
  return (blocks || []).filter((b) => !(b.kind === 'external-google' && b.googleEventId === googleEventId));
}

module.exports = { excludeOwnEvents, removeBlocksByEventId };
