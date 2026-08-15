# dsh-lan-proxy

<p align="center">
  把 dsh 只监听回环地址的 Web UI 通过 <code>0.0.0.0</code> 反代暴露到局域网；
  开关、状态与启动日志直接嵌入 dsh 设置页「插件」区，随 dsh 启停，无需单独进程。
</p>

## 功能

| 能力 | 说明 |
| --- | --- |
| 局域网反代 | 将 dsh Web UI 同时监听 `0.0.0.0:<port>`，局域网内任何设备经 `http://<局域网IP>:<port>/` 访问 |
| 免配置开关 | 设置页「插件」区「局域网反代」tab 一键开关，即时热启停，无需重启 dsh |
| 端口配置 | tab 内直接修改监听端口与上游端口，保存即生效 |
| 协议适配 | 自动改写 Host/Origin 为回环、桥接 WebSocket（RFC6455 帧编解码）、注入 `crypto.randomUUID` polyfill（局域网 HTTP 非安全上下文缺失） |
| 状态与日志 | 2 秒轮询的运行状态、上游可达性探测、局域网地址列表与启动日志，内置「重启反代」按钮 |

## 界面预览

设置页「局域网反代」面板（监听已开启时）：

![局域网反代设置面板](docs/preview/settings-tab.png)

## 安装

```bash
dsh plugin --profile web add "github:liveqte/dsh-lan-proxy#main"
```

bundle 层栈在启动时组合，装完**重启 dsh web** 生效。验证：设置页「插件」区出现
「局域网反代」tab，启动日志无 `plugin tree failed to load`。

## 使用

- **开关**：设置页 →「插件」→「局域网反代」tab，切换「监听局域网访问」。
  页面开关的即时状态写入运行时文件（`$DSH_HOME/profiles/web/lan-proxy.runtime.json`，
  优先级高于配置默认值），立即生效。
- **局域网访问**：`http://<局域网IP>:<监听端口>/`。
- **端口**：tab 内可直接修改监听端口（所有网卡）与上游端口
  （`127.0.0.1`，`0` 表示自动取 dsh 实际监听端口）。
- 开关与端口修改接口仅限本机回环地址调用；局域网访问只读状态与日志。

## 配置项

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `false` | 监听局域网访问（配置默认值；页面开关优先级更高并持久化到运行时文件） |
| `port` | `3080` | 反代监听端口（所有网卡） |
| `upstreamPort` | `0` | 上游端口，`0` = 自动取 dsh 实际监听端口 |
| `statusPath` | `/__lan-proxy` | JSON API 前缀（设置页 tab 的数据面，保持默认即可） |
| `maxLogLines` | `500` | 页面日志缓冲行数 |

配置覆盖写在 profile 层的 `cordis.patch.yml`（`id: lan-proxy` 行的 `config`），
不需要修改仓库内文件。

## 插件管理

已装插件用 plugin-registry 的**薄控制台**管理（浏览器面板）：管理 profile 插件
安装态（bundle 层栈 + insert 行 + 启停），无需手改配置。安装：
`dsh plugin --profile web add <plugin-registry>/packages/plugin/console`