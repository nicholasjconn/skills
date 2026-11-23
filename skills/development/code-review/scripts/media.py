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


def image_type(path):
    return IMAGE_TYPES.get(Path(path).suffix.lower()) if path else None


@dataclass
class Blob:
    size: int | None
    image: bytes | None = None


def describe(file):
    sides = {}
    for name, path in (("old", file.old_path), ("new", file.new_path)):
        blob = file.blobs.get(name)
        sides[name] = {
            "present": path is not None,
            "size": blob.size if blob is not None else None,
            "image": blob is not None and blob.image is not None,
        }
    return {"binary": file.binary, "image": bool(image_type(file.old_path) or image_type(file.new_path)), **sides}


def patch_blobs(file):
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
    return candidates


def git_blobs(git, repo, file, committed):
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

    def object_blob(object_id, want_image):
        size = int(git(repo, "cat-file", "-s", object_id.decode()))
        image = git(repo, "cat-file", "blob", object_id.decode()) if want_image and size <= MAX_BINARY else None
        return Blob(size, image)

    blobs = {}
    if file.old_path and old and (file.binary or image_type(file.old_path)) and file.old_mode != b"160000":
        blobs["old"] = object_blob(old, image_type(file.old_path))
    if not file.new_path or not (file.binary or image_type(file.new_path)) or file.new_mode == b"160000":
        return blobs
    want_image = image_type(file.new_path)
    if new and (committed or new == old):
        blobs["new"] = object_blob(new, want_image)
        return blobs
    if new.strip(b"0"):
        candidate = repo / file.new_path
        if stat.S_ISREG(candidate.lstat().st_mode):
            # Validate the exact bytes Git displayed before using the worktree
            # as the source for the image or its size.
            with candidate.open("rb") as stream:
                size = os.fstat(stream.fileno()).st_size
                digest = hashlib.new("sha256" if len(new) == 64 else "sha1", f"blob {size}\0".encode())
                image = bytearray() if want_image and size <= MAX_BINARY else None
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
                    if image is not None:
                        image.extend(chunk)
                if digest.hexdigest().encode() == new:
                    blobs["new"] = Blob(size, bytes(image) if image is not None else None)
    return blobs
