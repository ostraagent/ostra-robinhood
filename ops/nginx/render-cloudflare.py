#!/usr/bin/env python3
"""Renders ops/nginx/ostra-robinhood.conf with Cloudflare's address ranges.

Usage: render-cloudflare.py IPS_V4_FILE IPS_V6_FILE SITE_OUT SNIPPET_OUT

IPS_V4_FILE and IPS_V6_FILE are https://www.cloudflare.com/ips-v4 and /ips-v6 as downloaded.
Every line must be a network in CIDR form; anything else stops the render. The site
configuration (the geo map of Cloudflare's ranges, then the server blocks) is written to
SITE_OUT, and the realip snippet (set_real_ip_from for each range, real_ip_header
CF-Connecting-IP) to SNIPPET_OUT, each through a temporary file.
"""

import ipaddress
import os
import sys

TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ostra-robinhood.conf")
MARKER = "@CLOUDFLARE_GEO@"


def ranges(path, version, at_least):
    nets = []
    with open(path, encoding="ascii") as f:
        for line in f.read().split():
            net = ipaddress.ip_network(line, strict=True)
            if net.version != version:
                raise SystemExit(f"{path}: {line} is not an IPv{version} network")
            nets.append(str(net))
    if len(nets) < at_least:
        raise SystemExit(f"{path}: {len(nets)} networks, expected at least {at_least}")
    return nets


def write(path, text):
    tmp = f"{path}.tmp-{os.getpid()}"
    with open(tmp, "w", encoding="ascii") as f:
        f.write(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


def main():
    if len(sys.argv) != 5:
        raise SystemExit(__doc__)
    v4, v6, site_out, snippet_out = sys.argv[1:]
    nets = ranges(v4, 4, 10) + ranges(v6, 6, 5)
    with open(TEMPLATE, encoding="ascii") as f:
        template = f.read()
    if template.count(MARKER) != 1:
        raise SystemExit(f"{TEMPLATE} must hold {MARKER} once")
    site = template.replace(MARKER, "\n".join(f"    {n} 1;" for n in nets))
    snippet = "# Cloudflare's ranges (ops/nginx/render-cloudflare.py): the client address is read from CF-Connecting-IP only on their connections.\n"
    snippet += "".join(f"set_real_ip_from {n};\n" for n in nets) + "real_ip_header CF-Connecting-IP;\n"
    write(site_out, site)
    write(snippet_out, snippet)
    print(f"RENDERED {len(nets)} Cloudflare networks")


if __name__ == "__main__":
    main()
