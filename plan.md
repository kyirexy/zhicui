# 管理端完善 + bug 修复 方案

## 背景
admin 登录后的 `/admin` 当前只有「用户表 + 两个统计数」,且存在禁用 bug(禁用自己/最后一个 admin 后死锁)。本次:修 bug + LLM/ASR 运行时配置(存 DB)+ 笔记管理 + 统计扩展 + 视频重新抽取。

---

## 1. 禁用 bug 修复(后端校验 + 前端按钮)
**后端 `admin_patch_user`**(routes.py:839)加校验:
- 不能禁用/降级自己:`user_id == current_user.id` 且(`is_active=False` 或 `is_admin=False`)→ `_err("不能禁用/降级自己")`
- 不能禁用/降级最后一个 admin:目标 `is_admin=True` 且将设 `is_active=False` 或 `is_admin=False`,且 `count(is_admin=True & is_active=True) <= 1` → `_err("至少保留一个启用的管理员")`

**前端 admin/page.tsx**:自己行、最后 admin 行的「禁用」按钮 disabled + tooltip 提示。

## 2. 系统配置 DB 基础设施
**新 model** `backend/app/models/system_setting.py`:
- `SystemSetting`:`key`(String(64) PK)、`value`(Text)、`updated_at`(DateTime tz)
- 表名 `system_settings`

**新 service** `backend/app/services/settings_service.py`:
- `get_setting(db, key, default="")` / `set_setting(db, key, value)`(upsert)
- `get_llm_config(db)` → `{model, api_base, api_key}`:DB 优先,fallback `settings.LLM_*`;api_key fallback 链 `DB LLM_API_KEY → settings.LLM_API_KEY → settings.API_KEY`
- `get_asr_config(db)` → `{api_key, api_base_url, model}`:DB 优先,fallback settings

**main.py**:import `SystemSetting`(让 `create_all` 建表)

## 3. LLM 配置(运行时生效,无需重启)
**ai_juicer.py** 加模块级 helper `_get_llm_config()`(`with SessionLocal() as db: return get_llm_config(db)`),替换 3 处 `settings.LLM_*`:
- `_generate_card_once`(287-308)、`_call_llm`(463-480)、`generate_card_from_images`(679-689)

**接口**(admin 鉴权):
- `GET /api/admin/llm-config` → `{model, api_base, api_key_masked}`(key 只露末 4 位)
- `PUT /api/admin/llm-config` body `{model?, api_base?, api_key?}` → `set_setting` + 返回

## 4. ASR 配置(运行时生效)
**routes.py** 两处(275-281、488-494):`settings.API_KEY/ASR_API_BASE_URL/ASR_MODEL` → `get_asr_config(db)`
**接口**:
- `GET /api/admin/asr-config` → `{api_key_masked, api_base_url, model}`
- `PUT /api/admin/asr-config` body `{api_key?, api_base_url?, model?}`

## 5. 笔记管理
**note_service.py** 加:
- `delete_note(db, note_id) -> bool`
- `update_note_ai(db, note, ai_result)`(重新抽取用:更新 ai_summary/card_type/pitfall_rating/updated_at)
- `list_notes_admin(db, page, per_page)` → join users 取 author username

**接口**:
- `GET /api/admin/notes?page=&per_page=` → `{items:[{id,video_title,card_type,author,created_at}], total}`
- `DELETE /api/admin/notes/{id}` → `delete_note`
- `POST /api/admin/notes/{id}/re-extract` → 取 `transcript_raw` → `generate_card` → `update_note_ai`(无 transcript 返回 `_err`)

## 6. 统计扩展
`GET /api/admin/stats`(routes.py:812)扩返回:
- `users, notes, plans`(加 plans 计数)
- `recent_users`:最近 5 个注册用户 `[{username,email,created_at}]`
- `type_dist`:`{recipe,insight,history,product,plan,general}` 各 card_type 计数

## 7. 前端 admin/page.tsx 改造
- 顶部 **tab 切换**:用户 / 笔记 / LLM 配置 / ASR 配置(state 切换,复用 glass-card)
- **统计区**:users/notes/plans 三卡 + 类型分布小条
- **用户 tab**:现有表格 + 禁用 bug 修复(disabled 按钮)
- **笔记 tab**:列表(标题/类型/作者/日期)+ 删除 + 重新抽取按钮
- **LLM 配置 tab**:表单(model/api_base/api_key,api_key 预填脱敏)→ PUT
- **ASR 配置 tab**:表单(api_key/api_base_url/model)→ PUT
- `frontend/src/lib/api.ts` 加 admin 接口 wrapper

---

## 文件清单
**新增**:
- `backend/app/models/system_setting.py`
- `backend/app/services/settings_service.py`

**改动**:
- `backend/app/main.py`(import SystemSetting)
- `backend/app/api/routes.py`(patch 校验 + admin 接口扩展 + ASR 读 DB + stats 扩展)
- `backend/app/services/ai_juicer.py`(LLM 读 DB)
- `backend/app/services/note_service.py`(delete/update/list_admin)
- `frontend/src/app/admin/page.tsx`(tabs + 全功能)
- `frontend/src/lib/api.ts`(admin wrapper)

## 部署
`git push gitee master` → Jenkins 自动(pull + build + restart)。.git 权限已修(`chown -R jenkins:jenkins /opt/zhicui`),全自动 CI/CD 正常。注意:勿用 root 操作服务器 git。

## 风险/权衡
- LLM/ASR 改 DB 后,旧 `.env` 仍作 fallback(DB 空时用 .env,安全过渡)。
- ai_juicer 每次 LLM 调用读 DB(毫秒级,LLM 调用本身慢,可接受)。
- 重新抽取依赖 `transcript_raw`(无转录的笔记无法重抽,接口返回错误)。
- api_key 脱敏:GET 只露末 4 位,PUT 时空值表示「不改」。

## 建议分阶段(可选)
- 阶段 A(必修):1 禁用 bug + 2 配置基础 + 3 LLM 配置 + 4 ASR 配置
- 阶段 B(管理):5 笔记管理 + 6 统计扩展 + 7 重新抽取
也可一次性全做(改完一起 push 一次部署)。
