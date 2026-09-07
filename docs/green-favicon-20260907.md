# 浏览器标签图标统一

- 复用已存在的绿色叶片 Logo：public/icons/icon-192.png，不重新绘制品牌图标。
- 删除 src/app/icon.svg 中蓝色“知”字图标，避免 Next.js 文件约定自动覆盖。
- 根 metadata 统一配置 icon / shortcut，增加 green-leaf-20260907 地址版本；移除重复手写 icon link。
- 本地首页 HTML 仅输出绿色资源地址，未再输出 icon.svg；10 项导航测试及类型检查通过。
- 发布前持有部署锁，核对当前 runtime 为 #197，删除非运行 #190 的 .venv、frontend/node_modules、frontend/.next 可重建产物约 2 GB；源码、用户数据、备份及近期回滚版本未删除。空闲空间恢复至 5.1 GB。
- 发布通过既有 Jenkins 原子部署流程，结果完成后记录。
