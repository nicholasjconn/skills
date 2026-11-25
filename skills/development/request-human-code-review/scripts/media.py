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


def git_objects(file, committed):
    """Yield (side, path, object ID, in worktree) for each side whose bytes Git displayed."""
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
    if file.old_path and old and file.old_mode != b"160000":
        yield "old", file.old_path, old, False
    if file.new_path and file.new_mode != b"160000":
        if new and (committed or new == old):
            yield "new", file.new_path, new, False
        elif new.strip(b"0"):
            yield "new", file.new_path, new, True


def object_sizes(git, repo, ids):
    if not ids:
        return {}
    lines = git(repo, "cat-file", "--batch-check", input_bytes=b"".join(item + b"\n" for item in ids)).splitlines()
    sizes = {}
    for object_id, line in zip(ids, lines):
        size = line.rpartition(b" ")[2]
        if size.isdigit():  # otherwise the object is missing
            sizes[object_id] = int(size)
    return sizes


def worktree_content(path, object_id, keep, need_size):
    """Return (size, content or None) when the checkout still holds the bytes Git displayed."""
    try:
        if not stat.S_ISREG(path.lstat().st_mode):
            return None
        with path.open("rb") as stream:
            size = os.fstat(stream.fileno()).st_size
            content = bytearray() if keep(size) else None
            if content is None and not need_size:
                return None
            digest = hashlib.new("sha256" if len(object_id) == 64 else "sha1", f"blob {size}\0".encode())
            while chunk := stream.read(1024 * 1024):
                digest.update(chunk)
                if content is not None:
                    content.extend(chunk)
    except (FileNotFoundError, NotADirectoryError):
        # The captured diff and baseline remain usable if the checkout changes.
        return None
    if digest.hexdigest().encode() != object_id:
        return None
    return size, bytes(content) if content is not None else None


def load_blobs(git, read_object, repo, files, committed):
    """Give each file its text to highlight (file.sources) and its binary sizes and image bytes (file.blobs).

    Two Git processes serve the whole review: one reports every object's size, and read_object
    returns the contents worth keeping. Files are taken in order so the image budget is spent in order.
    """
    budget = ImageBudget()
    sides = [(file, *side) for file in files for side in git_objects(file, committed)]
    sizes = object_sizes(git, repo, list(dict.fromkeys(
        object_id for _, _, _, object_id, in_worktree in sides if not in_worktree)))
    for file, side, path, object_id, in_worktree in sides:
        media = file.binary or image_type(path) is not None

        def keep(size):
            return ((file.has_code and size <= MAX_HIGHLIGHT_BYTES) or
                    (image_type(path) is not None and size <= MAX_BINARY and
                     (size <= budget.remaining or size < LFS_POINTER_LIMIT)))

        if in_worktree:
            found = worktree_content(repo / path, object_id, keep, media)
            if found is None:
                continue
            size, content = found
        elif object_id in sizes:
            size = sizes[object_id]
            content = read_object(object_id) if keep(size) else None
        else:
            continue
        if file.has_code and content is not None and size <= MAX_HIGHLIGHT_BYTES:
            file.sources[side] = content
        if media:
            file.blobs[side] = budget.retain(size, content if image_type(path) and size <= MAX_BINARY else None)
