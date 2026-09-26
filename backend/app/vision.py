"""Optional local OpenCLIP embeddings for image reuse and text-image checks."""

import asyncio
import hashlib
import io
import ipaddress
import os
import socket
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx
import numpy as np


MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000


@dataclass
class VisionResult:
    status: str
    text_image_similarity: float | None
    images: list[dict]


def _public_image_url(raw_url: str) -> bool:
    parsed = urlsplit(raw_url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        return False
    host = parsed.hostname.rstrip(".").lower()
    if host in {"localhost", "localhost.localdomain"} or host.endswith((".localhost", ".local", ".internal")):
        return False
    allowed_hosts = ("craigslist.org", "facebook.com", "fbcdn.net", "fbsbx.com")
    if not any(host == suffix or host.endswith(f".{suffix}") for suffix in allowed_hosts):
        return False
    try:
        addresses = {item[4][0] for item in socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)}
    except (OSError, ValueError):
        return False
    return bool(addresses) and all(ipaddress.ip_address(address).is_global for address in addresses)


async def _download_image(url: str) -> bytes | None:
    if not _public_image_url(url):
        return None
    timeout = httpx.Timeout(8.0, connect=4.0)
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False, headers={"User-Agent": "VancouverRentalScamShield/0.1"}) as client:
            async with client.stream("GET", url) as response:
                if response.status_code != 200 or not response.headers.get("content-type", "").lower().startswith("image/"):
                    return None
                length = response.headers.get("content-length")
                if length and int(length) > MAX_IMAGE_BYTES:
                    return None
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > MAX_IMAGE_BYTES:
                        return None
                return bytes(data)
    except (httpx.HTTPError, ValueError, OSError):
        return None


class ClipEmbedder:
    def __init__(self) -> None:
        self.model = None
        self.preprocess = None
        self.tokenizer = None
        self.device = os.getenv("RENTSHIELD_CLIP_DEVICE", "cpu")
        self.status = "not_loaded"
        self._attempted = False
        self.dimension = 512
        self._lock = asyncio.Lock()

    async def _load(self) -> bool:
        if self.model is not None:
            return True
        if self._attempted and self.status in {"not_installed", "unavailable"}:
            return False
        async with self._lock:
            if self.model is not None:
                return True
            try:
                import open_clip
                import torch

                def load_model():
                    model, _, preprocess = open_clip.create_model_and_transforms(
                        "ViT-B-32", pretrained="laion2b_s34b_b79k", device=self.device
                    )
                    model.eval()
                    return model, preprocess, open_clip.get_tokenizer("ViT-B-32")

                self.model, self.preprocess, self.tokenizer = await asyncio.to_thread(load_model)
                self.torch = torch
                self.dimension = int(getattr(self.model.visual, "output_dim", self.dimension))
                self.status = "ready"
                return True
            except ImportError:
                self._attempted = True
                self.status = "not_installed"
                return False
            except Exception:
                # Model weights may be unavailable offline; retain textual checks.
                self._attempted = True
                self.status = "unavailable"
                return False

    async def _encode_text(self, text: str) -> np.ndarray | None:
        if not text.strip() or not await self._load():
            return None

        def encode():
            tokens = self.tokenizer([text[:2500]]).to(self.device)
            with self.torch.no_grad():
                vector = self.model.encode_text(tokens)
                vector = vector / vector.norm(dim=-1, keepdim=True)
            return vector[0].detach().cpu().numpy().astype(np.float32)

        try:
            return await asyncio.to_thread(encode)
        except Exception:
            return None

    async def _encode_image(self, content: bytes) -> tuple[np.ndarray | None, str | None]:
        try:
            from PIL import Image, ImageOps

            with Image.open(io.BytesIO(content)) as opened:
                if opened.width * opened.height > MAX_IMAGE_PIXELS:
                    return None, None
                image = ImageOps.exif_transpose(opened).convert("RGB")
                gray = ImageOps.grayscale(image).resize((8, 8))
                pixels = list(gray.getdata())
                average_hash = sum((1 << i) for i, value in enumerate(pixels) if value >= sum(pixels) / 64)
                digest = hashlib.sha256(content).hexdigest()
                if not await self._load():
                    return None, f"{digest}:{average_hash:016x}"

                def encode():
                    image_tensor = self.preprocess(image).unsqueeze(0).to(self.device)
                    with self.torch.no_grad():
                        vector = self.model.encode_image(image_tensor)
                        vector = vector / vector.norm(dim=-1, keepdim=True)
                    return vector[0].detach().cpu().numpy().astype(np.float32)

                vector = await asyncio.to_thread(encode)
                return vector, f"{digest}:{average_hash:016x}"
        except Exception:
            return None, None

    async def analyze(self, title: str, description: str, urls: list[str]) -> VisionResult:
        if not urls:
            return VisionResult(status="not_used", text_image_similarity=None, images=[])
        text = await self._encode_text(f"{title}. {description}")

        async def process(url: str) -> dict | None:
            content = await _download_image(url)
            if not content:
                return None
            vector, digest = await self._encode_image(content)
            if not digest:
                return None
            hash_part, average_hash = digest.split(":", 1)
            return {"sha256": hash_part, "average_hash": average_hash, "embedding": vector.tolist() if vector is not None else None}

        entries = [entry for entry in await asyncio.gather(*(process(url) for url in urls[:8])) if entry]
        similarity = None
        vectors = [np.asarray(item["embedding"], dtype=np.float32) for item in entries if item["embedding"] is not None]
        if text is not None and vectors:
            similarity = float(np.mean([np.dot(text, vector) for vector in vectors]))
        return VisionResult(status=self.status, text_image_similarity=similarity, images=entries)


embedder = ClipEmbedder()
