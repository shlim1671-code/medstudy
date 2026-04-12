import fitz  # PyMuPDF
import base64
import json
import os
from http.server import BaseHTTPRequestHandler
import cgi
import io
import urllib.request
import urllib.error

SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
BUCKET = "medstudy-images"


def upload_to_supabase(file_bytes, path):
    """Upload bytes to Supabase Storage and return public URL."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        return None
    url = f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{path}"
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "image/png",
        "x-upsert": "true",
    }
    try:
        req = urllib.request.Request(url, data=file_bytes, headers=headers, method="POST")
        with urllib.request.urlopen(req) as resp:
            if resp.status in (200, 201):
                return f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{path}"
    except Exception:
        pass
    return None


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                self._json_response(400, {"error": "multipart/form-data required"})
                return

            # Parse multipart form
            environ = {
                "REQUEST_METHOD": "POST",
                "CONTENT_TYPE": content_type,
                "CONTENT_LENGTH": self.headers.get("Content-Length", "0"),
            }
            form = cgi.FieldStorage(
                fp=self.rfile, headers=self.headers, environ=environ
            )

            pdf_field = form["file"]
            pdf_bytes = pdf_field.file.read()
            subject = form.getfirst("subject", "general")
            exam_unit = form.getfirst("exam_unit", "unknown")
            source_type = form.getfirst("source_type", "past_exam")
            source_detail = form.getfirst("source_detail", "")

            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            page_count = len(doc)

            # --- Phase A: Render each page as a PNG image (base64) ---
            page_images = []  # list of { "page": 1, "base64": "...", "width": w, "height": h }
            DPI = 200  # Balance between quality and size; 200 DPI ≈ 300-500KB per page
            for page_num in range(page_count):
                page = doc[page_num]
                mat = fitz.Matrix(DPI / 72, DPI / 72)
                pix = page.get_pixmap(matrix=mat)
                img_bytes = pix.tobytes("png")
                b64 = base64.b64encode(img_bytes).decode("utf-8")
                page_images.append({
                    "page": page_num + 1,
                    "base64": b64,
                    "width": pix.width,
                    "height": pix.height,
                })

            # --- Phase B: Extract embedded images and upload to Supabase ---
            image_mapping = {}
            image_count = 0
            storage_prefix = f"{subject}/{exam_unit}/{source_type}"
            if source_detail:
                storage_prefix += f"/{source_detail}"
            storage_prefix += "/images"

            for page_num in range(page_count):
                page = doc[page_num]
                img_list = page.get_images(full=True)
                for img_idx, img_info in enumerate(img_list):
                    xref = img_info[0]
                    try:
                        base_image = doc.extract_image(xref)
                        if not base_image:
                            continue
                        img_bytes_raw = base_image["image"]
                        ext = base_image.get("ext", "png")

                        # Convert to PNG if not already
                        if ext != "png":
                            pix_img = fitz.Pixmap(img_bytes_raw)
                            if pix_img.alpha:
                                pix_img = fitz.Pixmap(fitz.csRGB, pix_img)
                            img_bytes_raw = pix_img.tobytes("png")

                        image_ref = f"p{str(page_num + 1).zfill(3)}_i{str(img_idx + 1).zfill(2)}"
                        storage_path = f"{storage_prefix}/{image_ref}.png"
                        public_url = upload_to_supabase(img_bytes_raw, storage_path)

                        image_mapping[image_ref] = {
                            "url": public_url,
                            "page": page_num + 1,
                            "index": img_idx + 1,
                        }
                        image_count += 1
                    except Exception:
                        continue

            doc.close()

            # --- Phase C: Also extract raw text as fallback ---
            doc2 = fitz.open(stream=pdf_bytes, filetype="pdf")
            full_text = ""
            for page in doc2:
                full_text += page.get_text("text") + "\n\n"
            doc2.close()

            self._json_response(200, {
                "pageImages": page_images,
                "text": full_text.strip(),
                "imageMapping": image_mapping,
                "imageCount": image_count,
                "pageCount": page_count,
            })

        except Exception as e:
            self._json_response(500, {"error": str(e)})

    def _json_response(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))
