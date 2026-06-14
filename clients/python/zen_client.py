#!/usr/bin/env python3
"""
OpenCode Zen Python 客户端

支持双配额池感知、自动模型选择、代理转发。
可对接 server.js (http://localhost:7860) 或直接上游 (opencode.ai/zen/v1)。
"""

import urllib.request
import urllib.error
import json
import time

# ──── 配置 ────
DEFAULT_API   = "https://opencode.ai/zen/v1"
POOL_A_MODELS = ["deepseek-v4-flash-free", "minimax-m3-free", "big-pickle"]
POOL_B_MODELS = ["nemotron-3-ultra-free", "nemotron-3-super-free"]

# ──── 客户端 ────
class ZenClient:
    def __init__(self, api_base=None, proxy=None):
        self.api_base = (api_base or DEFAULT_API).rstrip("/")
        self.opener = None
        if proxy:
            h = urllib.request.ProxyHandler({"http": proxy, "https": proxy})
            self.opener = urllib.request.build_opener(h)

        self.pool_a_used = 0
        self.pool_b_used = 0
        self.pool_a_limit = 131
        self.pool_b_limit = 10
        self.models = POOL_A_MODELS + POOL_B_MODELS
        self._fetch_models()

    # ──── 内部 ────

    def _fetch_models(self):
        try:
            req = urllib.request.Request(f"{self.api_base}/models", headers={"User-Agent": "zen-client/2.0"})
            resp = self._open(req, timeout=10)
            data = json.loads(resp.read())
            if "data" in data:
                self.models = [m["id"] for m in data["data"]]
        except Exception:
            pass  # 使用默认模型列表

    def _open(self, req, **kw):
        if self.opener:
            return self.opener.open(req, **kw)
        return urllib.request.urlopen(req, **kw)

    def _pool_of(self, model):
        return "B" if model in POOL_B_MODELS else "A"

    def _can_use(self, model):
        pool = self._pool_of(model)
        limit = self.pool_b_limit if pool == "B" else self.pool_a_limit
        used = self.pool_b_used if pool == "B" else self.pool_a_used
        return used < limit

    def _track(self, model):
        if self._pool_of(model) == "B":
            self.pool_b_used += 1
        else:
            self.pool_a_used += 1

    def _select_best(self):
        for m in POOL_A_MODELS:
            if self._can_use(m):
                return m
        for m in POOL_B_MODELS:
            if self._can_use(m):
                return m
        return None

    # ──── 公开 API ────

    def chat(self, message, model=None, max_tokens=100, temperature=0.7):
        """发送聊天请求，自动选择可用模型"""
        model = model or self._select_best()
        if not model:
            return {"error": "All quotas exhausted"}

        data = json.dumps({
            "model": model,
            "messages": [{"role": "user", "content": message}],
            "max_tokens": max_tokens,
            "temperature": temperature,
        }).encode()

        req = urllib.request.Request(
            f"{self.api_base}/chat/completions",
            data=data,
            headers={"Content-Type": "application/json", "User-Agent": "zen-client/2.0"},
        )

        try:
            resp = self._open(req, timeout=30)
            result = json.loads(resp.read())
            self._track(model)
            return result
        except urllib.error.HTTPError as e:
            body = e.read()
            err = {"code": e.code, "type": "unknown", "message": ""}
            try:
                parsed = json.loads(body)
                err["type"] = parsed.get("error", {}).get("type", "http_error")
                err["message"] = parsed.get("error", {}).get("message", str(e))
            except Exception:
                err["message"] = str(e)
            return {"error": err}
        except Exception as e:
            return {"error": {"type": "network", "message": str(e)}}

    def status(self):
        return {
            "pool_a": {"used": self.pool_a_used, "limit": self.pool_a_limit,
                       "remaining": self.pool_a_limit - self.pool_a_used},
            "pool_b": {"used": self.pool_b_used, "limit": self.pool_b_limit,
                       "remaining": self.pool_b_limit - self.pool_b_used},
            "total_remaining": (self.pool_a_limit - self.pool_a_used) +
                               (self.pool_b_limit - self.pool_b_used),
            "models_available": len(self.models),
        }

    def reply(self, message, **kw):
        """便捷方法：直接返回文本回复"""
        result = self.chat(message, **kw)
        if "error" in result:
            return f"[Error] {result['error'].get('message', 'unknown')}"
        try:
            return result["choices"][0]["message"]["content"]
        except (KeyError, IndexError):
            return str(result)


# ──── 命令行 ────
if __name__ == "__main__":
    import sys
    client = ZenClient()
    msg = " ".join(sys.argv[1:]) or "Say hello in one sentence"
    print(f"🤖 {client.reply(msg)}")
    print(f"\n📊 {json.dumps(client.status(), indent=2)}")
