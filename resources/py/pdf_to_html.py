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
        grown = (ir + (-18, -18, 18, 18)) & page.rect
        for b in blocks:
            if b.get("type") != 0:
                continue
            bb = fitz.Rect(b["bbox"])
            if bb.height > 26:
                continue
            txt = "".join(s["text"] for ln in b.get("lines", []) for s in ln.get("spans", [])).strip()
            if len(txt) > 36:  # labels are short; longer means body text
                continue
            sizes = [s["size"] for ln in b.get("lines", []) for s in ln.get("spans", [])]
            if not sizes or sum(sizes) / len(sizes) > 12:
                continue
            if not grown.intersects(bb):
                continue
            inter = bb & grown
            if abs(inter.width * inter.height) < 0.5 * (abs(bb.width * bb.height) or 1):
                continue
            annots.append(bb)
    for a in annots:
        page.add_redact_annot(a, fill=(1, 1, 1))
    if annots:
        try:
            page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE)
        except Exception:
            pass


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
            table_rects = [fitz.Rect(t.bbox) for t in page.find_tables().tables]
        except Exception:
            table_rects = []
        charts = find_chart_rects(page, table_rects)
        targets = [expand_with_labels(page, rc) for rc in charts]
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
            if min(pix.samples) >= 250:
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
