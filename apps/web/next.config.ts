import type { NextConfig } from 'next'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { resolve } from 'path'

const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf-8'))
const repoRoot = resolve(__dirname, '../..')

function readGitSha(): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return null
  }
}

const buildSha =
  process.env.APP_COMMIT_SHA || process.env.GITHUB_SHA || process.env.CF_PAGES_COMMIT_SHA || readGitSha() || 'local'
const buildTime = process.env.APP_BUILD_TIME || new Date().toISOString()

// NEXT_PUBLIC_API_URL はビルド時にバンドルへ焼き込まれるため、未設定のまま
// デプロイすると API を一切呼べない管理画面が出来上がる。src/lib/api.ts にも
// 同じガードがあるが、あちらは「いずれかのページが api.ts を import している」
// ことに依存していて、import 構成が変わると黙って効かなくなる。設定読み込みの
// 時点で落として、コンパイル前に確実に気付けるようにする。
if (!process.env.NEXT_PUBLIC_API_URL) {
  throw new Error(
    'NEXT_PUBLIC_API_URL is not set. Build cannot proceed without a valid API URL.\n' +
      '  例: NEXT_PUBLIC_API_URL=https://<worker>.workers.dev pnpm --filter web build',
  )
}

const nextConfig: NextConfig = {
  output: 'export',
  transpilePackages: ['@line-crm/shared'],
  env: {
    APP_VERSION: pkg.version,
    APP_COMMIT_SHA: buildSha.slice(0, 12),
    APP_BUILD_TIME: buildTime,
  },
}
export default nextConfig
