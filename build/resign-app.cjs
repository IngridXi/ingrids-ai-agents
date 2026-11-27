/**
 * 对已存在的 .app 用自签名证书从内到外重签（不重新打包）。
 *
 * 为什么需要它：
 *   sync-to-app.sh 用 rsync 覆盖 Contents/Resources/app 里的代码文件后，会破坏
 *   app 的签名 seal（资源文件内容变了，但签名里的资源哈希没更新），导致
 *   codesign --verify 失败、macOS 把 app 视为「签名无效」→ 钥匙串(safeStorage)
 *   与 TCC 授权失效 → 反复弹密码/授权。
 *
 *   所以 sync-to-app.sh 在 rsync 之后必须调用本脚本重签，恢复签名有效性。
 *   同时，自签名证书的 DR 基于 certificate root（稳定），重签后身份不变，
 *   已有的授权不会失效。
 *
 * 用法：node build/resign-app.cjs [app路径]
 * 默认路径：~/Applications/Ingrid's AI Agents.app
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const appBundleId = 'com.ingridxi.agents';
// 自签名代码签名证书（Common Name）。不能用 adhoc（--sign -）：adhoc 的 DR 基于
// cdhash（内容哈希），每次内容变化身份就变 → 授权失效 → 反复弹密码。
const SIGN_ID = 'Ingrids AI Agents Signing';

function cs(app) {
  execFileSync('codesign', ['--force', '--sign', SIGN_ID, app], { stdio: 'pipe' });
}
function csDeep(app) {
  execFileSync('codesign', ['--force', '--deep', '--sign', SIGN_ID, app], { stdio: 'pipe' });
}
function setBundleId(plist, id) {
  if (!fs.existsSync(plist)) return;
  execFileSync('plutil', ['-replace', 'CFBundleIdentifier', '-string', id, plist], { stdio: 'pipe' });
}

/** 删除悬空符号链接（如 node_modules/.bin 下指向被排除 electron/@electron 的链接）。
 *  否则 codesign 签名 seal 会把悬空链接记录进去，verify 时 stat 目标失败 → "No such file or directory"。 */
function removeDanglingSymlinks(app) {
  const appRoot = path.join(app, 'Contents', 'Resources', 'app');
  if (!fs.existsSync(appRoot)) return 0;
  let removed = 0;
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        try { fs.statSync(p); } catch (err) { fs.unlinkSync(p); removed++; }
      } else if (e.isDirectory()) {
        walk(p);
      }
    }
  })(appRoot);
  return removed;
}

/** 从内到外用自签名证书重签（与 build/build-app.cjs 的 signElectronApp 一致） */
function signElectronApp(app) {
  const fw = path.join(app, 'Contents', 'Frameworks');

  // 1) 统一 bundle ID 到 com.ingridxi.agents.*（幂等，已设置则覆盖为相同值）
  setBundleId(path.join(fw, 'Electron Framework.framework', 'Versions', 'A', 'Resources', 'Info.plist'), appBundleId + '.framework');
  for (const f of ['Squirrel', 'Mantle', 'ReactiveObjC']) {
    setBundleId(path.join(fw, f + '.framework', 'Versions', 'A', 'Resources', 'Info.plist'), appBundleId + '.' + f.toLowerCase());
  }

  // 2) Electron Framework：内层二进制 → dylib → crashpad → bundle
  const efBin = path.join(fw, 'Electron Framework.framework', 'Versions', 'A', 'Electron Framework');
  if (fs.existsSync(efBin)) cs(efBin);
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

function main() {
  const target = process.argv[2] || path.join(os.homedir(), 'Applications', "Ingrid's AI Agents.app");
  if (!fs.existsSync(target)) {
    console.error('❌ 未找到 app:', target);
    process.exit(1);
  }

  const removed = removeDanglingSymlinks(target);
  if (removed > 0) console.log('🧹 清理悬空符号链接:', removed, '个');

  signElectronApp(target);
  execFileSync('codesign', ['--verify', '--deep', '--strict', target], { stdio: 'pipe' });
  console.log('✅ 重签 + 验证通过:', target);

  try {
    const dr = execFileSync('codesign', ['-d', '-r-', target], { stdio: 'pipe' }).toString();
    const line = dr.split('\n').filter((l) => l.includes('designated'));
    console.log(line.join('\n').trim());
  } catch (e) {
    /* 非致命：仅打印 DR 失败不影响签名结果 */
  }
}

main();
