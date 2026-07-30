/* =========================================================
   デザイン確認用ページを作り直すスクリプト
   ---------------------------------------------------------
   使い方（このリポジトリの直下で）：
       node tools/make-test-page.mjs

   index.html を直したあとにこれを実行すると、
   test/デザイン確認用.html が最新の見た目で作り直される。

   やっていること（index.html への変更は3か所だけ）：
     1. style.css の参照を ../style.css に直す（testフォルダの中にあるため）
     2. 利用規約・プライバシーポリシーのリンクを相対パスに直す
        （file:// で開くと / 始まりのリンクはドライブの一番上を指してしまう）
     3. アプリ本体より先に test-mock.js を読み込ませる
        （偽のfetchを仕込み、ログインを通らずダミーデータで動かすため）

   アプリ本体のコードそのものには一切手を入れていない。
   ========================================================= */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'index.html');
const OUT_DIR = join(ROOT, 'test');
const OUT = join(OUT_DIR, 'デザイン確認用.html');

const STYLE_TAG = '<link rel="stylesheet" href="style.css">';

const BANNER = `<!--
  ※ このファイルは自動生成です。直接編集しても次回の生成で消えます。
     直したいときは index.html か test/test-mock.js を編集して、
     node tools/make-test-page.mjs を実行し直してください。
-->
`;

const html = await readFile(SRC, 'utf8');

if (!html.includes(STYLE_TAG)) {
  console.error(`index.html の中に ${STYLE_TAG} が見つかりません。`);
  console.error('スタイルシートの書き方が変わった可能性があります。このスクリプトを直してください。');
  process.exit(1);
}

const out = BANNER + html
  // 1・3をまとめて差し込む。scriptタグの実行順は書かれた順なので、
  // ここに置けばアプリ本体（後ろのscript）より必ず先に走る
  .replace(
    STYLE_TAG,
    '<link rel="stylesheet" href="../style.css">\n'
    + '<!-- テスト用：偽のfetchを仕込み、ログイン不要でダミーデータを表示する -->\n'
    + '<script src="test-mock.js"></script>'
  )
  // 2
  .replace('href="/terms.html"', 'href="../terms.html"')
  .replace('href="/privacy.html"', 'href="../privacy.html"');

await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT, out, 'utf8');

console.log(`作成しました: test/デザイン確認用.html（${out.length.toLocaleString()}文字）`);

/* ---------------------------------------------------------
   役割ごとの入口を作る。

   はじめはWindowsのショートカット（.url）にしていたが、
   file:// のURLに ?role=staff のような「?」が付いていると
   Windowsが開けず「指定されたファイルが見つかりません」になる。
   そのため、ダブルクリックできる小さなHTMLを入口にした。
   中で本体へ転送するだけなので、相対パスで済み、
   フォルダをどこへ移してもそのまま動く。
   --------------------------------------------------------- */
const ENTRIES = [
  ['スタッフの画面を見る.html', 'staff', 'スタッフ'],
  ['インターン生の画面を見る.html', 'intern', 'インターン生'],
];

for (const [name, role, label] of ENTRIES) {
  const page = `<!doctype html>
<meta charset="utf-8">
<title>${label}の画面を開いています…</title>
<!--
  ※ このファイルは自動生成です。
     デザイン確認用.html を ${label} として開くだけの入口です。
-->
<style>
  body{margin:0;height:100vh;display:grid;place-items:center;
       background:#0e1113;color:#e6edf3;
       font-family:"Yu Gothic UI","Meiryo",sans-serif}
</style>
<p>${label}の画面を開いています…</p>
<script>
  location.replace('デザイン確認用.html?role=${role}');
</script>
`;
  await writeFile(join(OUT_DIR, name), page, 'utf8');
  console.log(`作成しました: test/${name}`);
}
