"""Stamp every local asset link with a version, so a change is never masked by
a cached copy.

GitHub Pages serves assets with a ten-minute cache, which is why a fix can look
like it did not land. A query string the browser has not seen before is a new
URL, so it refetches. Run this after changing anything under assets/.

    python tools/bump_assets.py
"""
import io
import os
import re
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGES = ["index.html", "wardrobe.html"]


def bump(version=None):
    version = version or time.strftime("%Y%m%d%H%M")
    touched = []
    for page in PAGES:
        path = os.path.join(ROOT, page)
        if not os.path.exists(path):
            continue
        text = io.open(path, encoding="utf-8", newline="").read()

        def restamp(m):
            attr, url = m.group(1), m.group(2)
            base = url.split("?")[0]
            return '%s="%s?v=%s"' % (attr, base, version)

        new = re.sub(r'\b(href|src)="(assets/[^"]+)"', restamp, text)
        if new != text:
            io.open(path, "w", encoding="utf-8", newline="").write(new)
            touched.append((page, len(re.findall(r'\?v=' + version, new))))
    return version, touched


if __name__ == "__main__":
    v, touched = bump(sys.argv[1] if len(sys.argv) > 1 else None)
    for page, n in touched:
        print("  %-16s %d asset link(s) stamped" % (page, n))
    print("version %s" % v)
