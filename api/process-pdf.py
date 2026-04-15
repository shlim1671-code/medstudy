import fitz  # PyMuPDF
import base64
import json
import os
from http.server import BaseHTTPRequestHandler
import cgi


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

            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            page_count = len(doc)

            page_images = []
            full_text = ""
            DPI = 200
            try:
                for page_num in range(page_count):
                    page = doc[page_num]

                    # Phase A: render page as PNG (base64)
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

                    # Phase C: extract text
                    full_text += page.get_text("text") + "\n\n"
            finally:
                doc.close()

            self._json_response(200, {
                "pageImages": page_images,
                "text": full_text.strip(),
                "imageMapping": {},
                "imageCount": 0,
                "extractedImageCount": 0,
                "pageCount": page_count,
            })

        except Exception as e:
            self._json_response(500, {"error": str(e)})

    def _json_response(self, status, data):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode("utf-8"))
