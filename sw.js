/* =========================================================
   Service Worker（プッシュ通知の受け取り専用）
   ---------------------------------------------------------
   このファイルは **通知だけ** を担当する。ページやAPIの
   キャッシュには一切手を出さない。オフライン対応を足すと、
   古いHTMLが端末に居座って「直したはずの画面が直らない」
   という一番厄介な不具合が起きるため。

   置き場所が / の直下でないと、アプリ全体を受け持てない
   （Service Workerは自分より下の階層しか担当できない）。
   配信の許可は server.js の PUBLIC_FILES にある。
   ========================================================= */

/* 入れ替えを待たせない。通知の中身を直したのに、
   タブを全部閉じるまで古いものが動き続ける状態を避ける */
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  const title = data.title || 'OPS日調アプリ';
  const options = {
    body: data.body || '',
    icon: '/icon-120.png',
    badge: '/icon-120.png',
    /* 同じ種類の知らせは1つにまとめる。申請が続けて5件来たときに
       通知欄が5行埋まると、かえって読まれなくなる */
    tag: data.tag || 'ops',
    renotify: true,
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

/* 通知を押したとき。すでにアプリのタブが開いていればそれを前に出し、
   無ければ新しく開く。毎回新しいタブが増えるのを防ぐため */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        if ('navigate' in c && url !== '/') { try { await c.navigate(url); } catch (e) { /* 続行 */ } }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
