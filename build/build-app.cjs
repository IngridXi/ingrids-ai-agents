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
 * 关键（血泪教训）：
 *   1) @electron/packager 的 osxSign:{identity:'-'} 会因 identityValidation 默认 true 而失败；
 *   2) @electron/osx-sign 的 sign({identity:'-'}) 只重签主程序+helper，会跳过 Electron Framework，
 *      导致 dyld 报 "mapping process and mapped file have different Team IDs" 崩溃；
 *   3) 正确做法：把 framework/次级 framework 的 CFBundleIdentifier 统一改成 com.ingridxi.agents.*，
 *      再从内到外、用同一个 adhoc 身份逐一重签，最后 codesign --verify --deep --strict 必须通过。
 *
 * 用法：node build/build-app.cjs
 * 产物：dist/Ingrid's AI Agents.app，并复制到 ~/Applications 与 ~/Desktop
 */
const { packager } = require('@electron/packager');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const projectRoot = path.resolve(__dirname, '..');
const appName = "Ingrid's AI Agents";
const appBundleId = 'com.ingridxi.agents';
const outDir = path.join(projectRoot, 'dist');

function cs(app) {
  execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'pipe' });
}
function csDeep(app) {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'pipe' });
}
function setBundleId(plist, id) {
  execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', id, plist], { stdio: 'pipe' });
}

/** 统一 bundle ID 命名空间 + 从内到外 adhoc 重签，消除 "different Team IDs" 崩溃 */
function signElectronApp(app) {
  const fw = path.join(app, 'Contents', 'Frameworks');

  // 1) 统一 bundle ID 到 com.ingridxi.agents.*（消除与主程序的组织前缀不一致）
  setBundleId(path.join(fw, 'Electron Framework.framework', 'Versions', 'A', 'Resources', 'Info.plist'), appBundleId + '.framework');
  for (const f of ['Squirrel', 'Mantle', 'ReactiveObjC']) {
    const p = path.join(fw, f + '.framework', 'Versions', 'A', 'Resources', 'Info.plist');
    if (fs.existsSync(p)) setBundleId(p, appBundleId + '.' + f.toLowerCase());
  }

  // 2) Electron Framework：内层二进制 → dylib → crashpad → bundle
  cs(path.join(fw, 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework'));
  const libs = path.join(fw, 'Electron Framework.framework', 'Versions', 'A', 'Libraries');
  if (fs.existsSync(libs)) {
    for (const f of fs.readdirSync(libs)) {
      if (f.endsWith('.dylib')) cs(path.join(libs, f));
    }
  }
  const crashpad = path.join(fw, 'Electron Framework.framework', 'Versions', 'A', 'Helpers', 'chrome_crashpad_handler');
  if (fs.existsSync(crashpad)) cs(crashpad);
  cs(path.join(fw, 'Electron Framework.framework'));

  // 3) 次级 framework：内层二进制 → bundle
  for (const f of ['Squirrel', 'Mantle', 'ReactiveObjC']) {
    const inner = path.join(fw, f + '.framework', 'Versions', 'A', f);
    if (fs.existsSync(inner)) {
      cs(inner);
      cs(path.join(fw, f + '.framework'));
    }
  }

  // 4) helper apps（deep 覆盖嵌套）
  for (const h of fs.readdirSync(fw)) {
    if (h.endsWith('.app')) csDeep(path.join(fw, h));
  }

  // 5) 主 app（最后统一封签）
  csDeep(app);
}

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
    appBundleId,
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
  });

  const built = path.join(appPaths[0], appName + '.app');
  console.log('打包完成:', built);

  signElectronApp(built);
  console.log('已 adhoc 签名并统一 bundle ID:', built);

  // 验证签名，失败则报错不继续
  execFileSync('codesign', ['--verify', '--deep', '--strict', built], { stdio: 'pipe' });
  console.log('签名验证通过 ✓');

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
