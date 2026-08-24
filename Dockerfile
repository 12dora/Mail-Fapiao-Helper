#
# 发票助手 CLI 容器镜像。
#
# 只打包 CLI（`mfh fetch / run / ocr / pending / organize`）。Electron 桌面端
# 需要图形栈，不在容器内跑——那条路请走 `npm run dist` 出安装包。
#
# 邮件、附件、配置全部走 /data 卷；镜像本身不含任何用户数据。

# ---------------------------------------------------------------------------
# builder：装全量依赖并编译 TypeScript
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# 先只拷贝清单，让依赖层可以被缓存
COPY package.json package-lock.json ./

# electron / electron-builder 只在打桌面包时才需要，Chromium 由 runtime 阶段的
# 基础镜像自带；两者的 postinstall 各要下几百 MB，容器构建里一律跳过。
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

# 等价于 `npm run build`，只是省掉 rm -rf dist（容器里本来就是空的）。
RUN npx tsc -p . \
 && printf '/** @generated for container build */\nexport const production = true;\nexport const channel = "container";\n' > dist/buildInfo.js

# ---------------------------------------------------------------------------
# runtime：Playwright 官方镜像 + 仅生产依赖
#
# 用官方镜像而不是 node-slim + `playwright install --with-deps`：后者要在构建期
# 从 deb.debian.org 装几十个 X11 库，是最容易失败也最难缓存的一步。官方镜像已经
# 把 Chromium 和它的系统依赖装在 /ms-playwright 里了。
# 版本必须与 package.json 里的 playwright 保持一致，否则浏览器版本对不上。
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.60.0-noble AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    MFH_DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY config.example.json ./config.example.json
# OCR 引擎：仓库只内置 darwin-arm64 与 windows-x86_64，上游没发 Linux 包。
# 你若自行构建了 Linux 引擎，放到 vendor/efapiao/<版本>/linux-x86_64/efapiao
# 再重新 build 就会被打进来；否则容器内 OCR 会退化到 PATH 上的 `efapiao`
# （默认不存在），请把 ocr.enabled 设为 false 或改用腾讯 OCR。详见 README。
COPY vendor ./vendor

# 以非 root 运行；基础镜像自带 pwuser。/data 是唯一可写位置。
RUN mkdir -p /data && chown -R pwuser:pwuser /data /app
USER pwuser

VOLUME ["/data"]
WORKDIR /data

# 不带参数时打印用法，方便 `docker run <image>` 自检。
ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["--help"]
