// 顧客向けインラインHTMLページの共有シェル。
// これまで index.ts / liff.ts / discord-link.ts / tracked-links.ts に
// ほぼ同一の <style> ブロックがコピペされ、色や角丸がドリフトしていた。
// デザイントークンは管理画面 (apps/web) と同じ白+青系。
// LINE操作ボタン (LINEで開く・友だち追加) だけは LINE公式グリーンを使う。

const FONT_LINK =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700&display=swap" rel="stylesheet">';

const SHELL_CSS = `*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Noto Sans JP','Hiragino Sans','Helvetica Neue',system-ui,sans-serif;background:#f6f9fc;display:flex;justify-content:center;align-items:center;min-height:100vh;color:#17212f;-webkit-font-smoothing:antialiased}
.card{background:#fff;border-radius:16px;box-shadow:0 2px 20px rgba(23,33,47,0.06);text-align:center;max-width:360px;width:90%;padding:40px 28px 32px;border:1px solid #dae3ee}
.card.wide{max-width:480px;padding:48px}
.line-icon{width:48px;height:48px;margin:0 auto 20px}
.line-icon svg{width:48px;height:48px}
.icon-circle{width:56px;height:56px;border-radius:50%;margin:0 auto 20px;display:flex;align-items:center;justify-content:center;font-size:26px;background:#e4edfc}
.icon-circle.success{background:#d1fae5}
.icon-circle.error{background:#fee2e2}
.title{font-size:18px;font-weight:700;color:#17212f;margin-bottom:10px;line-height:1.5}
.msg{font-size:15px;color:#53637a;font-weight:500;margin-bottom:28px;line-height:1.7}
.btn{display:block;width:100%;padding:16px;border:none;border-radius:12px;font-size:16px;font-weight:700;text-decoration:none;text-align:center;color:#fff;background:#2563eb;box-shadow:0 2px 12px rgba(37,99,235,0.2);transition:all .15s;cursor:pointer}
.btn:active{transform:scale(0.98);opacity:.9}
.btn-line{background:#06C755;box-shadow:0 2px 12px rgba(6,199,85,0.2)}
.hint{font-size:11px;color:#8695ac;margin-top:10px;line-height:1.6}
.hint strong{color:#06C755;font-weight:700}
.help{font-size:12px;color:#8695ac;margin-top:18px;line-height:1.5}
.help a{color:#53637a;text-decoration:underline}
.qr{background:#f6f9fc;border-radius:16px;padding:24px;display:inline-block;margin-bottom:24px;border:1px solid #dae3ee}
.qr img{display:block;width:240px;height:240px}
.footer{font-size:11px;color:#8695ac;margin-top:24px;line-height:1.5}`;

// LINE公式ロゴマーク (LINE操作ページで使う)
export const LINE_ICON_SVG =
  '<svg viewBox="0 0 48 48" fill="none"><rect width="48" height="48" rx="12" fill="#06C755"/><path d="M24 12C17.37 12 12 16.58 12 22.2c0 3.54 2.35 6.65 5.86 8.47-.2.74-.76 2.75-.87 3.17-.14.55.2.54.42.39.18-.12 2.84-1.88 4-2.65.84.13 1.7.22 2.59.22 6.63 0 12-4.58 12-10.2S30.63 12 24 12z" fill="#fff"/></svg>';

export interface PageShellOptions {
  /** <title> と OGP に使うタイトル */
  title: string;
  /** <body> 直下に入れる HTML (通常 .card で始める) */
  body: string;
  /** ページ固有の追加CSS */
  extraCss?: string;
  /** <head> に追加するタグ (OGP等) */
  extraHead?: string;
  /** script タグ等を body 末尾に入れる場合 */
  extraBodyEnd?: string;
}

export function pageShell({ title, body, extraCss = '', extraHead = '', extraBodyEnd = '' }: PageShellOptions): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
${FONT_LINK}
${extraHead}
<style>
${SHELL_CSS}
${extraCss}
</style>
</head>
<body>
${body}
${extraBodyEnd}
</body>
</html>`;
}
