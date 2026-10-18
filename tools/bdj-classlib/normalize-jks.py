#!/usr/bin/env python3
"""Rewrites a JKS keystore of trusted certificates in place with every entry's creation date set to a fixed time.

  python3 -I normalize-jks.py <keystore> <password> <epoch seconds>

ca-certificates-java generates lib/security/cacerts when the image is built and stamps each entry with that moment, so
two builds of the same packages differ only in those dates and in the keystore's trailing digest. The certificates and
aliases are kept as they are; the digest is recomputed the way the JKS format defines it (SHA-1 over the password as
UTF-16BE, the bytes "Mighty Aphrodite" and the keystore data).
"""
import hashlib
import struct
import sys

MAGIC = 0xFEEDFEED
TRUSTED_CERT = 2


def main() -> None:
    path, password, epoch = sys.argv[1], sys.argv[2], int(sys.argv[3])
    with open(path, 'rb') as f:
        data = f.read()
    body, digest = data[:-20], data[-20:]
    salt = password.encode('utf-16-be') + b'Mighty Aphrodite'
    if hashlib.sha1(salt + body).digest() != digest:
        sys.exit('%s: keystore digest does not match the password' % path)
    magic, version, count = struct.unpack_from('>III', body, 0)
    if magic != MAGIC or version != 2:
        sys.exit('%s: not a JKS version 2 keystore' % path)
    out = bytearray(body)
    p = 12
    for _ in range(count):
        (tag,) = struct.unpack_from('>I', body, p)
        if tag != TRUSTED_CERT:
            sys.exit('%s: entry with tag %d (only trusted certificates are expected)' % (path, tag))
        (n,) = struct.unpack_from('>H', body, p + 4)
        p += 6 + n
        struct.pack_into('>Q', out, p, epoch * 1000)
        p += 8
        (n,) = struct.unpack_from('>H', body, p)  # certificate type
        p += 2 + n
        (n,) = struct.unpack_from('>I', body, p)
        p += 4 + n
    if p != len(body):
        sys.exit('%s: %d trailing bytes after the entries' % (path, len(body) - p))
    with open(path, 'wb') as f:
        f.write(bytes(out) + hashlib.sha1(salt + bytes(out)).digest())


main()
