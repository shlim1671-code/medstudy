import fitz  # PyMuPDF
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

            full_text = ""
            try:
                for page_num in range(page_count):
                    page = doc[page_num]
                    full_text += page.get_text("text") + "\n\n"
            finally:
                doc.close()

            self._json_response(200, {
                "pageImages": [],
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
