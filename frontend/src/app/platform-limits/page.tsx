import PublicDocumentPage from '@/components/PublicDocumentPage';
import { CURRENT_LEGAL_VERSIONS } from '@/lib/legalDocuments';

export default function PlatformLimitsPage() {
  return (
    <PublicDocumentPage
      category="产品说明"
      title="平台与客户端限制"
      version={CURRENT_LEGAL_VERSIONS.platformLimits}
      intro="知萃只处理你主动选择且平台当前允许访问的内容，不绕过私密、付费、验证码或风控控制。"
      sections={[
        {
          id: 'clients',
          title: '1. 各客户端的能力',
          content: <ul><li>Windows 和 Mac：适合绑定平台账号、手动同步喜欢/收藏/作品、批量整理和深度问答。Mac 目前为测试渠道。</li><li>Android：支持粘贴分享链接、跨端查看资料、提问和执行计划；平台账号绑定需在电脑端完成。</li><li>iPhone：客户端处于开发测试阶段，已接入资料、问答、计划、扫码和系统分享，尚未开放公开安装。</li><li>Web：提供产品演示、下载、登录授权与帮助。完整工作台请在客户端使用。</li></ul>,
        },
        {
          id: 'manual',
          title: '2. 同步始终由用户手动发起',
          content: <p>为了降低平台风控风险，知萃不会自动追更或后台高频同步。用户选择来源和数量并点击同步后，系统才开始读取。</p>,
        },
        {
          id: 'douyin',
          title: '3. 抖音喜欢、收藏与作品',
          content: <p>列表可能因登录过期、账号不匹配、验证码或平台临时限制而不可读。此时请按提示等待冷却或重新连接，不要连续重试；已有资料不会丢失。我们不会通过代理轮换或绕过控制规避限制。</p>,
        },
        {
          id: 'bilibili',
          title: '4. B站公开视频',
          content: <p>近期公开作品可通过现有连接器读取；全量目录依赖相应服务健康。私密、付费、删除、地区限制或平台暂不可访问的内容不会被绕过。多 P 视频会在用户选择后按顺序处理。</p>,
        },
        {
          id: 'quality',
          title: '5. 文稿与元数据质量',
          content: <p>平台只返回部分标题、封面、作者或音频时，资料会标记为待补全或暂不可转写，而不会用占位内容冒充完整成功。ASR 和 AI 输出也可能存在错误，请结合原视频核对。</p>,
        },
        {
          id: 'next-step',
          title: '6. 出现限制时怎么做',
          content: <ul><li>平台限制：等待界面给出的冷却时间后手动重试。</li><li>需要登录：在电脑客户端重新连接并等待确认完成。</li><li>连接器不可用：稍后重试；已有资料和文稿不受影响。</li><li>资料质量不足：打开原视频或重新读取，不要反复批量同步。</li></ul>,
        },
      ]}
    />
  );
}
