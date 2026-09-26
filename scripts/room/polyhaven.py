"""Cached downloads of CC0 assets from Poly Haven (https://polyhaven.com).

Everything lands in ~/.cache/term-site-room/<asset>/<res>/ so builds are
reproducible offline after the first run. Plain Python: importable from
Blender's bundled interpreter.
"""
import json
import urllib.request
from pathlib import Path

CACHE = Path.home() / ".cache/term-site-room"
USER_AGENT = "term-site-room-build/1.0 (+https://tim.waldin.net)"


def _fetch(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(request) as response, open(tmp, "wb") as out:
        out.write(response.read())
    tmp.rename(dest)
    return dest


def _files(asset_id: str) -> dict:
    path = _fetch(f"https://api.polyhaven.com/files/{asset_id}", CACHE / asset_id / "files.json")
    return json.loads(path.read_text())


def model(asset_id: str, res: str = "2k") -> Path:
    """Download a model's glTF with its buffers and textures; return the .gltf path."""
    entry = _files(asset_id)["gltf"][res]["gltf"]
    root = CACHE / asset_id / res
    gltf = _fetch(entry["url"], root / Path(entry["url"]).name)
    for rel, include in entry.get("include", {}).items():
        _fetch(include["url"], root / rel)
    return gltf


# Poly Haven map names → our names.
_TEXTURE_MAPS = {"Diffuse": "diff", "nor_gl": "nor", "Rough": "rough", "arm": "arm", "Displacement": "disp"}


def texture(asset_id: str, res: str = "2k") -> dict:
    """Download a texture set; return {"diff"|"nor"|"rough"|"arm"|"disp": Path}."""
    files = _files(asset_id)
    maps = {}
    for key, name in _TEXTURE_MAPS.items():
        formats = files.get(key, {}).get(res)
        if not formats:
            continue
        entry = formats.get("jpg") or formats.get("png")
        maps[name] = _fetch(entry["url"], CACHE / asset_id / res / Path(entry["url"]).name)
    return maps


def hdri(asset_id: str, res: str = "4k") -> Path:
    entry = _files(asset_id)["hdri"][res]["hdr"]
    return _fetch(entry["url"], CACHE / asset_id / res / Path(entry["url"]).name)
