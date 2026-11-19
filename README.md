# 家計簿（iPhone用）

GitHub Pages で画面だけを配信し、データは各自の Google スプレッドシート（Google Apps Script）に保存する家計簿です。

## このリポジトリに置かないもの

- 金額・口座・カード・家族の情報などのデータ
- Apps Script の URL
- 端末キー、LINE のトークン

これらはすべて Google 側（スプレッドシートとスクリプトプロパティ）と、各 iPhone の中だけにあります。
接続先とキーは、Apps Script が発行する「端末登録リンク」を開いたときに、その iPhone のブラウザ内に保存されます。
リンクの `#setup=` 以降はサーバーに送られない部分なので、GitHub には届きません。

## 置くファイル

| ファイル | 内容 |
| --- | --- |
| index.html | 画面 |
| app.js | 画面の動き |
| style.css | 見た目 |
| manifest.webmanifest, icon-180.png, icon-512.png | ホーム画面に追加したときのアプリ名とアイコン |

## 公開のしかた

1. GitHub で新しいリポジトリ（例：`kakeibo`）を作り、上のファイルを置く
2. Settings → Pages → Branch を `main` / `(root)` にして保存
3. 表示された URL（`https://ユーザー名.github.io/kakeibo/`）を、Apps Script の `PAGES_URL` に書く

## 安全のための仕組み

- 画面からの通信は、端末ごとのキーで確認します。スクリプト側にはキーのハッシュだけを保存します。
- キーを持たない人が URL にアクセスしても、データは返しません。
- iPhone をなくしたときは、Apps Script で `revokeAllKeys` を実行すると、すべての端末の登録が無効になります。
- 画面は Content-Security-Policy で、自分のファイルと Google Apps Script 以外への通信をできなくしています。
