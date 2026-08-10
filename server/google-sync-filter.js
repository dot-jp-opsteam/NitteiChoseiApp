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

module.exports = { excludeOwnEvents };
