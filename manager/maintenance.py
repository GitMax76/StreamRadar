"""Archive completed videos on the Toshiba drive."""
import hashlib
import os
import shutil
import tempfile
from pathlib import Path


def checksum(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").digest()


def archive_videos(downloads, archive):
    if not (archive / ".lsm-toshiba").is_file():
        return
    for category, destination in (("Serie TV", "Serie TV"), ("Movies", "Movies"),
                                  ("Cartoni", "Cartoni"), ("Video", "Movies")):
        root = downloads / category
        if root.is_symlink():
            continue
        for source in root.rglob("*"):
            relative = source.relative_to(root)
            if (source.suffix.lower() not in {".mp4", ".mkv"} or not source.is_file()
                    or source.is_symlink() or not source.resolve().is_relative_to(root.resolve())
                    or any(part.startswith(".") for part in relative.parts)):
                continue
            target = archive / destination / relative
            if not target.parent.resolve().is_relative_to(archive.resolve()) or target.is_symlink():
                continue
            try:
                move_verified(source, target, archive / ".lsm-toshiba")
            except OSError as exc:
                print(f"Archivio Toshiba: {type(exc).__name__}", flush=True)


def move_verified(source, target, marker):
    if target.exists():
        # An interrupted move can leave two complete copies.
        if target.is_file() and checksum(target) == checksum(source) and marker.is_file():
            source.unlink()
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    before = source.stat()
    fd, temporary = tempfile.mkstemp(prefix=".lsm-", suffix=".part", dir=target.parent)
    temporary = Path(temporary)
    try:
        with source.open("rb") as original, os.fdopen(fd, "wb") as output:
            shutil.copyfileobj(original, output)
            output.flush()
            os.fsync(output.fileno())
        after = source.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
            return
        if checksum(temporary) != checksum(source) or not marker.is_file():
            return
        # A hard link publishes atomically and refuses to overwrite an existing file.
        os.link(temporary, target)
        if marker.is_file():
            source.unlink()
    finally:
        temporary.unlink(missing_ok=True)
