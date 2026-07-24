# 食事宿泊報告ツール

ホーム（施設）ごとに専用パスワードでログインし、利用者の「夕食／宿泊／朝食」の〇×を報告できるツールです。
本部管理者は全ホームを横断して報告状況を確認できます。

## 画面構成

- `/login` : ホーム職員用ログイン（ホームを選択＋そのホームのパスワード）
- `/report` : 報告入力フォーム＋そのホームの最近の報告一覧（ログイン後）
- `/admin/login` : 本部管理者ログイン
- `/admin` : 全ホーム横断ダッシュボード（ホーム・日付で絞り込み可能）
- `/admin/homes/manage` : ホームの追加・パスワードリセット・削除
- `/admin/homes/:id/users` : そのホームの利用者（入居者）の追加・有効/無効切替・削除

## 利用者（入居者）の登録について

職員が報告フォームで名前を手入力する必要がないよう、利用者はあらかじめ管理者が登録しておきます。

1. `/admin` → `/admin/homes/manage` を開く
2. 対象ホームの「利用者を管理」ボタンから、そのホームの利用者を1人ずつ追加
3. 以後、そのホームの職員が `/report` を開くと、登録した利用者名がタブとして表示されます
4. 職員はタブを選んで〇×をチェックし「登録する」を押すだけ。同じ利用者・同じ日にもう一度登録すると内容が上書きされます（誤入力の訂正がしやすい設計です）
5. 退所などで報告対象から外したい場合は、削除ではなく「無効にする」を使うと過去の報告データは残したまま、タブからだけ非表示にできます

## ローカルでの動作確認（任意）

事前にPostgreSQLが必要です。RenderのDBをそのまま使う場合はこの手順は不要です。

```bash
npm install
cp .env.example .env
# .env の DATABASE_URL / SESSION_SECRET / ADMIN_PASSWORD を編集
npm run migrate        # テーブル作成
node scripts/seed_homes.js "ホームA" "初期パスワード"   # 最初のホームを1つ登録
npm start
```

ブラウザで `http://localhost:3000` を開いて確認できます。

## GitHubへの登録

```bash
cd meal-lodging-report
git init
git add .
git commit -m "Initial commit: 食事宿泊報告ツール"
git branch -M main
git remote add origin https://github.com/<あなたのユーザー名>/<リポジトリ名>.git
git push -u origin main
```

（GitHub側で先に空のリポジトリを作成しておいてください。`.env` は `.gitignore` 済みなのでパスワード類はpushされません）

## Renderへのデプロイ

同梱の `render.yaml` を使うと、Webサービスと無料PostgreSQLがまとめて作成されます。

1. Render (https://render.com) にログイン
2. 右上「New +」→「Blueprint」を選択
3. 先ほどpushしたGitHubリポジトリを選択（Renderに未連携の場合はGitHub連携を許可）
4. `render.yaml` が自動検出されるので内容を確認して「Apply」
5. 作成が始まったら、`ADMIN_PASSWORD` の環境変数だけは `sync: false` にしているため、
   Render管理画面の Web Service →「Environment」タブから手動で本部管理者パスワードを設定してください
6. デプロイ完了後、発行されたURL（例: `https://meal-lodging-report.onrender.com`）にアクセス

### 初回のホーム登録（6〜10ホーム分）

デプロイ後、Render管理画面の Web Service →「Shell」タブを開いて以下を1ホームずつ実行してください。

```bash
node scripts/seed_homes.js "ホームA" "ホームAのパスワード"
node scripts/seed_homes.js "ホームB" "ホームBのパスワード"
```

または `/admin/homes/manage` 画面（本部管理者ログイン後）からブラウザ上で追加することも可能です。
以後のホーム追加・パスワード変更は、基本的にこの管理画面から行うのが簡単です。

## 運用メモ

- ホーム職員は自分のホームのデータしか見えません（他ホームのデータは見えない設計です）
- 本部管理者は全ホームのデータを横断的に確認できます
- 無料プランのRenderはPostgreSQL無料枠が90日で期限切れになる場合があります（Render公式の案内に従い、期限が近づいたら有料プランへの切替、または新しいDBへの移行をご検討ください）
- 無料プランのWebサービスはアクセスが一定時間ないとスリープし、次回アクセス時に数十秒起動待ちが発生することがあります。常時稼働させたい場合は有料プランへの変更をご検討ください
