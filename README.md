# GitHub -> Gitee 全量仓库镜像双备份系统

## 系统概述
- 自动读取 GitHub `yuxiaojie0322-maker` 账号下的全部仓库（包括全部私有仓库与公开仓库）。
- 若 Gitee（`path-of-the-little-phoenix`）未建立同名仓库，将自动调用 Gitee API 创建并维持相同的私有/公开属性。
- 使用 `git clone --mirror` 与 `git push --mirror --force` 实现所有分支、标签与提交历史的 100% 完整镜像同步。
- 每天北京时间 11:00 自动定时运行，并向 Telegram 发送同步统计结果。
