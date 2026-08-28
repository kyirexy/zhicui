import Link from 'next/link';
import PublicDocumentPage from '@/components/PublicDocumentPage';
import { CURRENT_LEGAL_VERSIONS } from '@/lib/legalDocuments';

export default function TermsPage() {
  return (
    <PublicDocumentPage
      category="法律文件"
      title="知萃用户协议"
      version={CURRENT_LEGAL_VERSIONS.terms}
      intro="欢迎使用知萃。注册或使用本产品前，请完整阅读本协议；本协议说明服务范围、账号责任、内容处理方式和平台能力边界。"
      sections={[
        {
          id: 'service',
          title: '1. 服务内容',
          content: <p>知萃提供用户主动选择的视频链接导入、公开作品目录同步、文稿提取、基于资料的 AI 问答、知识整理和行动计划功能。具体能力会因客户端、平台授权和网络状态而不同。</p>,
        },
        {
          id: 'account',
          title: '2. 账号与安全',
          content: <ul><li>你应提供真实、有效的注册信息，并妥善保管密码和已登录设备。</li><li>不得转让账号、批量注册、绕过访问控制或利用服务影响他人正常使用。</li><li>发现异常登录或账号安全问题时，请及时修改密码并通过支持渠道联系我们。</li></ul>,
        },
        {
          id: 'content',
          title: '3. 你选择的内容',
          content: <p>你应确保自己有权处理所提交的链接和内容。你保留对自己内容的合法权利，并授权知萃仅在提供提取、整理、问答、同步和数据恢复所需范围内处理这些内容。</p>,
        },
        {
          id: 'platforms',
          title: '4. 第三方平台与公开作品',
          content: <p>抖音、B站等第三方平台的登录、访问和公开作品能力由相应平台控制。知萃不会绕过验证码、私密、付费、版权或风控限制。详情请阅读<Link href="/platform-limits">平台与客户端限制</Link>。</p>,
        },
        {
          id: 'ai',
          title: '5. AI 输出',
          content: <p>AI 生成内容可能存在遗漏或错误，仅作为资料整理和辅助思考，不构成医疗、法律、财务等专业意见。重要决定应核对原文依据并咨询合格专业人士。</p>,
        },
        {
          id: 'prohibited',
          title: '6. 禁止行为',
          content: <ul><li>上传、传播违法、有害、侵权或未经授权的内容。</li><li>攻击服务、探测他人数据、滥用接口或干扰平台正常运行。</li><li>利用产品实施自动化刷取、规避第三方平台限制或其他违反平台规则的行为。</li></ul>,
        },
        {
          id: 'availability',
          title: '7. 服务变更与可用性',
          content: <p>我们会尽力保持服务稳定，但升级、网络、上游 AI、第三方平台或不可抗力可能造成中断或降级。对重要资料，请保留你自己的副本。</p>,
        },
        {
          id: 'termination',
          title: '8. 终止与账号注销',
          content: <p>你可以在设置中导出个人数据或永久注销账号。严重违反本协议、法律法规或危及服务安全时，我们可以限制或终止相关功能，并在合理范围内提供说明。</p>,
        },
        {
          id: 'updates',
          title: '9. 协议更新',
          content: <p>重大变更会通过产品内提示等合理方式告知，并以新的版本号和生效日期标识。依法需要重新同意时，我们会再次请求你的主动确认。</p>,
        },
        {
          id: 'contact',
          title: '10. 联系我们',
          content: <p>协议、账号或投诉问题可前往<Link href="/support">支持与投诉</Link>页面提交。我们会核实身份后处理涉及账号和数据的请求。</p>,
        },
      ]}
    />
  );
}
