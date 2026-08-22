# MoonGlass v0.5.2 发布说明

## 本次更新

- 加固文档工具链：支持按阶段校验、UTF-8 安全 JSON 输出、REQ/SPEC 双向追溯、ID 范围展开和状态检查。
- 修复会话工具输出中的 Windows 盘符被截断问题，`D:/...` 与 `D:\\...` 路径均可完整点击打开。
- 文件查看器新增 `Ctrl+F` 查找，支持上下一个匹配、大小写、全字和正则模式。
- Markdown 预览触发查找时自动切换到源码视图。
- 新项目自动生成 `.gitattributes`，统一 ASIC 文档、HDL、Python、Tcl、SDC 和配置文件的换行策略。

## 验证

- TypeScript 类型检查通过。
- MoonGlass 核心冒烟测试通过。
- Electron 生产构建通过。

## 授权

MoonGlass 采用 PolyForm Noncommercial License 1.0.0。商业使用、定制开发和授权咨询：`moonglassagent@126.com`。
