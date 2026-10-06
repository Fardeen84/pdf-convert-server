#!/usr/bin/env python3
"""PDF -> DOCX / XLSX / PPTX converters used by the NestJS server.

Usage:  convert.py <docx|xlsx|pptx> <input.pdf> <output> [--password PW]

Prints one JSON line on stdout: {"note": "...", ...}. Errors go to stderr with a
non-zero exit code (2 = bad/locked PDF, 1 = anything else).
"""
import json
import re
import sys

import pymupdf

NUM_RE = re.compile(r"^-?(0|[1-9]\d*)(\.\d+)?$")


def open_pdf(path, password):
    doc = pymupdf.open(path)
    if doc.needs_pass:
        if not password or not doc.authenticate(password):
            print("PDF is password protected (wrong or missing password)", file=sys.stderr)
            sys.exit(2)
    if doc.page_count == 0:
        print("PDF has no pages", file=sys.stderr)
        sys.exit(2)
    return doc


def to_docx(src, dst, password):
    from pdf2docx import Converter

    # Scanned PDFs have no text layer: pdf2docx would produce a mostly empty file.
    doc = open_pdf(src, password)
    chars = sum(len(p.get_text().strip()) for p in doc)
    doc.close()
    cv = Converter(src, password=password or None)
    try:
        cv.convert(dst)
    finally:
        cv.close()
    note = "scanned_no_text" if chars < 20 else "ok"
    return {"note": note}


def cell_value(text):
    t = (text or "").strip()
    if NUM_RE.match(t):
        return float(t) if "." in t else int(t)
    return text if text is not None else ""


def to_xlsx(src, dst, password):
    from openpyxl import Workbook

    doc = open_pdf(src, password)
    wb = Workbook()
    wb.remove(wb.active)
    tables = 0
    for pno, page in enumerate(doc, start=1):
        try:
            found = page.find_tables()
        except Exception:
            found = None
        if not found:
            continue
        for ti, tab in enumerate(found.tables, start=1):
            rows = tab.extract()
            if not rows:
                continue
            tables += 1
            ws = wb.create_sheet(f"P{pno}-T{ti}"[:31])
            for r in rows:
                ws.append([cell_value(c) for c in r])
            for col in ws.columns:
                width = max((len(str(c.value)) for c in col if c.value is not None), default=8)
                ws.column_dimensions[col[0].column_letter].width = min(max(width + 2, 8), 60)
    note = "ok"
    if tables == 0:
        # No ruled tables anywhere: fall back to one sheet per page, one row per text line.
        note = "no_tables_text_fallback"
        for pno, page in enumerate(doc, start=1):
            ws = wb.create_sheet(f"Page {pno}"[:31])
            for line in page.get_text().splitlines():
                if line.strip():
                    ws.append([line])
            ws.column_dimensions["A"].width = 100
        if not wb.sheetnames:
            wb.create_sheet("Sheet1")
    wb.save(dst)
    return {"note": note, "tables": tables}


def to_pptx(src, dst, password, dpi=150):
    from pptx import Presentation
    from pptx.util import Emu

    doc = open_pdf(src, password)
    prs = Presentation()
    blank = prs.slide_layouts[6]
    first = doc[0].rect
    # 1 pt = 12700 EMU. Keep the first page's proportions for every slide.
    prs.slide_width = Emu(int(first.width * 12700))
    prs.slide_height = Emu(int(first.height * 12700))
    scale = dpi / 72.0
    import io

    for page in doc:
        pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
        slide = prs.slides.add_slide(blank)
        slide.shapes.add_picture(
            io.BytesIO(pix.tobytes("png")), 0, 0, prs.slide_width, prs.slide_height
        )
        text = page.get_text().strip()
        if text:
            slide.notes_slide.notes_text_frame.text = text
    prs.save(dst)
    return {"note": "image_slides"}


def main():
    args = sys.argv[1:]
    password = None
    if "--password" in args:
        i = args.index("--password")
        password = args[i + 1] if i + 1 < len(args) else None
        del args[i : i + 2]
    if len(args) != 3 or args[0] not in ("docx", "xlsx", "pptx"):
        print("usage: convert.py <docx|xlsx|pptx> <in.pdf> <out> [--password PW]", file=sys.stderr)
        sys.exit(1)
    target, src, dst = args
    fn = {"docx": to_docx, "xlsx": to_xlsx, "pptx": to_pptx}[target]
    try:
        result = fn(src, dst, password)
    except SystemExit:
        raise
    except Exception as e:  # corrupt PDF etc.
        print(f"{type(e).__name__}: {e}", file=sys.stderr)
        sys.exit(1)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
