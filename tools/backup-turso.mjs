/* =========================================================
   本番Turso の中身を手元へ退避する

   使い方（PowerShell）:
     $env:TURSO_DATABASE_URL = "libsql://..."
     $env:TURSO_AUTH_TOKEN   = "..."
     node tools/backup-turso.mjs

   値は Render のダッシュボード → 対象サービス → Environment から取る。

   出力先は _backup/turso-YYYYMMDD-HHMM.json（gitignore 済み）。
   ★このファイルには全員分のメールアドレスとパスワードのハッシュが入る。
     リポジトリはpublicなので、絶対にコミットしないこと。

   このスクリプトは読むだけで、本番には一切書き込まない。
   ========================================================= */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// server/ 側にインストールされている @libsql/client を借りる（tools用の依存は増やさない）
const { createClient } = createRequire(path.join(ROOT, 'server', 'package.json'))('@libsql/client');

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (!url) {
  console.error('TURSO_DATABASE_URL が設定されていません。');
  console.error('Render のダッシュボード → Environment から値を取って、先に設定してください。');
  process.exit(1);
}
/* 開発用DBを本番と取り違えて「退避できた」と思い込む事故を防ぐため、
   本番の形式でない接続先は --local を付けたときだけ許す（動作確認用） */
const allowLocal = process.argv.includes('--local');
if (!url.startsWith('libsql://') && !url.startsWith('https://') && !allowLocal) {
  console.error(`接続先が本番の形式ではありません: ${url}`);
  console.error('開発用DBを試しに退避したいときは --local を付けてください。');
  process.exit(1);
}

/* JSON にできない型を、読み戻せる形に直す。
   libsql は整数を BigInt で返すことがあり、そのままでは JSON.stringify が例外を投げる */
function toJsonSafe(v) {
  if (typeof v === 'bigint') return { $bigint: v.toString() };
  if (v instanceof Uint8Array) return { $base64: Buffer.from(v).toString('base64') };
  return v;
}

const client = createClient({ url, authToken });

const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
const outDir = path.join(ROOT, '_backup');
const outFile = path.join(outDir, `turso-${stamp}.json`);

try {
  const tablesRs = await client.execute(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  const tables = tablesRs.rows.map((r) => r.name);
  if (tables.length === 0) {
    console.error('テーブルが1つも見つかりませんでした。接続先が違う可能性があります。');
    process.exit(1);
  }

  const dump = { takenAt: new Date().toISOString(), source: url, tables: {} };
  const counts = [];
  for (const t of tables) {
    // テーブル名は sqlite_master から得たものなので、そのまま埋め込んで問題ない
    const rs = await client.execute(`SELECT * FROM "${t}"`);
    dump.tables[t] = rs.rows.map((row) => {
      const o = {};
      for (const k of Object.keys(row)) o[k] = toJsonSafe(row[k]);
      return o;
    });
    counts.push(`${t}: ${rs.rows.length}件`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  // 上書きは事故のもとなので、同名があれば止める（ファイル名は分単位なので普通は起きない）
  if (fs.existsSync(outFile)) {
    console.error(`すでに同じ名前のファイルがあります: ${outFile}`);
    console.error('1分待ってからもう一度実行してください。');
    process.exit(1);
  }
  fs.writeFileSync(outFile, JSON.stringify(dump, null, 2), 'utf8');

  const size = fs.statSync(outFile).size;
  console.log('退避しました。');
  console.log(`  保存先: ${outFile}`);
  console.log(`  大きさ: ${(size / 1024 / 1024).toFixed(2)}MB`);
  console.log(`  内訳  : ${counts.join(' / ')}`);
  console.log('');
  console.log('※このファイルには個人情報が入っています。コミットしないでください。');
} catch (e) {
  console.error('退避に失敗しました:', e.message);
  process.exit(1);
} finally {
  client.close?.();
}
