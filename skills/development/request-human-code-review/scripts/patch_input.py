"""Read standalone unified patches without opening any paths named inside them."""

import codecs
import base64
import re
import zlib

HUNK = re.compile(rb"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
DIFF_HEADER = re.compile(rb"^diff --git ", re.MULTILINE)
MAIL_HEADER = re.compile(rb"^From [0-9a-f]{40}(?:[0-9a-f]{24})? Mon Sep 17 00:00:00 2001\r?$", re.MULTILINE)
MAIL_STAT = re.compile(rb"^---\r?\n(?: [^\r\n]* \|[^\r\n]*\r?\n)* [0-9]+ files? changed[^\r\n]*\r?$", re.MULTILINE)
QUOTED = rb'"(?:[^"\\]|\\.)*"'
BINARY_BLOCK = re.compile(rb"^(literal|delta) (\d+)$")
MAX_BINARY = 32 * 1024 * 1024


def patch_mail_body(content):
    if not MAIL_HEADER.match(content):
        return content
    patches = []
    for message in MAIL_HEADER.split(content)[1:]:
        # A cover letter carries the series summary but no changed files.
        headers = re.split(rb"\r?\n\r?\n", message, maxsplit=1)[0]
        if re.search(rb"^Subject:.*\[.*\b0/[1-9][0-9]*\]", headers, re.MULTILINE):
            continue
        stats = list(MAIL_STAT.finditer(message))
        # The format-patch diffstat delimits the real patch from examples in the log.
        start = DIFF_HEADER.search(message, stats[-1].end() if stats else 0)
        if start:
            patches.append(message[start.start():])
    return b"\n".join(patches)


def patch_sections(content):
    """Split at file headers outside hunks and validate the declared line counts."""
    current = []
    paths = False
    old = new = 0
    lines = patch_mail_body(content).removesuffix(b"\n").split(b"\n")
    for index, raw in enumerate(lines):
        line = raw.removesuffix(b"\r")
        if old or new:
            if line.startswith(b"\\ No newline at end of file"):
                current.append(raw)
                continue
            if not line:
                raw = b" " + raw
            marker = raw[:1]
            if marker not in (b" ", b"+", b"-"):
                raise ValueError(f"Invalid unified hunk at patch line {index + 1}")
            old -= marker != b"+"
            new -= marker != b"-"
            if old < 0 or new < 0:
                raise ValueError(f"Hunk line count mismatch at patch line {index + 1}")
        elif line.startswith(b"diff --git "):
            if current:
                yield b"\n".join(current) + b"\n"
            current, paths = [], False
        elif line.startswith((b"diff --cc ", b"diff --combined ")):
            raise ValueError(f"Expected a unified diff at patch line {index + 1}")
        elif line.startswith((b"diff ", b"Index: ")):
            if current:
                yield b"\n".join(current) + b"\n"
            current, paths = [], False
            continue
        elif line.startswith(b"--- ") and index + 1 < len(lines) and lines[index + 1].startswith(b"+++ "):
            if current and paths:
                yield b"\n".join(current) + b"\n"
                current = []
            paths = True
        elif not current:
            continue
        elif match := HUNK.match(line):
            old = int(match[2] or b"1")
            new = int(match[4] or b"1")
        elif line.startswith(b"@@"):
            raise ValueError(f"Expected a unified diff at patch line {index + 1}")
        elif line.startswith(b"-- "):
            yield b"\n".join(current) + b"\n"
            current, paths = [], False
            continue  # git format-patch email signature
        current.append(raw)
    if old or new:
        raise ValueError("Patch ended inside a unified hunk")
    if current:
        yield b"\n".join(current).rstrip(b"\n") + b"\n"


def unquote(path):
    if match := re.match(QUOTED, path):
        return codecs.escape_decode(match[0][1:-1])[0]
    return path


def file_paths(patch):
    lines = patch.split(b"\n")
    metadata = next((index for index, line in enumerate(lines) if HUNK.match(line)), len(lines))
    paths = {}
    for raw in lines[:metadata]:
        line = raw.removesuffix(b"\r")
        for prefix in (b"--- ", b"+++ ", b"rename from ", b"rename to ", b"copy from ", b"copy to "):
            if line.startswith(prefix):
                value = line[len(prefix):]
                paths[prefix] = unquote(value.split(b"\t", 1)[0] if prefix in (b"--- ", b"+++ ") else value)
    for verb, status in ((b"rename", "R"), (b"copy", "C")):
        if verb + b" from " in paths and verb + b" to " in paths:
            return paths[verb + b" from "], paths[verb + b" to "], status
    git = lines[0].startswith(b"diff --git ")
    if b"--- " in paths and b"+++ " in paths:
        old, new = paths[b"--- "], paths[b"+++ "]
        if (old.startswith(b"a/") or old == b"/dev/null") and (new.startswith(b"b/") or new == b"/dev/null"):
            old, new = old.removeprefix(b"a/"), new.removeprefix(b"b/")
    elif git:
        header = lines[0].removeprefix(b"diff --git ").removesuffix(b"\r")
        pairs = [(header[:match.start()], header[match.start() + 1:]) for match in re.finditer(rb' (?="?b/)', header)]
        names = [(unquote(left).removeprefix(b"a/"), unquote(right).removeprefix(b"b/")) for left, right in pairs]
        old, new = next((pair for pair in names if pair[0] == pair[1]), names[0] if len(names) == 1 else (None, None))
        if old is None:
            raise ValueError(f"Cannot read file names from {lines[0]!r}")
        if any(line.startswith(b"new file mode ") for line in lines[:metadata]):
            old = b"/dev/null"
        if any(line.startswith(b"deleted file mode ") for line in lines[:metadata]):
            new = b"/dev/null"
    else:
        raise ValueError("Unified patch is missing its old and new file headers")
    old = None if old == b"/dev/null" else old
    new = None if new == b"/dev/null" else new
    if not (old or new):
        raise ValueError("Unified patch has no file name")
    return old, new, "A" if old is None else "D" if new is None else "M"


def binary_blocks(patch):
    """Return Git's forward and reverse embedded binary blocks when present."""
    _, delimiter, contents = patch.replace(b"\r\n", b"\n").partition(b"\nGIT binary patch\n")
    if not delimiter:
        return []
    blocks = []
    for block in contents.strip().split(b"\n\n")[:2]:
        header, *lines = block.split(b"\n")
        match = BINARY_BLOCK.fullmatch(header)
        if not match:
            break
        kind, size = match[1], int(match[2])
        if size > MAX_BINARY:
            blocks.append((kind, size, None))
            continue
        encoded = bytearray()
        try:
            for line in lines:
                lead = line[0]
                length = lead - 64 if 65 <= lead <= 90 else lead - 70
                if not 1 <= length <= 52 or len(line) != ((length + 3) // 4) * 5 + 1:
                    raise ValueError("Invalid Git binary patch line")
                encoded.extend(base64.b85decode(line[1:])[:length])
            decoder = zlib.decompressobj()
            data = decoder.decompress(encoded, size + 1)
            if not decoder.eof or len(data) != size:
                raise ValueError("Invalid Git binary patch size")
        except (IndexError, KeyError, OverflowError, ValueError, zlib.error) as error:
            raise ValueError("Invalid Git binary patch encoding") from error
        blocks.append((kind, size, data))
    return blocks


def delta_header(data):
    values = []
    number = shift = 0
    for index, byte in enumerate(data[:20]):
        number |= (byte & 127) << shift
        if byte & 128:
            shift += 7
        else:
            values.append(number)
            number = shift = 0
            if len(values) == 2:
                return values[0], values[1], index + 1
    raise ValueError("Invalid Git binary delta sizes")


def apply_delta(base, data):
    source_size, target_size, offset = delta_header(data)
    if len(base) != source_size or target_size > MAX_BINARY:
        return None
    output = bytearray()
    program = iter(data[offset:])
    try:
        for instruction in program:
            if instruction & 128:
                start = sum(next(program) << (index * 8) for index in range(4) if instruction & (1 << index))
                length = sum(next(program) << (index * 8) for index in range(3) if instruction & (16 << index)) or 65536
                if start + length > len(base):
                    raise ValueError("Git binary delta exceeds the source size")
                output.extend(base[start:start + length])
            elif instruction:
                output.extend(next(program) for _ in range(instruction))
            else:
                raise ValueError("Invalid Git binary delta instruction")
            if len(output) > target_size:
                raise ValueError("Git binary delta exceeds the target size")
    except (StopIteration, RuntimeError) as error:
        raise ValueError("Truncated Git binary delta") from error
    if len(output) != target_size:
        raise ValueError("Git binary delta size mismatch")
    return bytes(output)
