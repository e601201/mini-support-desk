import * as cdk from 'aws-cdk-lib';
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';

import { Hosting, BlocksStack, SandboxDisableDeletionProtection } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getSandboxId } from './scripts/sandbox-id.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

const stackName = sandboxMode ? `mini-support-desk-stack-${getSandboxId(projectRoot)}` : 'mini-support-desk-stack-prod';
export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts')
});

if (sandboxMode) {
  // すべてのリソースを削除可能にして、sandbox:destroy がスタック全体を
  // クリーンアップできるようにする。これは以下で追加するものを含め、スタック内の
  // すべてのリソースの削除ポリシーと削除保護(例: RDS)を上書きする。
  // teardown の挙動を自分で管理したい場合は、これらの行を削除すること。
  RemovalPolicies.of(blocksStack).destroy();
  Mixins.of(blocksStack).apply(new SandboxDisableDeletionProtection());

  // Cookie にクロスドメイン属性が必要であることをランタイムに伝える(フロントエンドは
  // localhost、API は API Gateway — 登録可能ドメインが異なるため)。
  blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true');
}

// デプロイ時のみ静的サイトホスティングを追加する(サンドボックスモードでは追加しない)
if (!sandboxMode) {
  new Hosting(blocksStack, 'Hosting', {
    root: join(__dirname, '..'),
    buildCommand: 'npm run build',
    buildOutputDir: 'dist',
    api: blocksStack
  });
}