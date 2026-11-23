/**
 * 把 Ingrid's AI Agents 打包成真正的 macOS .app（独立 Electron 应用）。
 *
 * 为什么要打包：
 *   旧的 ~/Applications/Ingrid's AI Agents.app 只是一个 shell 脚本壳，
 *   CFBundleExecutable=launcher，双击后去调 node_modules 里的通用 Electron 二进制。
 *   这导致 macOS 的 TCC 把「控制邮件/日历」的自动化授权记在通用「Electron」名下，
 *   而不是本应用名下，授权弹窗显示「Electron」、且身份不稳定 → 读不到 Apple Mail。
 *
 *   打包成真正的 .app（CFBundleExecutable=Electron 二进制、bundleId=com.ingridxi.agents、
 *   含 NSAppleEventsUsageDescription）后，授权弹窗会正确显示「Ingrid's AI Agents」，
 *   点一次「允许」即可永久生效。
 *
 * 用法：node build/build-app.cjs
 * 产物：dist/Ingrid's AI Agents.app，并复制到 ~/Applications 与 ~/Desktop
 */
const { packager } = require('@electron/packager');
const path = require('path');
const fs = require('fs');
const os = require('os');

const projectRoot = path.resolve(__dirname, '..');
const appName = "Ingrid's AI Agents";
const outDir = path.join(projectRoot, 'dist');

async function main() {
  const iconPath = path.join(__dirname, 'IngridIcon.icns');
  const extendInfoPath = path.join(__dirname, 'extend-info.plist');

  const appPaths = await packager({
    dir: projectRoot,
    name: appName,
    platform: 'darwin',
    arch: 'arm64',
    out: outDir,
    overwrite: true,
    asar: false,
    appBundleId: 'com.ingridxi.agents',
    appVersion: '0.1.0',
    appCopyright: 'Copyright © 2026 Ingrid Xi',
    appCategoryType: 'public.app-category.productivity',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    extendInfo: extendInfoPath,
    // 排除不需要打包进应用的目录（其余 skills/scripts/extensions/docs 等运行时都要用，保留）
    ignore: [
      /(^|\/)\.git(\/|$)/,
      /(^|\/)dist(\/|$)/,
      /(^|\/)build(\/|$)/,
      /(^|\/)__pycache__(\/|$)/,
      /(^|\/)\.workbuddy(\/|$)/,
      /(^|\/)\.gitignore$/,
    ],
    prune: true,
    // 不在 packager 里签名（其 adhoc 签名易因 identityValidation 失败），打包后统一用 @electron/osx-sign 签
  });

  const built = path.join(appPaths[0], appName + '.app');
  console.log('打包完成:', built);

  // adhoc 签名（identityValidation: false 才能用 '-' 表示 adhoc），保证 TCC 身份稳定为 com.ingridxi.agents
  const { sign } = require('@electron/osx-sign');
  await sign({ app: built, identity: '-', identityValidation: false });
  console.log('已 adhoc 签名:', built);

  // 复制到 ~/Applications 与 ~/Desktop（覆盖旧的 shell 壳 app）
  const home = os.homedir();
  const targets = [
    path.join(home, 'Applications', appName + '.app'),
    path.join(home, 'Desktop', appName + '.app'),
  ];
  for (const t of targets) {
    fs.rmSync(t, { recursive: true, force: true });
    fs.cpSync(built, t, { recursive: true });
    console.log('已复制:', t);
  }
  console.log('完成。');
}

main().catch((e) => {
  console.error('打包失败:', e);
  process.exit(1);
});
