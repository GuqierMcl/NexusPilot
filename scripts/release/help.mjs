import { createStyle } from "./style.mjs";

export function getHelpText(options = {}) {
  const style = createStyle(options);
  const title = style.bold(style.cyan("NexusPilot 发布助手"));
  const flow = style.bold("典型流程");
  const commands = style.bold("命令");
  const files = style.bold("文件");
  const ci = style.bold("GitHub Actions 跨平台 CI 发布");
  const warning = style.yellow("注意");

  return `${title}

${flow}:
  1. bun run release doctor
  2. 编辑 CHANGELOG.md 的 [Unreleased]
  3. bun run release prepare <patch|minor|major|prerelease|prepatch|preminor|premajor|x.y.z>
  4. bun run release build
  5. bun run release collect
  6. bun run release publish --dry-run
  7. bun run release publish
  8. bun run release finalize
  9. git push --follow-tags

${commands}:
  help
      显示这份发布操作指南。

  doctor
      检查工具链、.env.release.local、版本同步、CHANGELOG.md 和对象存储配置。

  prepare <patch|minor|major|prerelease|prepatch|preminor|premajor|x.y.z> [--preid alpha|beta|rc]
      递增或设置根版本号，刷新 lockfile，同步版本文件，并轮转 CHANGELOG.md。

  build
      读取发布环境变量，执行带 updater 签名的 Tauri 生产构建。

  collect
      将 Tauri 构建产物复制到 releases/vX.Y.Z，并生成 index.json、
      latest.json、notes.md 和 checksums.sha256。

  publish [--dry-run]
      先上传完整版本目录，再上传远端 releases/index.json；
      远端 releases/latest.json 会最后上传。

  finalize
      stage 发布源文件，创建中文 Conventional Commit 发布提交，并创建对应 vX.Y.Z tag。

${ci}:
  CI 与以上本地构建、归档和上传流程彼此独立。CI 不会执行
  bun run release build、collect 或 publish，也不读取 .env.release.local。

  1. 编辑 CHANGELOG.md 的 [Unreleased]。
  2. bun run release prepare <patch|minor|major|prerelease|prepatch|preminor|premajor|x.y.z>
  3. bun run release finalize
  4. git push --follow-tags
  5. 推送的 v* tag（例如 v0.9.3）会自动触发 “Desktop S3 Release”。
  6. CI 完成四平台构建后，会自动发布到对象存储；在 Actions 页面监控结果。

  使用这条 CI 路径时，不要再对同一版本执行本地 release build、collect 或 publish，
  避免两个独立发布者同时写入同一个对象存储版本目录。

  CI 原生构建 Windows x64、Linux x64、macOS Intel 和 macOS Apple Silicon。
  Linux 发布 DEB、RPM；updater 按安装类型分别使用 linux-x86_64-deb 和
  linux-x86_64-rpm，系统可能要求 pkexec 或 sudo 授权。Windows 延续 NSIS .exe + .sig
  updater；macOS 使用 .app.tar.gz + .sig updater archive。所有用户下载和自动更新
  继续使用 dl.nexuspilot.dev，不使用 GitHub Release Asset。

  CI 签名使用 repository Actions secrets：TAURI_SIGNING_PRIVATE_KEY 和
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD。自动 publish job 通过 GitHub Environment “release”
  读取 CI_RELEASE_PUBLIC_BASE_URL、CI_RELEASE_S3_* 对象存储配置与访问凭据。
  本地发布变量模板见 .env.release.example。

${files}:
  CHANGELOG.md           人类可读的发布说明源。
  .env.release.local     本机签名与 MinIO/S3 密钥。不要提交这个文件。
  .env.release.example   本地发布配置模板。
  releases/vX.Y.Z        已被 git 忽略的本地发布产物归档目录。
  releases/vX.Y.Z/index.json    本次发布时刻的公开发布索引快照。
  releases/vX.Y.Z/latest.json   本次发布时刻的 Tauri updater manifest 快照。
  releases/vX.Y.Z/notes.md      当前版本用户可见 Markdown 更新日志。
  远端 releases/index.json      官网和文档站读取的当前公开发布索引。
  远端 releases/latest.json     Tauri updater 读取的当前更新入口。

${style.yellow("CHANGELOG")}: 脚本不会自动编写发布内容；发版前请先手动整理 [Unreleased]。
  prepare 只负责把 [Unreleased] 轮转成版本段落，collect 再从该版本段落生成 latest.json notes。
${style.yellow("签名密码")}: TAURI_SIGNING_PRIVATE_KEY_PASSWORD 可为空；为空时按无密码私钥处理。
${warning}: 如果终端或日志不希望显示颜色，可设置 NO_COLOR=1。
`;
}
