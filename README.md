# Mini Support Desk

[AWS Blocks](https://www.npmjs.com/package/@aws-blocks/blocks) をベースにした、React + AWS サーバーレスのスターターアプリです。
認証・ユーザーごとのデータ分離・楽観的ロック・タブ間のリアルタイム同期を備えた Todo 機能をサンプルとして実装しています。

ローカルでは自動モックで動作し、設定なしで AWS（DynamoDB / WebSocket など）へデプロイできます。

## 主な機能

- **認証（AuthBasic）** — サインアップ / サインイン / サインアウト。JWT セッション、タブ間でのログイン状態の同期。
- **ユーザーごとのデータ分離** — `userId` をパーティションキーにすることで、各ユーザーのデータが分離されます。
- **リアルタイム同期（Realtime）** — Todo の作成 / 更新 / 削除を WebSocket で全タブへ即時ブロードキャスト。
- **楽観的ロック** — `version` フィールド + `ifFieldEquals` により、同時更新による上書き（lost update）を防止。
- **セカンダリインデックス** — 優先度（priority）順・タイトル（title）順での並び替えクエリに対応。

## 技術スタック

| レイヤー | 使用技術 |
|----------|----------|
| フロントエンド | React 19, Vite 8, TypeScript |
| バックエンド | [@aws-blocks/blocks](https://www.npmjs.com/package/@aws-blocks/blocks)（AuthBasic / DistributedTable / Realtime / ApiNamespace） |
| バリデーション | Zod 4 |
| インフラ | AWS CDK（DynamoDB, WebSocket など。`npm run deploy` で構築） |
| 実行 | Node.js >= 20, tsx |

## 必要要件

- Node.js **20 以上**
- AWS へデプロイする場合のみ、AWS の認証情報（`sandbox` / `deploy` 系コマンド）

> ローカル開発（`npm run dev`）は AWS 認証情報なしで動作します。クラウドリソースは自動的にモックされます。

## セットアップ

```bash
npm install      # 依存関係のインストール
npm run dev      # バックエンド + React 開発サーバーを同時起動
```

起動後、ブラウザで http://localhost:5173 を開いてください。
画面右上のメニューからサインアップしてログインすると、Todo 機能が利用できます。

## npm スクリプト

| コマンド | 説明 |
|----------|------|
| `npm run dev` | バックエンドと React 開発サーバーを同時起動（concurrently） |
| `npm run dev:client` | フロントエンド（Vite）のみ起動 |
| `npm run dev:server` | バックエンド（dev サーバー）のみ起動 |
| `npm run typecheck` | TypeScript の型チェック（`tsc --noEmit`） |
| `npm run build` | 型チェック + 本番ビルド（`vite build`） |
| `npm run preview` | ビルド成果物のプレビュー |
| `npm run test:e2e` | E2E テスト（型付きクライアント経由で API を検証） |
| `npm run sandbox` | バックエンドを AWS サンドボックスへデプロイし、フロントをローカル配信 |
| `npm run sandbox:destroy` | サンドボックスのリソースを破棄 |
| `npm run deploy` | 本番環境へフルデプロイ |
| `npm run destroy` | 本番環境のリソースを破棄 |

## プロジェクト構成

| パス | 役割 |
|------|------|
| `aws-blocks/index.ts` | バックエンド: 認証・データモデル・API・リアルタイムチャンネルの定義 |
| `aws-blocks/scripts/` | デプロイ / サンドボックス / クリーンアップ用スクリプト |
| `src/App.tsx` | フロントエンド: Todo UI（リアルタイム更新対応） |
| `src/main.tsx` | React エントリーポイント |
| `test/e2e.test.ts` | E2E テスト（認証・CRUD・競合・リアルタイム） |
| `index.html` | Vite のエントリ HTML |
| `vite.config.ts` | Vite 設定 |
| `cdk.json` | AWS CDK 設定 |

フロントエンドは `import { api, authApi } from 'aws-blocks'` でバックエンドの API を**型付きのまま直接呼び出します**。

## アーキテクチャ

バックエンド（`aws-blocks/index.ts`）が、認証・データテーブル・リアルタイムチャンネル・API を 1 ファイルで宣言します。
フロントエンドはその export を直接 import し、JSON-RPC のトランスポートは自動生成されるため意識する必要はありません。

### データモデル（Todo）

`DistributedTable`（DynamoDB）に保存されます。

| フィールド | 型 | 説明 |
|------------|-----|------|
| `userId` | string | パーティションキー（ユーザーごとの分離） |
| `todoId` | string | ソートキー（ユーザー内で一意） |
| `title` | string | タイトル |
| `completed` | boolean | 完了フラグ |
| `priority` | number | 優先度（1=高, 2=中, 3=低） |
| `version` | number | 楽観的ロック用（更新ごとにインクリメント） |
| `createdAt` | number | 作成時刻（epoch ミリ秒） |

セカンダリインデックス: `byPriority`（優先度順）/ `byTitle`（タイトル順）。いずれもパーティションキーは `userId`。

### 主な API（`api` namespace）

| メソッド | 説明 |
|----------|------|
| `createTodo(title, priority = 2)` | Todo を作成し `created` をブロードキャスト |
| `listTodos(sortBy?)` | 一覧取得（`'priority'` / `'title'` で並び替え、省略時は作成順） |
| `toggleTodo(todoId)` | 完了状態を切り替え（楽観的ロックあり） |
| `updatePriority(todoId, priority)` | 優先度を変更（楽観的ロックあり） |
| `deleteTodo(todoId)` | 削除し `deleted` をブロードキャスト |
| `subscribeTodos()` | リアルタイムチャンネルを購読 |
| `greet()` | 動作確認用の挨拶を返す |

認証 API（`authApi`）はサインアップ / サインイン / サインアウトを提供します（`@aws-blocks/blocks/ui` の `AccountMenuBar` で UI を構築）。

## デプロイ（AWS 認証情報が必要）

```bash
npm run sandbox          # サンドボックスへデプロイ（バックエンド: AWS / フロント: ローカル）
npm run sandbox:destroy  # サンドボックスを破棄
npm run deploy           # 本番へフルデプロイ
npm run destroy          # 本番リソースを破棄
```

## 開発上の注意

- **永続化には必ず Building Blocks を使用してください。** ローカルファイル・メモリ上の配列・ローカル DB は使わないでください（ローカルでは自動モック、AWS では自動的に実リソースへデプロイされます）。
- **JSON-RPC のトランスポートは不可視です。** RPC ペイロードを手動で組み立てたり、エンドポイントへ直接 curl したりせず、型付き API を import して呼び出してください。
- テストは `npm run test:e2e` 経由が推奨です（フロントと同じ型付きクライアントを使用します）。
- ブロックの詳細ドキュメントは `node_modules/@aws-blocks/blocks/README.md`、各ブロックは `node_modules/@aws-blocks/blocks/docs/<package-name>.md` を参照してください。

エージェント向けの補足は [`AGENTS.md`](./AGENTS.md) にあります。

## ライセンス

[MIT License](./LICENSE) © 2026 Daichi Nagata
