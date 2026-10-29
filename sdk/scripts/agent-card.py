# Writes sdk/src/agent-card.ts: the Ostra agent card (design "Ink", chosen 29 Oct 2026) as a deterministic SVG builder.
# Every letter is a path from Ostra's brand fonts (Schibsted Grotesk 700/800, JetBrains Mono 400/500; SIL Open Font
# License 1.1), so the card renders the same everywhere without fonts. The fixed text is drawn here once; the agent's
# number is set from the digit glyphs at run time. A changed design is a new AGENT_CARD_VERSION.
#   usage: python3 agent-card.py <fonts dir> <out.ts>
# with <fonts dir> holding the unpacked npm packages @fontsource/schibsted-grotesk@5.3.0 and
# @fontsource/jetbrains-mono@5.3.0 as fontsource-schibsted-grotesk-5.3.0/package and fontsource-jetbrains-mono-5.3.0/package
# (npm pack, then tar -xzf into a folder of that name); needs fontTools and brotli (pip).
import json
import sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen

F = sys.argv[1].rstrip("/") + "/{}/package/files/{}-latin-{}-normal.woff"


def load(family, weight):
    pkg = "fontsource-schibsted-grotesk-5.3.0" if family == "sans" else "fontsource-jetbrains-mono-5.3.0"
    name = "schibsted-grotesk" if family == "sans" else "jetbrains-mono"
    return TTFont(F.format(pkg, name, weight))


def fmt(v):
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


class RoundPen(SVGPathPen):
    """SVGPathPen with every coordinate rounded to 2 decimals, so the output is short and the same on every machine."""

    def __init__(self, gs):
        super().__init__(gs, ntos=fmt)


def text(s, family, weight, size, x, y, fill, anchor="start", tracking=0.0):
    f = load(family, weight)
    gs, cmap, upm = f.getGlyphSet(), f.getBestCmap(), f["head"].unitsPerEm
    scale = size / upm
    widths = [gs[cmap[ord(ch)]].width if ord(ch) in cmap else upm * 0.3 for ch in s]
    total = sum(widths) * scale + tracking * size * (len(s) - 1)
    if anchor == "middle":
        x -= total / 2
    elif anchor == "end":
        x -= total
    pen = RoundPen(gs)
    cx = x
    for ch, w in zip(s, widths):
        if ord(ch) in cmap:
            gs[cmap[ord(ch)]].draw(TransformPen(pen, (scale, 0, 0, -scale, cx, y)))
        cx += w * scale + tracking * size
    return f'<path d="{pen.getCommands()}" fill="{fill}"/>'


def ring(cx, cy, r, ink, red, hub_fill):
    k = r / 40
    out = (
        f'<circle cx="{fmt(cx)}" cy="{fmt(cy)}" r="{fmt(r)}" fill="none" stroke="{ink}" stroke-width="{fmt(10 * k)}" stroke-dasharray="{fmt(11.7 * k)} {fmt(4 * k)}" transform="rotate(-93.6 {fmt(cx)} {fmt(cy)})"/>'
        f'<circle cx="{fmt(cx)}" cy="{fmt(cy)}" r="{fmt(r)}" fill="none" stroke="{red}" stroke-width="{fmt(10 * k)}" stroke-dasharray="{fmt(11.7 * k)} {fmt(239.6 * k)}" transform="rotate(-93.6 {fmt(cx)} {fmt(cy)})"/>'
    )
    if hub_fill:
        out += f'<circle cx="{fmt(cx)}" cy="{fmt(cy)}" r="{fmt(9 * k)}" fill="{hub_fill}"/>'
    return out


BG, RED, LIGHT, FAINT, DIM, RULE = "#15171A", "#D9381E", "#F4F5F6", "#9A9DA3", "#24272B", "#3E4248"

head = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000" width="1000" height="1000"><rect width="1000" height="1000" fill="{BG}"/>'
head += ring(760, 360, 330, DIM, RED, DIM)
head += ring(110, 110, 24, LIGHT, RED, LIGHT)
head += text("ostra", "sans", 700, 44, 154, 125, LIGHT)
head += text("AGENT", "mono", 500, 22, 80, 700, RED, "start", 0.3)
tail = f'<rect x="80" y="912" width="840" height="1.5" fill="{RULE}"/>'
tail += text("post-quantum privacy vault", "mono", 400, 20, 80, 950, FAINT, "start", 0.02)
tail += text("eip155:4663", "mono", 400, 20, 920, 950, FAINT, "end", 0.02)
tail += "</svg>"
# Before the agent has a number (its profile published ahead of its ERC-8004 registration).
unnumbered = text("Ostra Agent", "sans", 800, 120, 72, 865, LIGHT, "start", -0.02)

f = load("sans", 800)
gs, cmap, upm = f.getGlyphSet(), f.getBestCmap(), f["head"].unitsPerEm
glyphs = {}
for ch in "#0123456789":
    pen = RoundPen(gs)
    gs[cmap[ord(ch)]].draw(pen)
    glyphs[ch] = (pen.getCommands(), gs[cmap[ord(ch)]].width)

lines = [
    "// The Ostra agent card: the image of every Ostra agent's ERC-8004 registration file (design \"Ink\", chosen 29 Oct",
    "// 2026). A deterministic SVG of 1000 x 1000: the same agent id gives the same bytes on every machine, so the",
    "// uploader builds the very file an agent asks for and pins it (uploader POST /v1/ipfs/agent-card). Every letter is",
    "// a path from Ostra's brand fonts (Schibsted Grotesk, JetBrains Mono; SIL Open Font License 1.1), so it renders",
    "// without fonts and holds no script, link or external reference. Written by a generator from the fonts",
    "// (sdk/scripts/agent-card.py); change the generator, not this file.",
    "",
    "/** A new design is a new version: its files are new CIDs, and cards pinned before stay as they are. */",
    "export const AGENT_CARD_VERSION = 1;",
    "",
    "/** The card's media type, as the uploader pins it. */",
    'export const AGENT_CARD_TYPE = "image/svg+xml";',
    "",
    f"const HEAD = {json.dumps(head)};",
    f"const TAIL = {json.dumps(tail)};",
    "/** In place of the number before the agent is registered (its first profile is published ahead of its registration). */",
    f"const UNNUMBERED = {json.dumps(unnumbered)};",
    f"/** Schibsted Grotesk 800 (units per em {upm}): each glyph's outline in font units (y up) and its advance width. */",
    "const DIGITS: Readonly<Record<string, readonly [string, number]>> = {",
]
for ch, (d, w) in glyphs.items():
    lines.append(f"  {json.dumps(ch)}: [{json.dumps(d)}, {w}],")
lines += [
    "};",
    f"const UPM = {upm};",
    "/** The number: its baseline, left edge, largest size, the widest it may run, and its letter spacing (em). */",
    "const NUMBER = { x: 72, y: 880, size: 210, maxWidth: 848, tracking: -0.02, fill: \"#F4F5F6\" } as const;",
    "",
    "/** A number as the card writes it: at most 3 decimals, trailing zeros dropped (so every machine writes the same). */",
    "function n(v: number): string {",
    "  const s = (Math.round(v * 1000) / 1000).toString();",
    "  return s === \"-0\" ? \"0\" : s;",
    "}",
    "",
    "/**",
    " * The card of agent `agentId` (its ERC-8004 id, decimal), or the card without a number when `agentId` is null. The",
    " * number is set at 210 px and made smaller only as far as it must to fit the card.",
    " */",
    "export function agentCardSvg(agentId: string | null): string {",
    "  if (agentId === null) return HEAD + UNNUMBERED + TAIL;",
    "  if (!/^(0|[1-9][0-9]{0,29})$/.test(agentId)) throw new RangeError(\"an agent id is a decimal number of at most 30 digits\");",
    "  const text = `#${agentId}`;",
    "  const advance = [...text].reduce((sum, c) => sum + (DIGITS[c] as readonly [string, number])[1], 0);",
    "  const widthAt = (size: number) => (advance * size) / UPM + NUMBER.tracking * size * (text.length - 1);",
    "  const full = widthAt(NUMBER.size);",
    "  const size = full > NUMBER.maxWidth ? (NUMBER.size * NUMBER.maxWidth) / full : NUMBER.size;",
    "  const k = size / UPM;",
    "  let x = NUMBER.x;",
    "  let body = \"\";",
    "  for (const c of text) {",
    "    const [d, w] = DIGITS[c] as readonly [string, number];",
    "    body += `<path transform=\"matrix(${n(k)} 0 0 ${n(-k)} ${n(x)} ${NUMBER.y})\" d=\"${d}\" fill=\"${NUMBER.fill}\"/>`;",
    "    x += w * k + NUMBER.tracking * size;",
    "  }",
    "  return HEAD + body + TAIL;",
    "}",
    "",
]
open(sys.argv[2], "w").write("\n".join(lines))
print("wrote", sys.argv[2])
