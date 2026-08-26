# Release Guide

本文档描述 NexusPilot 桌面应用发布流程。发布相关任务应优先使用根目录脚本：

```bash
bun run release help
bun run release doctor
```

发布流程采用本地半自动模式：私钥和对象存储密钥保留在本机，脚本负责版本同步、CHANGELOG 轮转、Tauri 构建、产物归档、公开发布索引生成和 MinIO/S3-compatible 上传。

## 核心原则

发布产物分为两类，职责不能混淆：

| 类型 | 原则 | 示例 |
| --- | --- | --- |
| 本地版本归档 | 每个版本的完整发布素材快照，不能互相覆盖。`collect` 只写入 `releases/vX.Y.Z/`。 | `releases/v0.4.1/index.json`、`releases/v0.4.1/latest.json`、`releases/v0.4.1/notes.md`、安装包和签名 |
| 远端公开入口 | 给 updater / 官网读取的当前指针，可以覆盖。`publish` 从当前版本目录提升上传。 | `https://dl.nexuspilot.dev/releases/index.json`、`https://dl.nexuspilot.dev/releases/latest.json` |

也就是说，本地 `releases/` 根目录不生成会被下一次 `collect` 覆盖的 `index.json` 或 `latest.json`。根入口只存在于对象存储，用来服务官网、文档站和 Tauri updater。

## 事实来源

| 文件或目录 | 职责 |
| --- | --- |
| `CHANGELOG.md` | 人类可读的发布说明源。发布时从 `[Unreleased]` 轮转到当前版本。 |
| `.env.release.local` | 本机发布密钥和对象存储配置。不得提交。 |
| `.env.release.example` | 可提交的发布环境模板。 |
| `releases/vX.Y.Z/` | 本地版本化发布产物归档目录。已 git ignore。 |
| `releases/vX.Y.Z/index.json` | 本次发布时刻的公开发布索引快照，包含 latest 指针、历史版本、下载项和 `notesUrl`。 |
| `releases/vX.Y.Z/latest.json` | 本次发布生成的 Tauri updater manifest 快照。 |
| `releases/vX.Y.Z/notes.md` | 当前版本用户可见 Markdown 更新日志。官网、文档站和应用“关于”页都可以渲染它。 |
| `releases/vX.Y.Z/checksums.sha256` | 当前版本安装包和签名文件的 SHA-256 校验清单。 |
| 远端 `releases/index.json` | 官网首页、官网发布日志和文档站发布日志读取的当前公开索引。发布时由 `releases/vX.Y.Z/index.json` 覆盖上传。 |
| 远端 `releases/latest.json` | Tauri updater 读取的当前更新指针。发布时由 `releases/vX.Y.Z/latest.json` 最后覆盖上传。 |

不要手写根目录 `latest.json` 或 `index.json` 作为发布事实来源。当前版本的事实来源始终是 `CHANGELOG.md` 和 `releases/vX.Y.Z/` 里的版本快照。

## 环境配置

首次使用前复制模板：

```bash
Copy-Item .env.release.example .env.release.local
```

关键配置：

```dotenv
TAURI_SIGNING_PRIVATE_KEY=<path-to-signing-key>
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=

RELEASE_OUTPUT_DIR=releases
RELEASE_PUBLIC_BASE_URL=https://dl.nexuspilot.dev/releases

RELEASE_S3_ENDPOINT=http://127.0.0.1:9000
RELEASE_S3_REGION=us-east-1
RELEASE_S3_BUCKET=nexuspilot
RELEASE_S3_PREFIX=releases
RELEASE_S3_ACCESS_KEY_ID=change-me
RELEASE_S3_SECRET_ACCESS_KEY=change-me
RELEASE_S3_FORCE_PATH_STYLE=true

RELEASE_UPDATER_PLATFORM=windows-x86_64
RELEASE_UPDATER_ARTIFACT=nsis
```

`RELEASE_PUBLIC_BASE_URL` 必须和 Tauri updater endpoint 同域同路径前缀。当前 Tauri 配置读取 `https://dl.nexuspilot.dev/releases/latest.json`，因此公开下载、官网索引和应用内更新日志都应使用 `https://dl.nexuspilot.dev/releases` 作为 public base URL。

`RELEASE_S3_PREFIX` 是对象存储中的真实 key 前缀。如果反向代理把 `dl.nexuspilot.dev/releases/*` 映射到不同的 bucket prefix，请以实际对象存储映射为准，但生成出的公开 URL 仍应匹配 `RELEASE_PUBLIC_BASE_URL`。

新的构建产物、发布清单、官网和文档只生成 `nexuspilot.dev` 及其子域名的 URL。`assets.nexuspilot.dev` 仅承载 Logo、隐私协议等公共静态资源，不参与发布和自动更新。

`TAURI_SIGNING_PRIVATE_KEY` 推荐填写私钥文件路径。脚本会读取该文件内容并通过环境变量传给 Tauri CLI。`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 是可选项：如果创建 signing key 时跳过了密码，保持为空即可，`doctor` 会显示警告但不会阻塞发布。MinIO 通常需要 `RELEASE_S3_FORCE_PATH_STYLE=true`。

## CHANGELOG 写法

发布前把用户可见变化写入 `CHANGELOG.md` 的 `[Unreleased]`：

```md
## [Unreleased]

### Feature

- 新增某项能力。

### Optimization

- 优化某个工作流。

### Fixed

- 修复某个问题。
```

脚本生成 updater notes 和 `notes.md` 时会把 NexusPilot 发布分类转换成面向用户的文案：

| CHANGELOG 分类 | 展示 |
| --- | --- |
| `Feature` | `✨ 新功能` |
| `Optimization` | `⚡ 优化` |
| `Fixed` | `🐛 修复` |

常规发布记录只使用 `Feature`、`Optimization` 和 `Fixed` 三类。脚本仍兼容历史 `Added` / `Changed` 分类，生成展示文案时会分别按 `Feature` / `Optimization` 展示。

`prepare` 会拒绝轮转空的 `[Unreleased]`。发版前至少需要在一个分类下写入一条 release-note item，避免生成空更新日志。

## 本地手工发布流程

```bash
bun run release doctor
# 编辑 CHANGELOG.md 的 [Unreleased]，至少写入一条 release-note item
bun run release prepare patch
bun run release build
bun run release collect
bun run release publish --dry-run
bun run release publish
bun run release finalize
git push --follow-tags
```

这条本地流程继续保留，面向维护者在本机准备并发布当前 Windows 产物；它不由 GitHub Actions 调用，也不会读取 CI 的 Artifact。

说明：

1. `doctor` 检查工具、环境文件、对象存储配置、版本同步和 CHANGELOG 状态。
2. `prepare` bump 或设置版本号，刷新 lockfile，同步 Tauri/Rust/AI Runtime 版本，并把 `[Unreleased]` 轮转成当前版本。
3. `build` 读取 `.env.release.local`，运行前端/AI Runtime 验证，并执行签名 Tauri production build。
4. `collect` 从 `src-tauri/target/release/bundle/` 复制当前版本产物到 `releases/vX.Y.Z/`，并在该版本目录内生成 `index.json`、`latest.json`、`notes.md` 和 `checksums.sha256`。
5. `publish --dry-run` 打印将要上传的 MinIO/S3 对象路径，不写入远端。
6. `publish` 先上传完整版本目录，再把当前版本的 `index.json` 提升为远端根入口，最后把当前版本的 `latest.json` 提升为远端 updater 入口。
7. `finalize` 提交源文件变更并创建 `vX.Y.Z` tag。生成产物目录仍保持 git ignored。

可选检查：`prepare` 后可以运行 `git diff` 快速确认版本号和 CHANGELOG 轮转是否符合预期，但它不是标准流程中的强制步骤。

## 版本准备命令

稳定版本：

```bash
bun run release prepare patch
bun run release prepare minor
bun run release prepare major
```

预发布版本：

```bash
bun run release prepare prerelease --preid beta
bun run release prepare preminor --preid alpha
```

显式版本：

```bash
bun run release prepare 0.4.2
```

## GitHub Actions 跨平台发布流程

`.github/workflows/desktop-s3-release.yml` 是独立的 CI 发布通道：每次推送匹配 `v*` 的 tag，都会自动构建四个平台产物，并在全部构建成功后发布到对象存储。workflow 另外提供 `workflow_dispatch` 的 `publish_only` 恢复模式，用于复用已有 run 的 artifacts 只执行最终发布 job。

CI 与本地手工发布脚本拥有独立的构建和发布实现：CI **不得**执行 `bun run release build`、`collect` 或 `publish`。这样本机密钥、目录和 Windows-only 历史归档逻辑不会成为 CI 的隐式前置条件。使用 CI 自动发布时，维护者应执行 `prepare`、`finalize` 和 `git push --follow-tags`，但不得再为同一版本执行本地 `build`、`collect` 或 `publish`，避免两个发布者同时写入同一个对象存储版本目录。

发布前的 `Verify release source` job 只执行前端与 AI Runtime 类型检查，以及 `scripts/github-release/` 的发布器测试；它不执行 AI Runtime 全量单元测试。AI Runtime 的全量测试继续由常规 CI 或本地开发验证负责，避免非发布关键测试阻塞跨平台安装包构建。

当四个平台构建已经成功、但最终 publish job 失败时，可以使用恢复模式避免重新构建：

```bash
gh workflow run desktop-s3-release.yml \
  --ref main \
  -f publish_only=true \
  -f release_tag=vX.Y.Z \
  -f artifact_run_id=<构建成功的 workflow run ID>
```

`artifact_run_id` 必须指向 artifacts 尚未过期且四个平台 package job 均成功的 run；恢复模式会从该 run 下载产物，并仍然使用 `release` Environment 执行对象存储发布。

GitHub Actions 在标准 GitHub-hosted runner 上原生构建以下四个正式发布目标，不需要 self-hosted runner：

| 平台与架构 | Runner | 手动下载安装包 | Tauri updater 产物 |
| --- | --- | --- | --- |
| Linux x64 | `ubuntu-24.04` | `deb`、`rpm` | DEB + `.sig`、RPM + `.sig` |
| Windows x64 | `windows-2022` | `nsis` | NSIS `.exe` + `.sig` |
| macOS Intel | `macos-15-intel` | `dmg` | `.app.tar.gz` + `.sig` |
| macOS Apple Silicon | `macos-14` | `dmg` | `.app.tar.gz` + `.sig` |

每个 job 都原生编译 Bun `ai-runtime` sidecar。不得把 x64 构建产物复制给 Apple Silicon job，也不得把交叉编译得到的 Tauri 主程序与 host 架构 sidecar 混包。GitHub-hosted macOS ARM64 runner 有部分社区 action 兼容性限制；本 workflow 使用的 Actions 官方 action 与 Bun/Rust 安装步骤均可运行在 ARM64。

CI 使用两组独立于本地 `.env.release.local` 的 GitHub Secrets：

- 以下 Tauri 签名 Secrets 是 **repository Actions secrets**，因为四个 packaging job 都需要生成对应平台的 updater 签名；
- 以下 `CI_RELEASE_*` Secrets 仅放入 GitHub Environment `release`，最终 publish job 在四个平台构建均成功后自动运行并读取对象存储凭据。若该 Environment 配置了 required reviewers，job 会先等待审批，再继续发布。

```text
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD          # 无密码私钥可留空

# 仅 GitHub Environment `release`：
CI_RELEASE_PUBLIC_BASE_URL                  # https://dl.nexuspilot.dev/releases
CI_RELEASE_S3_ENDPOINT
CI_RELEASE_S3_REGION                        # 可留空，默认 us-east-1
CI_RELEASE_S3_BUCKET
CI_RELEASE_S3_PREFIX                        # 通常为 releases
CI_RELEASE_S3_ACCESS_KEY_ID
CI_RELEASE_S3_SECRET_ACCESS_KEY
CI_RELEASE_S3_FORCE_PATH_STYLE              # MinIO 通常为 true
```

CI 会生成 `notes.md`、`checksums.sha256`、跨四个原生 target 的 `index.json` 与 Tauri `latest.json`。`latest.json` 包含五个 updater key：`linux-x86_64-deb`、`linux-x86_64-rpm`、`windows-x86_64`、`darwin-x86_64` 和 `darwin-aarch64`。上传顺序固定为：先完整上传 `releases/vX.Y.Z/**`，再更新根 `releases/index.json`，最后更新根 `releases/latest.json`。因此官网和自动更新端点始终使用既有 `https://dl.nexuspilot.dev/releases`，不依赖 GitHub Release Asset。

CI 发布器对不超过 8 MiB 的文件使用 `PutObject`，更大的文件优先使用 8 MiB 分片的 S3 multipart upload；若对象存储网关或凭据不支持 multipart，会回退为带明确 `ContentLength` 的 Buffer `PutObject`。上传后优先使用 `HeadObject` 校验；若网关对 multipart 对象的 `HeadObject` 返回 403，则用 `ListObjectsV2` 按 key 和文件大小校验。每次上传及校验最多尝试 4 次，使用带抖动的指数退避，失败的 multipart upload 会主动 abort。仅网络瞬断、HTTP 408/429、服务端 5xx、限流和 SDK 标记为可重试的错误会重试；认证、权限、配置、签名和发布内容校验错误会立即失败。

`index.json` 公开用户手动下载安装的 NSIS、DMG、DEB、RPM 文件。Linux 的 DEB 与 RPM 同时也是各自安装类型的 updater payload；macOS `.app.tar.gz` 是 updater payload，仍会上传和校验，但不作为官网主下载项展示。

Linux job 在单一 `tauri.conf.json` 的基础上，仅对此次构建覆盖 `bundle.createUpdaterArtifacts=false`；这是因为 Tauri 的自动 updater artifact 在 Linux 只为 AppImage 生成。随后 CI 用相同的 Tauri signing key 分别为 DEB 与 RPM 执行 `tauri signer sign`。Linux updater 不使用通用的 `linux-x86_64` key。已通过 DEB 安装的客户端只会匹配 `linux-x86_64-deb` 并下载 DEB；已通过 RPM 安装的客户端只会匹配 `linux-x86_64-rpm` 并下载 RPM，避免跨包格式更新。系统级安装会通过 `pkexec`、图形化授权或 `sudo` 请求用户授权，这是 Linux 包管理器更新所需的正常行为。

## 产物目录

本地手工发布当前会归档 Windows 产物为：

```text
releases/
  v0.4.1/
    index.json
    latest.json
    notes.md
    checksums.sha256
    windows-x86_64/
      NexusPilot_0.4.1_x64-setup.exe
      NexusPilot_0.4.1_x64-setup.exe.sig
      NexusPilot_0.4.1_x64_en-US.msi
      NexusPilot_0.4.1_x64_en-US.msi.sig
    logs/
```

`index.json` 是“发布到 v0.4.1 时刻的公开索引快照”，不是单版本 manifest。它可以包含完整历史版本列表，并把 `latest` 指向 `v0.4.1`。后续发布 `v0.4.2` 时，会生成新的 `releases/v0.4.2/index.json`，不会覆盖 `v0.4.1` 的快照。

本地脚本内部可继续预留其他平台目录位。跨平台 CI 发布使用 `linux-x86_64`、`windows-x86_64`、`darwin-x86_64`、`darwin-aarch64` 四个目录。

## 上传顺序

`publish` 必须遵循：

1. 上传 `releases/vX.Y.Z/**` 到远端 `releases/vX.Y.Z/**`，包括安装包、签名、`notes.md`、`checksums.sha256`、`index.json` 和 `latest.json`。
2. 对每个上传对象执行 HEAD 校验。
3. 把 `releases/vX.Y.Z/index.json` 上传到远端 `releases/index.json`。
4. 最后把 `releases/vX.Y.Z/latest.json` 上传到远端 `releases/latest.json`。

这样可以保证官网和文档站看到新版本时，版本化安装包和发布日志已经存在；也可以避免用户在安装包尚未上传完成时，通过 updater 看到新版本。

安装包等大产物会按分片上传；进度表示对象存储已确认的分片大小，而不是本地文件读取进度。

缓存策略：

- 远端 `releases/vX.Y.Z/**` 是版本化文件，使用 `Cache-Control: public, max-age=31536000, immutable`。
- 远端 `releases/index.json` 和 `releases/latest.json` 是可变入口，使用 `Cache-Control: no-cache`。

## 官网、文档站和应用内日志

官网和文档站通过公开发布索引自动同步，不在 `sites/product/` 或 `sites/docs/` 中维护发布后的第二份主要事实来源。

运行时读取：

```text
官网首页下载区
  -> https://dl.nexuspilot.dev/releases/index.json

官网 /releases
  -> https://dl.nexuspilot.dev/releases/index.json
  -> 按版本读取 notesUrl，例如 /releases/v0.4.1/notes.md

文档站 /docs/releases
  -> https://dl.nexuspilot.dev/releases/index.json
  -> 按版本读取 notesUrl，只展示日志，不展示下载按钮

应用设置 - 关于
  -> Rust command: get_current_release_notes
  -> 从 tauri.conf.json 的 plugins.updater.endpoints[0] 派生 public base URL
  -> 按当前安装版本读取本地 cache/release-notes/v{当前版本}.md
  -> cache miss 时由 Rust 通过 Tauri HTTP plugin 请求 {publicBaseUrl}/v{当前版本}/notes.md
  -> 请求成功后写入缓存并返回给前端渲染
```

应用内当前版本日志不在前端硬编码发布域名，也不由前端直接发起 `notes.md` 请求。前端通过 `get_current_release_notes` 读取 Rust 返回的当前安装版本日志；Rust 从 Tauri updater endpoint 派生 public base URL，并按版本缓存 `notes.md`。这样 `src-tauri/tauri.conf.json` 中的 updater endpoint 同时约束自动更新和应用内发布日志地址，避免二者配置漂移。

远端公开数据加载期间，官网和文档站显示加载态；加载失败时显示明确错误提示，不展示旧版本 fallback，避免把过期版本误认为最新版。`sites/product/` 与 `sites/docs/` 不应直接读取根目录 `package.json`、Tauri 配置、release 脚本或非发布用途的内部文档。

官网 `/releases` 可以展示各版本的可用下载项，并按平台和安装包类型区分，例如 Windows x64 / NSIS、macOS Apple Silicon / DMG、Linux x64 / DEB。文档站 `/docs/releases` 只展示发布日志，不提供下载按钮。发布日志正文优先使用版本目录下的 `notes.md` 作为 Markdown 内容渲染；`index.json` 中的结构化字段主要用于摘要、索引、下载项和链接。

应用“关于”页展示的是“当前已安装版本”的发布日志，因此必须根据本地安装版本读取 `v{当前版本}/notes.md`，不能读取 `index.json.latest`，否则用户在远端已有更新时会误看到最新版本日志。由于版本化 `notes.md` 是发布快照，缓存可以按版本长期复用；后续如需临时修正文案，再单独引入强制刷新入口。

## 常见问题

### `doctor` 提示 `.env.release.local: missing`

复制模板并填写本地值：

```bash
Copy-Item .env.release.example .env.release.local
```

### `build` 提示缺少 `TAURI_SIGNING_PRIVATE_KEY`

确认 `.env.release.local` 中存在 `TAURI_SIGNING_PRIVATE_KEY`。如果填写的是路径，确认该路径存在并可读。

### `collect` 提示没有找到 Tauri artifacts

先运行：

```bash
bun run release build
```

确认 `src-tauri/target/release/bundle/nsis/` 下存在当前版本的 `NexusPilot_X.Y.Z_x64-setup.exe` 和 `.sig` 文件。

### `publish` 失败

先使用 dry-run 检查对象路径：

```bash
bun run release publish --dry-run
```

再确认 MinIO endpoint、bucket、access key、secret key、prefix 和 path-style 配置。

### MinIO 中出现 `vX.Y.Z` 文件而不是目录

这是早期 publish key 生成问题导致的一次性错误对象，不属于标准发布流程。标准流程会把安装包上传到 `vX.Y.Z/windows-x86_64/` 下，但不会默认删除对象存储中的历史错误对象。

如果遇到该问题，请先使用 dry-run 确认当前脚本生成的对象 key 已经正确：

```bash
bun run release publish --dry-run
```

如果 MinIO bucket 启用了 versioning，只删除当前可见的 `vX.Y.Z` 对象可能还不够。历史版本中的 `releases/vX.Y.Z` 文件对象仍可能影响 Web Console 的虚拟目录展示，使 `releases/vX.Y.Z/` 看起来没有出现。此时需要在 MinIO Web Console 中打开对象历史版本，删除 `releases/vX.Y.Z` 这个文件对象的全部历史版本；不要删除 `releases/vX.Y.Z/` 前缀下的安装包、签名和 manifest 文件。

发布脚本不会默认批量删除历史版本，因为这属于破坏性对象存储操作。确认对象路径时，以 `publish --dry-run` 打印的 key 和安装包直链是否可访问为准。
