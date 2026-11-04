# 3d-slide · Docker 本地环境

本地开发用 Docker Compose 运行 MinIO（开源 S3 兼容对象存储）。二进制内容（图片、音视频、模型、普通文件）存放在 MinIO，作品与元数据存放在 `data/` 目录。

## 1. 服务与端口

| 组件 | 端口 | 作用 | 启动方式 |
| --- | --- | --- | --- |
| MinIO API | 9000 | S3 接口，后端用它上传 / 下载对象 | `npm run minio` |
| MinIO Console | 9001 | 网页控制台，查看桶与对象 | 随容器启动 |
| 后端 API | 8787 | 账号、数据隔离、文件服务；启动时自动拉起 MinIO | `npm run server` |
| Vite 开发服务器 | 5176 | 前端，`/api` 代理到 8787 | `npm run dev` |

> Vite 默认只监听 `localhost`（即 `::1`）。请用 `http://localhost:5176` 访问，`127.0.0.1:5176` 可能连不上。

## 2. 首次准备

### 2.1 启动 Docker Desktop

安装并打开 Docker Desktop，等待引擎状态变为 running，然后确认：

```bash
docker info --format '{{.ServerVersion}} / {{.OperatingSystem}}'
```

能打印版本号即就绪。若提示 `open //./pipe/docker_engine: The system cannot find the file specified`，说明守护进程未启动，重新打开 Docker Desktop 后再试。

### 2.2 拉取 MinIO 镜像

镜像只需下载一次，之后直接使用本地缓存：

```bash
docker pull minio/minio:latest
```

如果无法直连 Docker Hub（表现为 `Client.Timeout exceeded while awaiting headers`），可临时使用一个可访问的镜像站拉取，再打回 compose 中使用的镜像名，无需修改 `docker-compose.yml`：

```bash
docker pull <mirror-host>/minio/minio:latest
docker tag <mirror-host>/minio/minio:latest minio/minio:latest
```

> 镜像站地址请自行选择，不要写进仓库或共享文档；部分镜像站会对特定仓库返回 `denied`，换一个可用前缀即可。

### 2.3 启动容器

在项目根目录执行：

```bash
npm run minio        # 等价于 docker compose up -d
docker compose ps    # 应看到 3d-slide-minio 处于 running
```

### 2.4 连通性自检

```bash
curl http://127.0.0.1:9000/minio/health/live   # 200 即健康
curl http://127.0.0.1:8787/api/health          # 返回体中 minio.ok 应为 true
```

后端首次连接时会自动创建 `3d-slide` 桶，无需手动建桶。

## 3. 日常启动与停止

MinIO 不需要单独启动。后端启动时会检测 `127.0.0.1:9000`，不可用则异步执行 `docker compose up -d minio` 并轮询等待就绪；期间 HTTP 服务照常可用，文件上传会在就绪后自动恢复。设置环境变量 `MINIO_AUTO_START=false` 可关闭该行为。

```bash
# 启动全部服务（后端 + Vite，MinIO 随后端自动拉起）
npm run dev

# 停止旧进程并重启全部服务（端口被占用或改配置后最快恢复）
npm run restart

# 只起前端（自行保证后端在跑）
npm run dev:web

# 查看 MinIO 日志 / 停止容器
docker compose logs -f 3d-slide-minio
docker compose stop minio        # 停止容器，保留容器与数据
docker compose down              # 删除容器与网络，数据仍在 ./data/minio
```

> `npm run restart` 会读取 `.run/dev.json` 中的 PID 结束上一轮服务，再兜底清理 8787 / 5176 端口。Ctrl+C 只停应用服务，MinIO 容器会继续运行（`restart: unless-stopped`）。

## 4. 数据持久化

| 位置 | 内容 | 删除影响 |
| --- | --- | --- |
| `data/minio/` | 桶 `3d-slide` 的全部对象，按 `users/<userId>/assets/<id>`、`users/<userId>/files/<id>` 组织 | 清空所有上传内容 |
| `data/users/` | 每个账号的作品、封面、资源元数据、文件夹结构 | 清空账号数据 |
| `data/accounts/`、`data/sessions.json` | 账号与登录会话 | 所有账号需重新注册 |

```bash
# 备份：先停服务，再把 data 目录整体复制到备份位置
# Windows 可用：Copy-Item -Recurse data backup-data
docker compose stop minio
cp -r data backup-data

# 彻底重置（会丢失所有上传对象）
docker compose down
rm -rf data/minio
```

> `data/` 已在 `.gitignore` 中忽略，不要提交对象数据。`docker compose down -v` 只删命名卷，本项目使用绑定挂载，清空仍需处理 `data/minio`。

## 5. 常见问题

**docker daemon is not running**

Docker Desktop 未启动或仍在初始化。打开并等待引擎就绪，可用以下命令检查：

```bash
Get-Service com.docker.service
wsl -l -v
docker info
```

**registry-1.docker.io 连接超时**

Docker Hub 不可达。按 2.2 用镜像站拉取后重打标签；也可在 Docker Desktop 的 Docker Engine 配置中加入 `registry-mirrors` 后重启引擎。

**镜像站提示 denied**

部分镜像站会屏蔽某些仓库，换一个可用前缀重试。

**端口 9000 / 9001 被占用**

```bash
docker ps -a --filter name=3d-slide-minio
docker compose down
Get-NetTCPConnection -LocalPort 9000,9001 -State Listen
```

**EADDRINUSE（8787 或 5176）**

已有另一轮服务在运行，执行 `npm run restart` 让脚本接管：结束旧进程、释放端口、重新启动全部服务。

**上传返回 503**

MinIO 不可用时文件接口返回 503 而非伪装成功。按 2.4 确认容器与桶状态后重试。

## 6. 配置与生产提示

后端通过环境变量连接对象存储，取值与 `docker-compose.yml` 保持一致：

```bash
MINIO_ENDPOINT=127.0.0.1
MINIO_PORT=9000
MINIO_USE_SSL=false
MINIO_ACCESS_KEY=<your-access-key>
MINIO_SECRET_KEY=<your-secret-key>
MINIO_BUCKET=3d-slide
MINIO_AUTO_START=true      # false 表示不随应用自动拉起
```

- 不要把真实的 access key / secret key 写进仓库、文档或截图，使用本地环境变量或未提交的 `.env` 文件注入。
- 本地默认凭据仅用于开发，部署到共享或生产环境前必须替换。
- 生产环境建议：使用独立密钥、关闭匿名访问、桶保持私有、把对象存储放到独立磁盘或托管对象存储服务，并按第 4 节定期备份 `data/`。
