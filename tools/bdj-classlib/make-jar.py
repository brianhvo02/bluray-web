#!/usr/bin/env python3
"""Writes a reproducible jar: entries sorted by name, fixed timestamps, no extra fields.

  python3 -I make-jar.py <out.jar> <source jar or directory> <names file | ->

The names file lists one entry name per line (blank lines ignored); `-` takes every file entry of the source.
"""
import os
import sys
import zipfile

EPOCH = (1980, 1, 1, 0, 0, 0)


def main() -> None:
    out, source, names_arg = sys.argv[1:4]
    if os.path.isdir(source):
        def read(name: str) -> bytes:
            with open(os.path.join(source, name), 'rb') as f:
                return f.read()
        everything = sorted(
            os.path.relpath(os.path.join(d, f), source).replace(os.sep, '/')
            for d, _, files in os.walk(source) for f in files
        )
    else:
        zin = zipfile.ZipFile(source)

        def read(name: str) -> bytes:
            return zin.read(name)
        everything = [i.filename for i in zin.infolist() if not i.filename.endswith('/')]

    if names_arg == '-':
        names = everything
    else:
        with open(names_arg) as f:
            names = [line.strip() for line in f if line.strip()]
    names = sorted(set(names))
    have = set(everything)
    missing = [n for n in names if n not in have]
    if missing:
        sys.exit('missing entries in %s: %s' % (source, ', '.join(missing[:20])))

    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zout:
        for name in names:
            info = zipfile.ZipInfo(name, EPOCH)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            info.create_system = 3
            zout.writestr(info, read(name), zipfile.ZIP_DEFLATED, 9)


main()
