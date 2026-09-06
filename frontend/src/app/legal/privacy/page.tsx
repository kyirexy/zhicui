import Link from 'next/link';
import PublicDocumentPage from '@/components/PublicDocumentPage';
import {
  CURRENT_LEGAL_VERSIONS,
  PRIVACY_EFFECTIVE_DATE,
} from '@/lib/legalDocuments';

export default function PrivacyPage() {
  return (
    <PublicDocumentPage
      category="法律文件"
      title="知萃隐私政策"
      version={CURRENT_LEGAL_VERSIONS.privacy}
      effectiveDate={PRIVACY_EFFECTIVE_DATE}
      intro="本政策说明知萃收集哪些信息、为何处理、如何保护，以及你如何访问、导出或删除自己的数据。"
      sections={[
        {
          id: 'collection',
          title: '1. 我们处理的信息',
          content: <ul><li>账号信息：邮箱、用户名、密码哈希、注册时间和协议同意记录。</li><li>你主动选择的资料：来源链接、标题、作者、公开元数据、完整文稿、知识、计划和 AI 对话。</li><li>平台绑定状态：连接状态、授权范围和验证时间；必要的登录凭据会加密保存，不在数据导出或日志中返回。</li><li>跨设备扫码登录：仅在你主动点击扫码时申请相机权限。二维码画面在 Android 或 iOS 设备本地解析，不上传、不保存。电脑授权手机登录时，服务端短期保存登录凭据摘要与确认状态，二维码不包含账号密码或原有登录令牌。</li><li>运行信息：客户端类型、请求时间、错误类别、安全和用量记录。我们不为广告目的收集多余设备指纹。</li></ul>,
        },
        {
          id: 'purpose',
          title: '2. 处理目的',
          content: <p>这些信息用于账号登录与跨端同步、提取文稿、生成问答与计划、保存资料、保障安全、排查故障、统计基本使用状况以及履行你的数据权利请求。</p>,
        },
        {
          id: 'providers',
          title: '3. 服务提供方与第三方平台',
          content: <p>完成 ASR、AI 生成、邮件、云主机和平台公开数据读取时，必要信息可能传递给相应服务提供方。我们要求其仅按服务目的处理。第三方平台自身的数据处理受其规则和隐私政策约束。</p>,
        },
        {
          id: 'storage',
          title: '4. 保存与安全',
          content: <ul><li>账号和知识资料在你使用服务期间保存；注销后会删除或匿名化可关联数据。</li><li>密码只保存不可逆哈希，平台凭据和自定义 API 密钥加密保存。</li><li>视频文件仅在处理需要时临时使用，不作为永久媒体归档；文稿和你保存的结果会保留。</li><li>我们采用访问控制、HTTPS、审计和备份等措施，但任何网络系统都无法保证绝对安全。</li></ul>,
        },
        {
          id: 'rights',
          title: '5. 你的数据权利',
          content: <p>你可以在设置中查看账号信息、下载版本化个人数据归档、解除平台绑定，或在密码重验后永久注销账号。导出不会包含密码哈希、Cookie、密钥、临时媒体地址或服务器路径。</p>,
        },
        {
          id: 'deletion',
          title: '6. 注销、备份与法定义务',
          content: <p>账号注销会清理在线业务数据并使登录令牌失效。安全审计会仅保留不含内容、不能直接识别你的最小事件记录；依法必须保留的信息会在法定期限结束后删除。备份按照既定保留周期自然淘汰，不用于恢复已注销账号的日常服务。</p>,
        },
        {
          id: 'minors',
          title: '7. 未成年人',
          content: <p>未满法律规定年龄的用户应在监护人指导和同意下使用。若监护人发现未成年人未经同意提交了个人信息，可通过支持渠道联系我们处理。</p>,
        },
        {
          id: 'changes',
          title: '8. 政策更新',
          content: <p>我们会用版本号和生效日期标识变更。重大变化会提供显著提示；依法需要时，会再次获取你的主动同意。</p>,
        },
        {
          id: 'contact',
          title: '9. 隐私联系',
          content: <p>需要访问、更正、导出、删除数据或投诉时，请访问<Link href="/support">支持与投诉</Link>。为保护账号，我们可能先验证你的身份。</p>,
        },
      ]}
    />
  );
}
