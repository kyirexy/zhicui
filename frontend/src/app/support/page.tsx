import PublicDocumentPage from '@/components/PublicDocumentPage';
import { CURRENT_LEGAL_VERSIONS } from '@/lib/legalDocuments';

export default function SupportPage() {
  return (
    <PublicDocumentPage
      category="帮助中心"
      title="支持与投诉"
      version={CURRENT_LEGAL_VERSIONS.support}
      intro="使用问题可优先通过应用内“反馈”提交；账号、隐私和投诉请求也可以通过下列渠道联系。"
      sections={[
        {
          id: 'channels',
          title: '1. 联系渠道',
          content: <ul><li>应用内：点击“反馈”，选择问题、建议、内容或账号类别。</li><li>电子邮件：<a href="mailto:1592880030@qq.com">1592880030@qq.com</a>。</li><li>隐私与数据请求：在邮件标题注明“隐私请求”，或直接使用设置中的导出/注销功能。</li></ul>,
        },
        {
          id: 'details',
          title: '2. 提交问题时建议包含',
          content: <ul><li>发生时间、使用的 Web、Windows、Mac、Android 或 iPhone 客户端和版本。</li><li>可复现步骤、界面错误文字和必要的脱敏截图。</li><li>不要发送密码、Cookie、验证码、平台登录凭据或 API 密钥。</li></ul>,
        },
        {
          id: 'complaints',
          title: '3. 内容与账号投诉',
          content: <p>如你认为资料涉及侵权、违法内容或账号安全问题，请说明相关链接、权利基础和可验证的联系方式。我们会在核实后采取隐藏、删除、限制访问或其他必要措施。</p>,
        },
        {
          id: 'privacy',
          title: '4. 数据权利请求',
          content: <p>登录用户可以在设置中即时导出个人数据，或经密码重验永久注销账号。无法登录时，请通过注册邮箱联系我们；为防止冒用，我们会先验证账号归属。</p>,
        },
        {
          id: 'response',
          title: '5. 处理说明',
          content: <p>我们会根据问题严重程度处理。平台风控、上游服务或第三方内容问题可能需要等待平台恢复；处理期间已有资料不会因为重复同步而被自动删除。</p>,
        },
      ]}
    />
  );
}
