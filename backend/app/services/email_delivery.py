"""Small, truthful SMTP delivery adapter for Agent digests."""

from __future__ import annotations

import html
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr
from typing import Any
from urllib.parse import quote

from app.core.config import settings


def is_configured() -> bool:
    return bool(
        settings.EMAIL_DELIVERY_ENABLED
        and settings.SMTP_HOST.strip()
        and settings.SMTP_FROM.strip()
    )


def public_status() -> dict[str, Any]:
    return {
        "configured": is_configured(),
        "provider": "smtp" if is_configured() else "preview",
        "from_name": settings.SMTP_FROM_NAME if is_configured() else "",
    }


def _html_body(title: str, body: str, source_count: int, thread_url: str) -> str:
    safe_title = html.escape(title)
    paragraphs = [
        f"<p>{html.escape(part).replace(chr(10), '<br>')}</p>"
        for part in body.split("\n\n")
        if part.strip()
    ]
    safe_url = html.escape(thread_url, quote=True)
    return f"""\
<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;background:#f3f7f5;color:#17211c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif">
    <div style="max-width:680px;margin:0 auto;padding:32px 18px">
      <div style="background:#ffffff;border:1px solid #dfe8e3;border-radius:20px;padding:28px">
        <p style="margin:0 0 8px;color:#16835f;font-size:13px;font-weight:700">知萃 · 视频资料摘要</p>
        <h1 style="margin:0 0 8px;font-size:24px;line-height:1.35">{safe_title}</h1>
        <p style="margin:0 0 24px;color:#6b7a72;font-size:14px">本次依据 {source_count} 条按规则筛选、且文案已就绪的视频。</p>
        <div style="font-size:15px;line-height:1.8">{''.join(paragraphs)}</div>
        <p style="margin:26px 0 0">
          <a href="{safe_url}" style="display:inline-block;background:#16835f;color:#fff;text-decoration:none;padding:11px 18px;border-radius:12px;font-weight:700">继续向这些视频提问</a>
        </p>
      </div>
      <p style="color:#87938d;font-size:12px;line-height:1.6;padding:0 8px">这封邮件只总结已经同步到知萃的完整文案；知萃服务器不保存视频文件。</p>
    </div>
  </body>
</html>
"""


def send_digest(
    *,
    recipient: str,
    title: str,
    body: str,
    source_count: int,
    thread_id: str | None,
    idempotency_key: str,
) -> dict[str, str]:
    """Submit one digest and return a truthful delivery status."""
    if not is_configured():
        return {
            "status": "not_configured",
            "error": "邮件服务尚未配置，摘要已保存在知萃中。",
        }

    thread_url = (
        f"{settings.PUBLIC_APP_URL.rstrip('/')}/harness?thread={thread_id}"
        if thread_id
        else f"{settings.PUBLIC_APP_URL.rstrip('/')}/harness"
    )
    message = EmailMessage()
    message["Subject"] = title
    message["From"] = formataddr(
        (settings.SMTP_FROM_NAME.strip() or "知萃", settings.SMTP_FROM.strip())
    )
    message["To"] = recipient
    sender_domain = (
        settings.SMTP_FROM.rsplit("@", 1)[-1]
        if "@" in settings.SMTP_FROM
        else "luxai.cn"
    )
    stable_id = "".join(
        character
        for character in idempotency_key
        if character.isalnum() or character in {"-", "_", "."}
    )[:120]
    message["Message-ID"] = f"<zhicui-{stable_id}@{sender_domain}>"
    message.set_content(
        f"{title}\n\n本次依据 {source_count} 条按规则筛选、且文案已就绪的视频。\n\n"
        f"{body}\n\n继续查看：{thread_url}\n\n"
        "知萃服务器不保存视频文件。"
    )
    message.add_alternative(
        _html_body(title, body, source_count, thread_url),
        subtype="html",
    )

    return _submit_message(message)


def _submit_message(message: EmailMessage) -> dict[str, str]:
    timeout = max(5, min(int(settings.SMTP_TIMEOUT_SECONDS), 60))
    tls_context = ssl.create_default_context()
    try:
        if settings.SMTP_USE_SSL:
            smtp: smtplib.SMTP = smtplib.SMTP_SSL(
                settings.SMTP_HOST,
                settings.SMTP_PORT,
                timeout=timeout,
                context=tls_context,
            )
        else:
            smtp = smtplib.SMTP(
                settings.SMTP_HOST,
                settings.SMTP_PORT,
                timeout=timeout,
            )
        with smtp:
            smtp.ehlo()
            if settings.SMTP_USE_TLS and not settings.SMTP_USE_SSL:
                smtp.starttls(context=tls_context)
                smtp.ehlo()
            if settings.SMTP_USER:
                smtp.login(settings.SMTP_USER, settings.SMTP_PASSWORD)
            smtp.send_message(message)
    except Exception as exc:
        return {
            "status": "failed",
            "error": f"{type(exc).__name__}: {str(exc)[:240]}",
        }
    return {"status": "sent", "error": ""}


def send_verification(
    *,
    recipient: str,
    token: str,
    message_key: str,
) -> dict[str, str]:
    if not is_configured():
        return {
            "status": "not_configured",
            "error": "邮件服务尚未配置，暂时不能发送验证邮件。",
        }
    verification_url = (
        f"{settings.PUBLIC_APP_URL.rstrip('/')}/harness"
        f"#verify_email={quote(token, safe='')}"
    )
    safe_url = html.escape(verification_url, quote=True)
    message = EmailMessage()
    message["Subject"] = "验证你的知萃邮箱"
    message["From"] = formataddr(
        (settings.SMTP_FROM_NAME.strip() or "知萃", settings.SMTP_FROM.strip())
    )
    message["To"] = recipient
    sender_domain = (
        settings.SMTP_FROM.rsplit("@", 1)[-1]
        if "@" in settings.SMTP_FROM
        else "luxai.cn"
    )
    stable_key = "".join(
        character
        for character in message_key
        if character.isalnum() or character in {"-", "_", "."}
    )[:120]
    message["Message-ID"] = f"<zhicui-verify-{stable_key}@{sender_domain}>"
    message.set_content(
        "请验证你的知萃注册邮箱。验证后，每日视频摘要才会发送到这里。\n\n"
        f"{verification_url}\n\n"
        "链接 24 小时内有效。如果不是你发起的，可以忽略这封邮件。"
    )
    message.add_alternative(
        f"""\
<!doctype html>
<html lang="zh-CN">
  <body style="margin:0;background:#f3f7f5;color:#17211c;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif">
    <div style="max-width:620px;margin:0 auto;padding:32px 18px">
      <div style="background:#fff;border:1px solid #dfe8e3;border-radius:20px;padding:28px">
        <p style="margin:0 0 8px;color:#16835f;font-size:13px;font-weight:700">知萃 · 邮箱验证</p>
        <h1 style="margin:0 0 12px;font-size:24px">确认这是你的邮箱</h1>
        <p style="line-height:1.8;color:#536159">验证后，每日视频摘要才会发送到这个邮箱。链接 24 小时内有效。</p>
        <p style="margin:24px 0 0"><a href="{safe_url}" style="display:inline-block;background:#16835f;color:#fff;text-decoration:none;padding:11px 18px;border-radius:12px;font-weight:700">验证邮箱</a></p>
      </div>
    </div>
  </body>
</html>
""",
        subtype="html",
    )
    return _submit_message(message)
