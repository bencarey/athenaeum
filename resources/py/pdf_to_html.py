#!/usr/bin/env python3
"""Athenaeum PDF -> reading-order Markdown + extracted images/charts.

Usage:  python3 pdf_to_html.py <src.pdf> <outDir>

Writes images into <outDir>/images and prints a JSON manifest to stdout:
  text mode:  {"mode":"text","markdown":..,"images":[..],"title":..,"pageCount":n,"warnings":[..]}
  page mode:  {"mode":"pages","images":[..],"title":..,"pageCount":n}      (scanned / no text layer)

Charts in these reports are usually drawn as vector graphics. pymupdf4llm pulls
their axis/series labels out as a text dump and never renders the chart itself.
So before text extraction we detect dense vector-graphic clusters, rasterize
each to a PNG, and redact that region from the page so its labels don't leak
into the prose.
"""
import sys, os, json, re


def _overlap_frac(a, b):
    """Fraction of rect a covered by its intersection with rect b."""
    inter = a & b
    if inter.is_empty:
        return 0.0
    aa = abs(a.width * a.height) or 1
    return abs(inter.width * inter.height) / aa


def find_chart_rects(page, table_rects):
    """Return Rects for dense vector-graphic clusters (charts/diagrams), skipping
    full-bleed layout panels, sparse decoration, and anything overlapping a table
    (so real data tables stay tables, not images)."""
    try:
        clusters = page.cluster_drawings()
    except Exception:
        return []
    drawings = page.get_drawings()
    pw, ph = page.rect.width, page.rect.height
    parea = pw * ph or 1
    out = []
    for rc in clusters:
        if rc.is_empty or rc.is_infinite:
            continue
        frac = abs(rc.width * rc.height) / parea
        if frac < 0.04 or frac > 0.85:
            continue
        if rc.width < 80 or rc.height < 80:
            continue
        # skip full-bleed background panels (sidebars, page frames)
        if rc.height > 0.95 * ph or rc.width > 0.97 * pw:
            continue
        # don't rasterize tables
        if any(_overlap_frac(rc, tr) > 0.3 or _overlap_frac(tr, rc) > 0.6 for tr in table_rects):
            continue
        # Enough vector strokes to be a chart/diagram. Simple line charts have very
        # few paths (a handful of lines + axes), so keep this low; ruled tables are
        # already excluded above via find_tables().
        contained = [d for d in drawings if rc.intersects(d["rect"])]
        if len(contained) < 4:
            continue
        out.append(rc)
    out.sort(key=lambda r: r.y0)
    return out


def is_graphic_table(tab):
    """True when find_tables() detected what is really a designed 'exhibit'
    infographic, not a data table: cells hold wrapped prose / phrases and the
    grid is sparse. Such tables shred into unreadable HTML in a narrow reading
    column, so we rasterize them instead. Genuine data tables (short numeric or
    label cells, densely filled) return False and stay as real tables."""
    try:
        rows = tab.extract()
    except Exception:
        return False
    if not rows:
        return False
    ncols = max((len(r) for r in rows), default=0)
    cells = [c for r in rows for c in r]
    filled = [re.sub(r"\s+", " ", c).strip() for c in cells if c and c.strip()]
    n_cells = len(cells) or 1
    if not filled or ncols < 3:
        return False
    lens = [len(c) for c in filled]
    avg_len = sum(lens) / len(lens)
    # Genuine 'infographic' tables fill every cell with full sentences (very high
    # average length). Real data tables — even sparse ones or ones with verbose
    # multi-line headers — keep short data cells (avg well under 100), so they stay
    # readable tables. A long header alone must not trip this.
    return avg_len > 120


def find_exhibit_rects(page, fitz):
    """McKinsey-style 'Exhibit N' graphics (icon/shaded-cell grids, before/after
    diagrams, comparison panels with embedded bars) get shredded by pymupdf4llm
    into unreadable tables and their column/row labels leak as stray text. They
    vary too much to detect by shape, but they share a layout: an 'Exhibit N'
    marker, a large-font title, then a graphic *band* that runs full content width
    until the next body heading or the page footer. We rasterize that whole band as
    one image. The 'Exhibit N' marker and title sit above the band, so they stay as
    readable text headings."""
    blocks = [b for b in page.get_text("dict").get("blocks", []) if b.get("type") == 0]
    pw, ph = page.rect.width, page.rect.height
    parea = pw * ph or 1

    def avgsz(b):
        s = [sp["size"] for ln in b.get("lines", []) for sp in ln.get("spans", [])]
        return sum(s) / len(s) if s else 0

    def text(b):
        return " ".join(sp["text"] for ln in b.get("lines", []) for sp in ln.get("spans", [])).strip()

    # locate an 'Exhibit/Figure/Chart N' marker — standalone, or at the start of a
    # title line. Guarded against inline references ("Figure 1 shows ...") by
    # requiring what follows the number to be empty, punctuation, or a capitalized
    # title rather than a lowercase sentence continuation. The graphic-presence
    # check below is the backstop: a caption with no figure under it never fires.
    ex_y = None
    for b in blocks:
        lines = b.get("lines", [])
        if not lines:
            continue
        line0 = "".join(s["text"] for s in lines[0].get("spans", [])).strip()
        m = re.match(r"^(?:Exhibit|Figure|Chart)\s+\d+\b\s*(.*)$", line0)
        if not m:
            continue
        rest = m.group(1).strip()
        if rest and rest[0] not in ":.—–-" and not rest[0].isupper():
            continue  # inline reference, e.g. "Figure 1 shows the trend"
        ex_y = b["bbox"][1] if ex_y is None else min(ex_y, b["bbox"][1])
    if ex_y is None:
        return []

    # band starts just below the title block(s): large-font lines near the marker
    band_top = ex_y
    for b in blocks:
        y0 = b["bbox"][1]
        if y0 < ex_y - 2 or y0 > ex_y + 70:
            continue
        if avgsz(b) >= 10.5:
            band_top = max(band_top, b["bbox"][3])

    # band ends at the next body heading or full-width body paragraph (not a
    # narrow exhibit column, which can also be long), else the page footer.
    footer_y = ph - 34
    band_bottom = footer_y
    for b in sorted(blocks, key=lambda b: b["bbox"][1]):
        y0 = b["bbox"][1]
        if y0 <= band_top + 4 or y0 >= footer_y:
            continue
        bw = b["bbox"][2] - b["bbox"][0]
        sz, t = avgsz(b), text(b)
        # A body resumption spans the full content width. Big exhibit figures
        # ("5–10%", "80%") are also large-font but sit in narrow columns, so the
        # width gate keeps them inside the band.
        is_heading = sz >= 11 and bw > 0.5 * pw
        is_body_para = 8.5 <= sz <= 10.8 and bw > 0.55 * pw and len(t) > 140
        if is_heading or is_body_para:
            band_bottom = y0 - 6
            break
    if band_bottom - band_top < 40:
        return []

    # the band must actually contain a graphic (drawing cluster or embedded image),
    # else it is a plain text callout — leave it alone.
    band = fitz.Rect(0, band_top, pw, band_bottom)
    graphic = False
    try:
        for c in page.cluster_drawings():
            if not (c.is_empty or c.is_infinite) and band.intersects(c):
                graphic = True
                break
    except Exception:
        pass
    if not graphic:
        for im in page.get_image_info():
            ib = fitz.Rect(im["bbox"])
            if band.intersects(ib) and abs(ib.width * ib.height) > 200:
                graphic = True
                break
    if not graphic:
        return []

    # horizontal extent = span of everything sitting inside the band
    x0, x1 = pw, 0.0
    for b in blocks:
        bb = b["bbox"]
        if bb[1] >= band_top - 2 and bb[3] <= band_bottom + 2:
            x0, x1 = min(x0, bb[0]), max(x1, bb[2])
    for im in page.get_image_info():
        ib = im["bbox"]
        if ib[1] >= band_top - 2 and ib[3] <= band_bottom + 6:
            x0, x1 = min(x0, ib[0]), max(x1, ib[2])
    if x1 <= x0:
        return []
    rect = (fitz.Rect(x0, band_top, x1, band_bottom) + (-8, -6, 8, 6)) & page.rect
    if abs(rect.width * rect.height) / parea > 0.9:
        return []
    return [rect]


def expand_with_labels(page, rc):
    """Grow a chart rect to swallow adjacent axis/legend labels (small, short text
    blocks) so they are rasterized into the chart image and removed from the prose.
    Title/body text (larger font, many lines) is left alone."""
    import fitz
    # grow toward the sides and bottom (axis/legend labels live there); barely
    # upward, so a chart title sitting just above is preserved as a heading.
    grown = (rc + (-22, -6, 22, 24)) & page.rect
    base_area = abs(rc.width * rc.height) or 1
    out = fitz.Rect(rc)
    try:
        blocks = page.get_text("dict").get("blocks", [])
    except Exception:
        return out
    for b in blocks:
        if b.get("type") != 0:
            continue
        bb = fitz.Rect(b["bbox"])
        if bb.height > 28:  # a tall block is a paragraph, not an axis/legend row
            continue
        lines = b.get("lines", [])
        sizes = [s["size"] for ln in lines for s in ln.get("spans", [])]
        if not sizes or (sum(sizes) / len(sizes)) > 12:
            continue
        if not grown.intersects(bb):
            continue
        inter = bb & grown
        if abs(inter.width * inter.height) < 0.55 * (abs(bb.width * bb.height) or 1):
            continue
        cand = out | bb
        if abs(cand.width * cand.height) > 2.4 * base_area:
            continue
        out = cand
    return out & page.rect


def clean_running_artifacts(md):
    """Drop standalone page numbers and repeated running headers/footers (e.g. a
    document title printed at the foot of every page)."""
    from collections import Counter
    norm = lambda s: re.sub(r"\s+", " ", s.strip())
    base = lambda s: re.sub(r"^\d{1,4}\s+|\s+\d{1,4}$", "", norm(s)).strip()
    lines = md.split("\n")
    cnt = Counter()
    for l in lines:
        s = norm(l)
        if s and not s.startswith("#") and not s.startswith("!["):
            b = base(s)
            if b and len(b) < 70:
                cnt[b] += 1
    repeated = {b for b, c in cnt.items() if c >= 4}
    out = []
    for l in lines:
        if not l.strip():
            out.append(l); continue
        s = norm(l)
        if not s.startswith("#") and not s.startswith("!["):
            if re.fullmatch(r"\d{1,3}", s):          # bare page number
                continue
            if base(s) in repeated:                  # running header/footer
                continue
        out.append(l)
    return "\n".join(out)


def relevel_headings(md, doc, fitz):
    """Re-assign markdown heading levels (#, ##, ###) by relative font size, so the
    table of contents has a usable hierarchy. pymupdf4llm tends to flatten every
    heading to one level; ranking by font size restores depth for most documents."""
    size_map = {}
    for pno in range(doc.page_count):
        try:
            blocks = doc[pno].get_text("dict").get("blocks", [])
        except Exception:
            continue
        for b in blocks:
            if b.get("type") != 0:
                continue
            for ln in b.get("lines", []):
                spans = ln.get("spans", [])
                txt = "".join(s["text"] for s in spans).strip()
                if not txt:
                    continue
                sz = max((s["size"] for s in spans), default=0)
                key = re.sub(r"\s+", " ", txt)[:60]
                if sz > size_map.get(key, 0):
                    size_map[key] = sz

    def size_of(text):
        return size_map.get(re.sub(r"\s+", " ", re.sub(r"[*`#]", "", text).strip())[:60], 0)

    lines = md.split("\n")
    sizes = [round(size_of(m.group(1))) for m in (re.match(r"^#{1,6}\s+(.*)$", l) for l in lines)
             if m and size_of(m.group(1))]
    uniq = sorted(set(s for s in sizes if s), reverse=True)
    if len(uniq) < 2:
        return md  # nothing to differentiate

    def level_of(text):
        s = round(size_of(text))
        if not s:
            return 2
        if s in uniq:
            return min(uniq.index(s), 2) + 1
        return min(range(len(uniq)), key=lambda i: abs(uniq[i] - s)) + 1

    out = []
    for l in lines:
        m = re.match(r"^#{1,6}\s+(.*)$", l)
        out.append(("#" * level_of(m.group(1)) + " " + m.group(1)) if m else l)
    return "\n".join(out)


def clean_raster_labels(page, fitz):
    """Remove small axis/legend text overlapping extracted raster images (the
    image is kept; only the leaked label text is redacted)."""
    try:
        img_rects = [fitz.Rect(i["bbox"]) for i in page.get_image_info()]
    except Exception:
        return
    if not img_rects:
        return
    pw, ph = page.rect.width, page.rect.height
    parea = (pw * ph) or 1
    blocks = page.get_text("dict").get("blocks", [])
    annots = []
    for ir in img_rects:
        a = abs(ir.width * ir.height)
        # only chart-sized images: skip thumbnails, and skip large/full-bleed
        # background images and banners (their overlapping text IS body text)
        if a < 0.03 * parea or ir.width < 80 or ir.height < 80:
            continue
        if a > 0.45 * parea or ir.width > 0.9 * pw or ir.height > 0.85 * ph:
            continue
        grown = (ir + (-20, -10, 20, 34)) & page.rect  # mostly downward (footnotes below)
        for b in blocks:
            if b.get("type") != 0:
                continue
            bb = fitz.Rect(b["bbox"])
            if not grown.intersects(bb):
                continue
            sizes = [s["size"] for ln in b.get("lines", []) for s in ln.get("spans", [])]
            if not sizes or sum(sizes) / len(sizes) > 12:  # small font only
                continue
            txt = "".join(s["text"] for ln in b.get("lines", []) for s in ln.get("spans", [])).strip()
            bb_area = abs(bb.width * bb.height) or 1
            inside = abs((bb & ir).width * (bb & ir).height) / bb_area
            is_caption = bool(re.match(r"^(Note\s*\d|Source[:\s]|Exhibit|\d[\d\s,.%$–-]*$)", txt))
            if inside > 0.5:                                    # overlaid on the chart
                annots.append(bb)
            elif bb.height <= 26 and len(txt) <= 40:            # short label in the margin
                annots.append(bb)
            elif is_caption and len(txt) < 420:                # chart caption / footnote
                annots.append(bb)
    for a in annots:
        page.add_redact_annot(a, fill=(1, 1, 1))
    if annots:
        try:
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
        except Exception:
            pass


def prep_llm(doc, out_dir, images_dir, fitz):
    """Prep for the LLM-vision pipeline. Render each page to a full image (which a
    vision model transcribes into clean text), and collect the page's real visuals
    so they can be inlined alongside that text, ordered top-to-bottom:
      - chart/exhibit figure regions are rasterized (tagged 'chart' / 'exhibit');
      - embedded raster images (photos, graphics, diagrams) are extracted (tagged
        'image'), filtered to drop tiny icons, full-bleed page backgrounds, logos
        or watermarks repeated across pages, and anything already covered by a
        captured chart/exhibit.
    No text extraction; the page images are the untouched originals."""
    import collections
    page_count = doc.page_count
    warnings = []
    page_images = []
    for pno in range(page_count):
        name = f"page-{pno+1:03d}.png"
        try:
            doc[pno].get_pixmap(dpi=170).save(os.path.join(images_dir, name))
            page_images.append(f"images/{name}")
        except Exception as e:
            page_images.append(None)
            warnings.append(f"page {pno+1}: render failed ({str(e)[:50]})")

    # how many pages each embedded image appears on (logos/watermarks repeat)
    xref_pages = collections.defaultdict(set)
    for pno in range(page_count):
        try:
            for info in doc[pno].get_image_info(xrefs=True):
                xr = info.get("xref", 0)
                if xr:
                    xref_pages[xr].add(pno)
        except Exception:
            pass

    page_figs = {}
    for pno in range(page_count):
        page = doc[pno]
        pw, ph = page.rect.width, page.rect.height
        parea = pw * ph or 1
        try:
            found = page.find_tables().tables
        except Exception:
            found = []
        exhibit_ids = {id(t) for t in found if is_graphic_table(t)}
        real_table_rects = [fitz.Rect(t.bbox) for t in found if id(t) not in exhibit_ids]
        exhibit_rects = [fitz.Rect(t.bbox) for t in found if id(t) in exhibit_ids]
        charts = find_chart_rects(page, real_table_rects)
        exhibit_bands = find_exhibit_rects(page, fitz)
        in_band = lambda rc: any(_overlap_frac(rc, band) > 0.4 for band in exhibit_bands)
        targets = [("exhibit", rc) for rc in exhibit_bands]
        targets += [("chart", expand_with_labels(page, rc)) for rc in charts if not in_band(rc)]
        targets += [("exhibit", (rc + (-10, -8, 10, 12)) & page.rect) for rc in exhibit_rects if not in_band(rc)]

        items = []          # (y0, {img, type}) — sorted into reading order below
        captured = []       # rects already represented, to dedup embedded images
        for i, (typ, rc) in enumerate(targets):
            clip = (rc + (-4, -4, 4, 4)) & page.rect
            try:
                fn = f"fig-{pno+1:03d}-{i+1}.png"
                page.get_pixmap(clip=clip, dpi=150).save(os.path.join(images_dir, fn))
                items.append((clip.y0, {"img": f"images/{fn}", "type": typ}))
                captured.append(clip)
            except Exception as e:
                warnings.append(f"page {pno+1}: raster failed ({str(e)[:50]})")

        # embedded raster images (photos, graphics) the region detectors miss
        seen = set()
        try:
            infos = page.get_image_info(xrefs=True)
        except Exception:
            infos = []
        for info in infos:
            xr = info.get("xref", 0)
            if not xr or xr in seen:
                continue
            seen.add(xr)
            bb = fitz.Rect(info["bbox"])
            w, h = abs(bb.width), abs(bb.height)
            frac = (w * h) / parea
            if w < 64 or h < 64 or frac < 0.02 or frac > 0.85:
                continue  # icon/logo, tiny, or full-bleed background
            if len(xref_pages.get(xr, ())) > max(2, page_count * 0.4):
                continue  # repeated header/footer logo or watermark
            if any(_overlap_frac(bb, rc) > 0.5 or _overlap_frac(rc, bb) > 0.5 for rc in captured):
                continue  # already captured as a chart/exhibit
            try:
                # Render the image through a Pixmap so the output is always a
                # browser-safe format (raw embeds may be JPEG2000/CMYK, which
                # Chromium can't show). JPEG keeps photos small; PNG preserves
                # transparency. Downscale very large images for the reading view.
                pix = fitz.Pixmap(doc, xr)
                if pix.n - pix.alpha >= 4:        # CMYK / DeviceN -> RGB
                    pix = fitz.Pixmap(fitz.csRGB, pix)
                while max(pix.width, pix.height) > 1500:
                    pix.shrink(1)                 # halve dimensions in place
                if pix.alpha:
                    data, extn = pix.tobytes(output="png"), "png"
                else:
                    data, extn = pix.tobytes(output="jpeg", jpg_quality=82), "jpg"
                pix = None
                fn = f"emb-{pno+1:03d}-{xr}.{extn}"
                with open(os.path.join(images_dir, fn), "wb") as f:
                    f.write(data)
                items.append((bb.y0, {"img": f"images/{fn}", "type": "image"}))
                captured.append(bb)
            except Exception as e:
                warnings.append(f"page {pno+1}: image extract failed ({str(e)[:50]})")

        if items:
            items.sort(key=lambda t: t[0])
            page_figs[str(pno)] = [it[1] for it in items]
    return {"mode": "llm-prep", "pageCount": page_count,
            "pageImages": page_images, "figures": page_figs, "warnings": warnings}


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: pdf_to_html.py <src> <outDir>"})); sys.exit(1)
    src, out_dir = sys.argv[1], sys.argv[2]
    images_dir = os.path.join(out_dir, "images")
    os.makedirs(images_dir, exist_ok=True)

    import fitz  # PyMuPDF
    try:
        fitz.TOOLS.mupdf_display_errors(False)
    except Exception:
        pass
    doc = fitz.open(src)
    page_count = doc.page_count
    title = (doc.metadata or {}).get("title") or ""
    pdf_author = (doc.metadata or {}).get("author") or ""
    warnings = []

    # cover screenshot of the first page, for the document opener
    cover = None
    try:
        doc[0].get_pixmap(dpi=140).save(os.path.join(out_dir, "cover.png"))
        cover = "cover.png"
    except Exception:
        pass

    # LLM-vision prep mode: render page images + figure rasters, no text extraction
    if "--prep-llm" in sys.argv:
        res = prep_llm(doc, out_dir, images_dir, fitz)
        res.update({"title": title, "cover": cover, "author": pdf_author})
        return res

    # Is there a real text layer?
    text_len = sum(len(doc[i].get_text("text")) for i in range(page_count))
    if text_len < max(40, page_count * 20):
        refs = []
        for i in range(page_count):
            pix = doc[i].get_pixmap(dpi=150)
            name = f"page-{i+1:03d}.png"
            pix.save(os.path.join(images_dir, name))
            refs.append(f"images/{name}")
        return {"mode": "pages", "images": refs, "title": title, "pageCount": page_count,
                "cover": cover, "author": pdf_author}

    # ---- chart/exhibit pass: rasterize dense vector clusters and complex graphic
    #      tables, redact them, then strip labels leaking around raster images ----
    page_charts = {}  # page index -> [relative image paths]
    for pno in range(page_count):
        page = doc[pno]
        try:
            found = page.find_tables().tables
        except Exception:
            found = []
        # graphic 'exhibit' tables get rasterized like charts; real data tables
        # stay tables and keep blocking chart detection over their region.
        exhibit_ids = {id(t) for t in found if is_graphic_table(t)}
        real_table_rects = [fitz.Rect(t.bbox) for t in found if id(t) not in exhibit_ids]
        exhibit_rects = [fitz.Rect(t.bbox) for t in found if id(t) in exhibit_ids]
        charts = find_chart_rects(page, real_table_rects)
        # 'Exhibit N' graphics: rasterize the whole exhibit band first. It takes
        # precedence — any chart/graphic-table inside it is part of the same image,
        # so we drop those sub-rasters to avoid clipping labels or double-capture.
        exhibit_bands = find_exhibit_rects(page, fitz)
        in_band = lambda rc: any(_overlap_frac(rc, band) > 0.4 for band in exhibit_bands)
        targets = list(exhibit_bands)
        targets += [expand_with_labels(page, rc) for rc in charts if not in_band(rc)]
        targets += [(rc + (-10, -8, 10, 12)) & page.rect for rc in exhibit_rects if not in_band(rc)]
        names = []
        for i, rc in enumerate(targets):
            clip = (rc + (-4, -4, 4, 4)) & page.rect
            try:
                page.get_pixmap(clip=clip, dpi=150).save(os.path.join(images_dir, f"chart-{pno+1:03d}-{i+1}.png"))
                names.append(f"images/chart-{pno+1:03d}-{i+1}.png")
                page.add_redact_annot(clip, fill=(1, 1, 1))
            except Exception as e:
                warnings.append(f"page {pno+1}: raster failed ({str(e)[:50]})")
        if names:
            try:
                page.apply_redactions()
            except Exception:
                pass
            page_charts[pno] = names
        clean_raster_labels(page, fitz)

    # ---- text extraction on the (chart-redacted) document ----
    md = None
    cwd = os.getcwd()
    try:
        import pymupdf4llm
        os.chdir(out_dir)  # so "images/..." refs resolve relatively
        chunks = pymupdf4llm.to_markdown(
            doc, write_images=True, image_path="images", image_format="png",
            dpi=150, page_chunks=True, show_progress=False, ignore_graphics=True
        )
        parts = []
        for pno, chunk in enumerate(chunks):
            t = chunk.get("text", "") if isinstance(chunk, dict) else str(chunk)
            parts.append(t)
            for ref in page_charts.get(pno, []):
                parts.append(f"\n![]({ref})\n")
        md = "\n\n".join(parts)
    except Exception as e:
        warnings.append("pymupdf4llm unavailable, used block fallback: " + str(e)[:120])
        md = None
    finally:
        os.chdir(cwd)

    if md is None:
        md = block_fallback(doc, images_dir)
        for pno in sorted(page_charts):
            for ref in page_charts[pno]:
                md += f"\n\n![]({ref})"

    md = md or ""
    # drop blank (all-white) extracted images and their references. Redaction can
    # leave white rectangles that the extractor saves as useless images.
    md = drop_blank_images(md, out_dir, fitz)
    # strip pymupdf4llm's in-image OCR scaffolding markers for a clean reading view
    md = re.sub(r"\*\*-+ (?:Start|End) of picture text -+\*\*(?:<br>)?", "", md)
    md = re.sub(r"\n{3,}", "\n\n", md).strip()
    md = clean_running_artifacts(md)
    # normalize literal bullet glyphs into real markdown list items
    md = re.sub(r"(?m)^\s*[•·‣◦▪●○∙]\s+", "- ", md)
    md = relevel_headings(md, doc, fitz)
    if not title:
        m = re.search(r"^#+\s+(.+)$", md, re.M)
        if m:
            title = m.group(1).strip()

    return {
        "mode": "text", "markdown": md, "images": [], "title": title,
        "pageCount": page_count, "warnings": warnings, "cover": cover, "author": pdf_author
    }


def drop_blank_images(md, out_dir, fitz):
    """Remove image references whose file is essentially all white, and delete
    the files. These come from redacted regions the extractor re-saved as images."""
    refs = set(re.findall(r"images/[^\s)\"']+\.png", md))
    blanks = set()
    for ref in refs:
        full = os.path.join(out_dir, ref)
        try:
            pix = fitz.Pixmap(full)
            # Essentially blank: virtually every sample is near-white. A few stray
            # dark pixels (redaction anti-aliasing, a hairline border) shouldn't keep
            # a visually-empty image, so test the fraction rather than the minimum.
            # Sample with a stride to stay fast on large full-page images.
            sample = bytes(pix.samples[::7])
            dark = sum(1 for v in sample if v < 240)
            if dark / (len(sample) or 1) < 0.01:
                blanks.add(ref)
                os.remove(full)
        except Exception:
            pass
    if blanks:
        kept = [ln for ln in md.split("\n")
                if not ("![" in ln and any(b in ln for b in blanks))]
        md = "\n".join(kept)
    return md


def block_fallback(doc, images_dir):
    """Manual reading-order extraction using PyMuPDF blocks + image export."""
    import fitz
    parts = []
    img_n = 0
    for pno in range(doc.page_count):
        page = doc[pno]
        blocks = page.get_text("dict")["blocks"]
        mid = page.rect.width / 2
        def key(b):
            x0, y0 = b["bbox"][0], b["bbox"][1]
            return (0 if x0 < mid else 1, round(y0))
        for b in sorted(blocks, key=key):
            if b.get("type") == 1:
                try:
                    img_n += 1
                    name = f"img-{img_n:03d}.png"
                    pix = fitz.Pixmap(b["image"])
                    if pix.n - pix.alpha >= 4:
                        pix = fitz.Pixmap(fitz.csRGB, pix)
                    pix.save(os.path.join(images_dir, name))
                    parts.append(f"![](images/{name})")
                except Exception:
                    pass
                continue
            sizes, text = [], []
            for line in b.get("lines", []):
                for span in line.get("spans", []):
                    sizes.append(span["size"]); text.append(span["text"])
            line_text = "".join(text).strip()
            if not line_text:
                continue
            avg = sum(sizes) / len(sizes) if sizes else 0
            if avg >= 16:
                parts.append("# " + line_text)
            elif avg >= 13:
                parts.append("## " + line_text)
            else:
                parts.append(line_text)
        parts.append("")
    return "\n\n".join(parts)


if __name__ == "__main__":
    # MuPDF's native library writes warnings/errors to the process stdout, which
    # would corrupt our JSON. Redirect fd 1 to stderr during processing and only
    # restore it to emit the final manifest.
    saved_fd = os.dup(1)
    os.dup2(2, 1)
    try:
        result = main()
        payload = json.dumps(result)
        code = 0
    except Exception as e:
        payload = json.dumps({"error": str(e)})
        code = 1
    finally:
        sys.stdout.flush()
        os.dup2(saved_fd, 1)
        os.close(saved_fd)
    sys.stdout.write(payload)
    sys.stdout.flush()
    sys.exit(code)
