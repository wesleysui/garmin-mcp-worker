# Garmin MCP Worker

**在手机或电脑上，直接问 Claude 你自己的佳明数据。**

一个只读的远程 [MCP](https://modelcontextprotocol.io) 服务器，通过佳明**官方 Personal API** 把 Claude（或任何支持远程 OAuth 的 MCP 客户端）连接到你的 Garmin Connect 账号。运行在 **Cloudflare Workers** 免费额度内，用 OAuth 登录，所以 Claude 手机 App 也能用。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wesleysui/garmin-mcp-worker)

[English](README.md)

> "今天适合练间歇吗？" · "这个月 HRV 趋势怎么样？" · "对比我最近三次长距离" · "睡得少的第二天跑步有没有变差？"

---

## 和其他方案的区别

| | 官方 API | 手机可用 | 身份验证 |
|---|---|---|---|
| 本地运行的 Personal API 服务器 | ✅ | ❌ 仅电脑 | 无，不能暴露到公网 |
| 使用佳明私有登录的云端服务器 | ❌ 佳明改登录就失效 | ✅ | 不一定 |
| **本项目** | ✅ | ✅ | OAuth 2.1 + PKCE |

---

## 工具

| 工具 | 返回内容 |
|---|---|
| `garmin_get_recovery_trend` ⭐ | 每天一行：夜间 HRV（含状态和个人基线）、睡眠评分/阶段/需求、静息心率、身体电量、压力、强度分钟。问"今天能不能练强度"首选 |
| `garmin_get_day` | 某天全部数据：汇总、睡眠、HRV、身体电量、活动 |
| `garmin_get_hrv` · `garmin_get_hrv_summaries` | 单晚详情 · 最长一年的 HRV 历史 |
| `garmin_get_sleep` | 单晚睡眠详情 |
| `garmin_get_body_battery` | 身体电量报告和事件，可按小时切分 |
| `garmin_get_daily_summaries` | 原始每日健康汇总 |
| `garmin_get_heart_rate` · `garmin_get_stress` | 每日心率 · 每日压力 |
| `garmin_search_activities` | 精简活动列表：距离、配速、心率、步频、功率、爬升、训练效果、训练负荷 |
| `garmin_get_activity` | 单个活动完整数据和分段 |
| `garmin_get_profile` | 单位、时区、心率区间 |
| `garmin_api_get` | 只读调用任意 Personal API 路径 |

---

## 部署

需要 Cloudflare 免费账号，以及佳明 **Personal API 密钥**：在电脑浏览器登录 Garmin Connect，打开 [设置 → Personal API](https://connect.garmin.com/app/settings/personalApiToken)，点 **Create Key** 并复制（只显示一次，有效期最长可选一年）。

### 方式 A：一键部署

点上方 **Deploy to Cloudflare**，按提示填写：

- `GARMIN_API_KEY`：佳明密钥
- `LOGIN_PASSWORD`：自己设的长密码，连接 Claude 时输入
- `TIMEZONE`：时区，如 `Africa/Johannesburg`、`Asia/Shanghai`

### 方式 B：命令行

需要 Node.js 20 或以上。

```bash
git clone https://github.com/wesleysui/garmin-mcp-worker && cd garmin-mcp-worker
npm install
npx wrangler login
npx wrangler secret put GARMIN_API_KEY
npx wrangler secret put LOGIN_PASSWORD
npm run deploy            # KV 存储会自动创建
```

部署前在 `wrangler.jsonc` 里把 `vars.TIMEZONE` 改成你的时区。

---

## 连接 Claude

1. 在 Claude 网页版打开连接器设置，选择 **Add custom connector**
2. URL 填 `https://garmin-mcp.<你的子域>.workers.dev/mcp`
3. 点 **Connect**，在授权页输入 `LOGIN_PASSWORD`，点 **Allow**
4. 在聊天中开启连接器。网页版添加后，手机 App 会自动同步

---

## Personal API 没有的数据

- **训练准备度、训练状态、比赛预测**：未开放，可以用 `garmin_get_recovery_trend` 让模型根据 HRV、睡眠和静息心率判断
- **VO2max**：佳明目前会从 API 数据中剥离，请看手表
- **写入**：API 只读，不能推送课表或路线
- **主动推送**：只能按需拉取，新活动要等手表同步后才出现

---

## 维护

- **密钥过期**：佳明会提前约一周发邮件。新建密钥后运行 `npx wrangler secret put GARMIN_API_KEY`，不用重新连接 Claude
- **保持登录**：Claude 会自动续期，连续 30 天不用才需要重新输入密码
- **日志**：`npx wrangler tail`

---

## 声明

独立项目，**与佳明公司无关，未获其认可**。Garmin 和 Garmin Connect 是 Garmin Ltd. 或其子公司的商标。仅限用于你自己的账号，并遵守佳明 Personal API 条款。不构成医疗建议。

[MIT 许可证](LICENSE)
