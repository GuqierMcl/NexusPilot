import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { spawnSync } from 'child_process';

const pkgPath = path.resolve('package.json');
const pkgData = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
const version = pkgData.version;

console.log(`🚀 同步主版本号: v${version} 到各个子模块...`);

function writeTextFile(filePath, content) {
  fs.writeFileSync(filePath, content);
}

function replaceRequired(content, pattern, replacement, label) {
  if (!pattern.test(content)) {
    throw new Error(`未找到可更新的版本字段：${label}`);
  }

  return content.replace(pattern, replacement);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    ...options,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`命令执行失败：${command} ${args.join(' ')}`);
  }
}

const skipConfirm = process.argv.includes('--yes');

function doSync() {
  const tauriConfPath = path.resolve('src-tauri/tauri.conf.json');
  let tauriConf = JSON.parse(fs.readFileSync(tauriConfPath, 'utf-8'));
  tauriConf.version = version;
  writeTextFile(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
  console.log(`✅ 已更新 src-tauri/tauri.conf.json -> ${version}`);

  const cargoPath = path.resolve('src-tauri/Cargo.toml');
  let cargoStr = fs.readFileSync(cargoPath, 'utf-8');
  cargoStr = replaceRequired(
    cargoStr,
    /version\s*=\s*"[^"]+"/,
    `version = "${version}"`,
    'src-tauri/Cargo.toml',
  );
  writeTextFile(cargoPath, cargoStr);
  console.log(`✅ 已更新 src-tauri/Cargo.toml -> ${version}`);

  const aiRuntimePackagePath = path.resolve('ai-runtime/package.json');
  if (fs.existsSync(aiRuntimePackagePath)) {
    const aiRuntimePackage = JSON.parse(fs.readFileSync(aiRuntimePackagePath, 'utf-8'));
    aiRuntimePackage.version = version;
    writeTextFile(aiRuntimePackagePath, JSON.stringify(aiRuntimePackage, null, 2) + '\n');
    console.log(`✅ 已更新 ai-runtime/package.json -> ${version}`);
  }

  const cargoCommand = process.platform === 'win32' ? 'cargo.exe' : 'cargo';
  run(cargoCommand, ['generate-lockfile'], { cwd: path.resolve('src-tauri') });
  console.log('✅ 已刷新 src-tauri/Cargo.lock');

  console.log('🎉 所有版本号同步完成！');
}

if (skipConfirm) {
  doSync();
} else {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('确认同步？(y/N) ', (answer) => {
    rl.close();
    if (answer.trim().toLowerCase() !== 'y') {
      console.log('❌ 已取消同步。');
      process.exit(0);
    }
    doSync();
  });
}
