# yutto source and license notice

This sidecar installs **yutto 2.2.0** from the reviewed upstream revision:

- Project: https://github.com/yutto-dev/yutto
- Source revision: `ba90a95bd89e416059ee5559b52197531d5d8998`
- License: GNU General Public License v3.0

The installer keeps the corresponding source at
`/opt/yutto-sidecar/source/ba90a95bd89e416059ee5559b52197531d5d8998`
and copies its unmodified license to
`/opt/yutto-sidecar/LICENSE.yutto-GPL-3.0`.  FastAPI communicates with yutto
only through its authenticated loopback JSON-RPC protocol; yutto code is not
linked into the application. The runtime is built from that retained source;
the older PyPI wheel carrying the same version string is not used because it
does not contain this revision's `serve` / `resolve.start` implementation.
The reviewed official wheel is `yutto-2.2.0-py3-none-any.whl`, SHA256
`d4a60283f88d64939c6828cef6ab2dfdd9d7ca33899524c0c33bef2d6b5eaeba`;
the hash is retained here for audit, not as the deployed runtime artifact.

Before building, the installer applies the retained, reviewable
`deploy/yutto-sidecar/zhicui-catalog-fields.patch`.  That patch adds only
publication time and duration to resolve-only UGC item snapshots so the
catalog can persist the documented safe metadata fields.  The complete
corresponding patched source and the patch itself remain available at
`/opt/yutto-sidecar/zhicui-catalog-fields.patch`; no media download path is
invoked by the Zhicui client.
