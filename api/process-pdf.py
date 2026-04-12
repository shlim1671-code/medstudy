import cgi
import json
import os
import sys
import time
import traceback
import uuid
from io import BytesIO
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from http.server import BaseHTTPRequestHandler

import fitz  # pymupdf

MAX_PDF_BYTES = 50 * 1024 * 1024


def json_response(handler, status, payload):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def parse_multipart(handler):
    ctype = handler.headers.get("content-type", "")
    length = int(handler.headers.get("content-length", "0") or 0)
    raw = handler.rfile.read(length)
    env = {
        "REQUEST_METHOD": "POST",
        "CONTENT_TYPE": ctype,
        "CONTENT_LENGTH": str(len(raw)),
    }
    form = cgi.FieldStorage(
        fp=BytesIO(raw),
        headers=handler.headers,
        environ=env,
        keep_blank_values=True,
    )
    return form


def upload_png(supabase_url, service_key, bucket, path, png_bytes):
    base = supabase_url.rstrip("/")
    object_path = quote(path, safe="/")
    upload_url = f"{base}/storage/v1/object/{bucket}/{object_path}"

    req = Request(upload_url, data=png_bytes, method="PUT")
    req.add_header("Authorization", f"Bearer {service_key}")
    req.add_header("apikey", service_key)
    req.add_header("Content-Type", "image/png")
    req.add_header("x-upsert", "true")

    try:
        with urlopen(req):
            pass
    except HTTPError as e:
        detail = e.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Supabase upload failed ({e.code}): {detail}")

    public_url = f"{base}/storage/v1/object/public/{bucket}/{object_path}"
    return public_url


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/api/process-pdf":
            return json_response(self, 404, {"error": "Not found"})

        try:
            supabase_url = os.getenv("SUPABASE_URL", "")
            service_key = os.getenv("SUPABASE_SERVICE_KEY", "")
            if not supabase_url or not service_key:
                return json_response(self, 500, {"error": "SUPABASE_URL / SUPABASE_SERVICE_KEY is required"})

            form = parse_multipart(self)
            file_item = form["file"] if "file" in form else None
            if file_item is None or not getattr(file_item, "file", None):
                return json_response(self, 400, {"error": "file is required"})

            pdf_bytes = file_item.file.read()
            if len(pdf_bytes) > MAX_PDF_BYTES:
                return json_response(self, 400, {"error": "PDF 파일 크기는 50MB를 초과할 수 없습니다."})

            # Read optional metadata fields (kept for contract compatibility)
            _subject = form.getfirst("subject", "general")
            _exam_unit = form.getfirst("exam_unit", "unknown_exam")
            _source_type = form.getfirst("source_type", "manual")
            _source_detail = form.getfirst("source_detail", "")

            ingestion_batch_id = f"pdf_{int(time.time())}_{uuid.uuid4().hex[:8]}"

            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            image_mapping = {}
            image_count = 0
            page_texts = []

            for p_idx, page in enumerate(doc, start=1):
                page_images = page.get_images(full=True)
                ref_by_xref = {}

                for i_idx, img in enumerate(page_images, start=1):
                    xref = img[0]
                    ref = f"p{p_idx:03d}_i{i_idx:02d}"

                    # Required by spec: use doc.extract_image(xref)
                    extracted = doc.extract_image(xref)
                    if not extracted or "image" not in extracted:
                        continue

                    pix = fitz.Pixmap(doc, xref)
                    if pix.n > 4:
                        pix = fitz.Pixmap(fitz.csRGB, pix)
                    png_bytes = pix.tobytes("png")
                    pix = None

                    path = f"pdf/{ingestion_batch_id}/{ref}.png"
                    url = upload_png(supabase_url, service_key, "card-images", path, png_bytes)
                    image_mapping[ref] = {"url": url}
                    ref_by_xref[xref] = ref
                    image_count += 1

                # Build a list of (y_position, content) tuples for proper ordering
                elements = []

                # Add text blocks with their y-position
                blocks = page.get_text("dict").get("blocks", [])
                for block in blocks:
                    if block.get("type") == 0:  # text block
                        y_pos = block.get("bbox", [0, 0, 0, 0])[1]
                        for line in block.get("lines", []):
                            spans = line.get("spans", [])
                            text_line = "".join(span.get("text", "") for span in spans).strip()
                            if text_line:
                                line_y = line.get("bbox", [0, y_pos, 0, 0])[1]
                                elements.append((line_y, text_line))

                # Add image markers with their y-position from get_images + bbox
                used_refs = set()
                for img in page_images:
                    xref = img[0]
                    ref = ref_by_xref.get(xref)
                    if not ref:
                        continue
                    # Try to find image position via page.get_image_rects
                    try:
                        rects = page.get_image_rects(xref)
                        if rects and len(rects) > 0:
                            y_pos = rects[0].y0
                        else:
                            y_pos = float("inf")  # fallback: end of page
                    except Exception:
                        y_pos = float("inf")
                    elements.append((y_pos, f"[IMAGE {ref}]"))
                    used_refs.add(ref)

                # Fallback for any images not placed
                for ref in ref_by_xref.values():
                    if ref not in used_refs:
                        elements.append((float("inf"), f"[IMAGE {ref}]"))

                # Sort by y-position to maintain document order
                elements.sort(key=lambda x: x[0])
                parts = [content for _, content in elements]

                page_text = "\n".join(parts).strip()
                page_texts.append(f"[PAGE {p_idx}]\n{page_text}" if page_text else f"[PAGE {p_idx}]")

            full_text = "\n\n".join(page_texts).strip()
            return json_response(self, 200, {
                "text": full_text,
                "imageMapping": image_mapping,
                "imageCount": image_count,
            })
        except Exception as e:
            print(traceback.format_exc(), file=sys.stderr)
            return json_response(self, 500, {"error": str(e)})

    def do_GET(self):
        return json_response(self, 405, {"error": "Method not allowed"})
