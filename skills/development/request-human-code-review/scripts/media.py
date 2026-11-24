"""Capture binary sizes and bounded image bytes for a review snapshot."""

import hashlib
import os
import re
import stat
from dataclasses import dataclass
from pathlib import Path

from patch_input import MAX_BINARY, apply_delta, binary_blocks, delta_header

IMAGE_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
    ".bmp": "image/bmp", ".ico": "image/x-icon", ".svg": "image/svg+xml",
}
INDEX = re.compile(rb"^index ([0-9a-f]+)\.\.([0-9a-f]+)", re.MULTILINE)
MAX_HIGHLIGHT_BYTES = 512 * 1024
MAX_SNAPSHOT_IMAGE_BYTES = 128 * 1024 * 1024
LFS_POINTER_LIMIT = 1024
LFS_POINTER = re.compile(rb"version https://git-lfs\.github\.com/spec/v1\n(?:ext-[0-9]+-[^\n ]+ [^\n]+\n)*oid sha256:[0-9a-f]{64}\nsize ([0-9]+)\n")


def image_type(path):
    return IMAGE_TYPES.get(Path(path).suffix.lower()) if path else None


@dataclass
class Blob:
    size: int | None
    content: bytes | None = None
    lfs_pointer: bool = False


@dataclass
class ImageBudget:
    remaining: int = MAX_SNAPSHOT_IMAGE_BYTES

    def retain(self, size, content):
        if content and len(content) < LFS_POINTER_LIMIT and (pointer := LFS_POINTER.fullmatch(content)):
            return Blob(int(pointer[1]), lfs_pointer=True)
        if content is None or len(content) > self.remaining:
            return Blob(size)
        self.remaining -= len(content)
        return Blob(size, content)


def describe(file):
    sides = {}
    for name, path in (("old", file.old_path), ("new", file.new_path)):
        blob = file.blobs.get(name)
        sides[name] = {
            "present": path is not None,
            "size": blob.size if blob is not None else None,
            "image": blob is not None and blob.content is not None,
            "lfs_pointer": blob is not None and blob.lfs_pointer,
        }
    return {"binary": file.binary, "image": bool(image_type(file.old_path) or image_type(file.new_path)), **sides}


def patch_blobs(file, image_budget):
    candidates = {}
    for patch in file.patches:
        new, old = (binary_blocks(patch) + [None, None])[:2]
        for side, block, other in (("old", old, new), ("new", new, old)):
            path = getattr(file, f"{side}_path")
            if not path:
                continue
            size = image = None
            if block:
                kind, size, data = block
                if kind == b"literal":
                    image = data
                else:
                    size = delta_header(data)[1] if data is not None else None
                    if data is not None and other and other[0] == b"literal" and other[2] is not None and image_type(path):
                        image = apply_delta(other[2], data)
            if size is not None:
                candidates[side] = Blob(size, image if image_type(path) else None)
    return {side: image_budget.retain(blob.size, blob.content) for side, blob in candidates.items()}


def git_blobs(git, repo, file, committed, *, image_budget=None):
    old = file.baseline_blob
    new = file.head_blob
    for patch in file.patches:
        if match := INDEX.search(patch):
            if match[1].strip(b"0"):
                old = match[1]
            if match[2].strip(b"0"):
                new = match[2]
    if not new.strip(b"0") and not any(INDEX.search(patch) for patch in file.patches):
        new = old  # only rename or mode metadata changed

    def limit(path):
        if image_budget is None:
            return MAX_HIGHLIGHT_BYTES
        return MAX_BINARY if image_type(path) else 0

    def can_load(size, max_content):
        return (0 < max_content and size <= max_content and
                (image_budget is None or size <= image_budget.remaining or size < LFS_POINTER_LIMIT))

    retain = Blob if image_budget is None else image_budget.retain

    def object_blob(object_id, max_content):
        size = int(git(repo, "cat-file", "-s", object_id.decode()))
        content = git(repo, "cat-file", "blob", object_id.decode()) if can_load(size, max_content) else None
        return retain(size, content)

    blobs = {}
    if file.old_path and old and (file.binary or limit(file.old_path)) and file.old_mode != b"160000":
        blobs["old"] = object_blob(old, limit(file.old_path))
    if not file.new_path or not (file.binary or limit(file.new_path)) or file.new_mode == b"160000":
        return blobs
    max_content = limit(file.new_path)
    if new and (committed or new == old):
        blobs["new"] = object_blob(new, max_content)
        return blobs
    if new.strip(b"0"):
        candidate = repo / file.new_path
        try:
            if not stat.S_ISREG(candidate.lstat().st_mode):
                return blobs
            # Validate the exact bytes Git displayed before using the worktree
            # as the source for the image or its size.
            with candidate.open("rb") as stream:
                size = os.fstat(stream.fileno()).st_size
                if image_budget is None and size > max_content:
                    return blobs
                digest = hashlib.new("sha256" if len(new) == 64 else "sha1", f"blob {size}\0".encode())
                content = bytearray() if can_load(size, max_content) else None
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
                    if content is not None:
                        content.extend(chunk)
                if digest.hexdigest().encode() == new:
                    blobs["new"] = retain(size, bytes(content) if content is not None else None)
        except (FileNotFoundError, NotADirectoryError):
            # The captured diff and baseline remain usable if the checkout changes.
            pass
    return blobs
