#!/usr/bin/env python3
"""
Derive every brand asset the app ships from the single master lockup.

    python3 brand/build-brand-assets.py          (needs Pillow)

You should not normally need to run this. The outputs are committed under
frontend/public/ — this script exists so the derivation is reproducible and
reviewable, not because it is part of the build.

WHY THIS EXISTS
---------------
The master file (brand/logo-source.png) is 1536x1024 and 2.1MB, and it is a
STACKED lockup: the DH monogram sits above the DATAHOOD wordmark, above a
tagline. Neither property survives contact with the app:

  * 2.1MB is unacceptable in the bundle. This platform's users are Nigerian
    resellers on metered mobile data, and the logo renders on the login page
    — the very first paint, before anyone has decided to trust the site.

  * A stacked lockup cannot go where the app puts a logo. The sidebar and the
    auth pages set it beside the word DATAHOOD in themed text; using the full
    lockup there prints the wordmark twice. The receipt header gives it 34px
    of height, at which the tagline renders about two pixels tall.

So the master is cut into two derivatives and the app uses whichever matches
the slot:

  logo-mark.png    the DH monogram alone, square. For anywhere the word
                   DATAHOOD already appears as live text (sidebar, auth
                   pages) and for the favicon/PWA icons.

  logo-lockup.png  monogram and wordmark side by side, horizontal. For the
                   receipts, where there is no themed text to sit next to —
                   canvas and PDF draw the image alone.

The tagline is dropped from both. It is set at roughly 1/7 the monogram's
height in the master, so it is illegible at every size the app renders a
logo at, and it only adds weight.

Band offsets below were measured off the master's alpha channel, not eyeballed
— see the y-ranges in BANDS. If the master is ever replaced, re-measure; the
constants are specific to this file.
"""

import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'logo-source.png')
OUT = os.path.abspath(os.path.join(HERE, '..', 'frontend', 'public'))

# Deep navy from the wordmark — the brand's darkest colour. Used as the flat
# backdrop for the iOS icon, which cannot be transparent (iOS composites an
# alpha icon onto black and the navy mark disappears into it).
NAVY = (16, 48, 107)

# Alpha-measured content bands in the master. (y0, y1, x0, x1), y1/x1 exclusive.
BANDS = {
    'mark': (247, 510, 612, 922),   # 310 x 263 DH monogram
    'word': (593, 680, 402, 1136),  # 734 x  87 DATAHOOD wordmark
    # 'tag': (713, 752, 425, 1111)  deliberately unused — see module docstring
}


def band(im, key):
    y0, y1, x0, x1 = BANDS[key]
    return im.crop((x0, y0, x1, y1))


def square(im, size, pad=0.10, bg=None):
    """Fit `im` inside a square canvas, preserving aspect, with `pad` margin."""
    inner = int(size * (1 - 2 * pad))
    w, h = im.size
    scale = min(inner / w, inner / h)
    im = im.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (bg + (255,)) if bg else (0, 0, 0, 0))
    canvas.paste(im, ((size - im.size[0]) // 2, (size - im.size[1]) // 2), im)
    return canvas


def save(im, name, quantize=True):
    """
    Write a PNG, palette-quantised unless told otherwise.

    The artwork is a blue->cyan gradient, which is the worst case for PNG's
    row filters — truecolour RGBA output runs 3-5x larger than it needs to.
    FASTOCTREE is used rather than the default median cut because it is the
    only Pillow quantiser that keeps an alpha channel; the default would
    flatten the transparent margin to a colour.

    255 colours (not 256) leaves the palette a slot for full transparency.
    """
    path = os.path.join(OUT, name)
    out = im
    if quantize and im.mode == 'RGBA':
        out = im.quantize(colors=255, method=Image.FASTOCTREE)
    out.save(path, 'PNG', optimize=True)
    print(f'  {name:28} {im.size[0]:>4}x{im.size[1]:<4} {os.path.getsize(path) / 1024:7.1f} KB')


def main():
    src = Image.open(SRC).convert('RGBA')
    mark = band(src, 'mark')
    word = band(src, 'word')

    print('brand assets ->', OUT)

    # ---- horizontal lockup: monogram + wordmark, optically balanced ----
    # The wordmark is set to 46% of the monogram's height. That is the ratio
    # in the master (87/263 = 0.33 for the raw glyph box, but the wordmark's
    # box is all cap-height while the monogram's includes its swoosh), and it
    # is what makes the two read as the same weight rather than the word
    # looking shrunken.
    H = 128
    mw = round(mark.size[0] * H / mark.size[1])
    m = mark.resize((mw, H), Image.LANCZOS)
    wh = round(H * 0.46)
    ww = round(word.size[0] * wh / word.size[1])
    w = word.resize((ww, wh), Image.LANCZOS)

    gap = round(H * 0.18)
    lockup = Image.new('RGBA', (mw + gap + ww, H), (0, 0, 0, 0))
    lockup.paste(m, (0, 0), m)
    lockup.paste(w, (mw + gap, (H - wh) // 2), w)
    save(lockup, 'logo-lockup.png')

    # ---- square mark, transparent ----
    # 128px, not 512: the app draws this at 28-30px, so 128 still covers a 4x
    # display. The manifest icons below are the ones that genuinely need size.
    save(square(mark, 128), 'logo-mark.png')
    save(square(mark, 192), 'icon-192.png')
    save(square(mark, 512), 'icon-512.png')

    # Maskable: Android crops icons to a circle/squircle and clips anything
    # outside the inner 80%. Needs a filled background and a bigger margin so
    # the monogram survives the crop.
    save(square(mark, 512, pad=0.22, bg=(255, 255, 255)), 'icon-512-maskable.png')

    # iOS home screen — opaque, no alpha, no rounding (iOS applies its own).
    save(square(mark, 180, pad=0.14, bg=NAVY).convert('RGB'), 'apple-touch-icon.png', quantize=False)

    # Browser tab.
    save(square(mark, 32, pad=0.06), 'favicon-32.png')

    # ---- optimised replacement for the 2.1MB master in public/ ----
    # Same stacked artwork, trimmed of its transparent margin and sized for
    # the largest slot that could ever want it.
    full = src.crop(src.getchannel('A').getbbox())
    fw = 600
    save(full.resize((fw, round(full.size[1] * fw / full.size[0])), Image.LANCZOS), 'logo.png')


if __name__ == '__main__':
    main()
