"""把独立博主接口接入已固定版本的伴随服务；重复执行不重复插入。"""
from pathlib import Path
import shutil
import sys

root = Path(sys.argv[1]).resolve(strict=True)
source = Path(__file__).resolve().parent / 'creator_api.py'
app = root / 'server/app.py'
text = app.read_text(encoding='utf-8')
marker = '    return app\n'
old_hook = ('    from server.creator_api import install_creator_routes\n'
        '    install_creator_routes(app, deps, _session_scope, DouyinAPIClient, _cookie_state_is_valid)\n')
hook = ('    from server.creator_api import install_creator_routes\n'
        '    install_creator_routes(app, deps, _session_scope, DouyinAPIClient, _cookie_state_is_valid, _prewarm_media_stream_urls)\n')
if 'async def _prewarm_media_stream_urls(' not in text:
    raise RuntimeError('伴随服务缺少当前版本的媒体缓存能力')
if old_hook in text:
    text = text.replace(old_hook, hook)
elif 'install_creator_routes(app,' in text and hook not in text:
    raise RuntimeError('伴随服务的已有接口入口与预期不一致')
if 'install_creator_routes(app,' not in text:
    if text.count(marker) != 1:
        raise RuntimeError('伴随服务入口结构与固定版本不一致')
    text = text.replace(marker, hook + marker)

# 只在固定媒体详情位置收集元数据；身份检查在生成媒体地址之前完成。
detail_anchor = ('                        detail = await api_client.get_video_detail(clean_id)\n'
                 '                        if not detail:\n'
                 '                            raise HTTPException(status_code=404, detail="未找到作品")\n')
detail_hook = detail_anchor + '                        app.state.creator_reader.remember_item(scoped, clean_id, detail)\n'
if detail_hook not in text:
    if text.count(detail_anchor) != 1 or 'creator_reader.remember_item(scoped,' in text:
        raise RuntimeError('伴随服务的媒体详情入口与预期不一致')
    text = text.replace(detail_anchor, detail_hook)
elif text.count(detail_hook) != 1:
    raise RuntimeError('伴随服务的媒体详情入口重复')

# 导入 Cookie 或退出当前绑定时，同步丢弃该会话的短期元数据。
clear_anchor = '        scoped.media_stream_cache.clear()\n'
clear_hook = clear_anchor + '        getattr(scoped, "item_metadata_cache", {}).clear()\n'
if text.count(clear_hook) != 2:
    if text.count(clear_anchor) != 2 or '"item_metadata_cache", {}).clear()' in text:
        raise RuntimeError('伴随服务的会话清理入口与预期不一致')
    text = text.replace(clear_anchor, clear_hook)
app.write_text(text, encoding='utf-8')
shutil.copyfile(source, root / 'server/creator_api.py')
