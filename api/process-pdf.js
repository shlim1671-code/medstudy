import pdf from "pdf-parse";
import formidable from "formidable";
import fs from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { PNG } from "pngjs";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

export const config = {
  api: { bodyParser: false },
};

const CHUNK_SIZE = 5;

function pad(num, width) {
  return String(num).padStart(width, "0");
}

function parseMultipart(req) {
  const form = formidable({ multiples: false, keepExtensions: true });
  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

function normalizeRgba(imageData) {
  if (!imageData?.data || !imageData?.width || !imageData?.height) return null;
  const { data, width, height } = imageData;
  if (data.length === width * height * 4) return { data, width, height };
  if (data.length === width * height * 3) {
    const out = new Uint8Array(width * height * 4);
    for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
      out[j] = data[i];
      out[j + 1] = data[i + 1];
      out[j + 2] = data[i + 2];
      out[j + 3] = 255;
    }
    return { data: out, width, height };
  }
  return null;
}

function extractPageText(textContent) {
  return (textContent.items || []).map(item => item.str || "").join("\n");
}

function getImageObject(page, objId) {
  return new Promise(resolve => {
    try {
      page.objs.get(objId, img => resolve(img || null));
    } catch {
      resolve(null);
    }
  });
}

async function uploadImage(supabase, bucket, path, pngBuffer) {
  const { error } = await supabase.storage.from(bucket).upload(path, pngBuffer, {
    contentType: "image/png",
    upsert: true,
  });
  if (error) throw error;
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}

async function processChunk(pdfDoc, fromPage, toPage, supabase, pathPrefix) {
  let textBuffer = "";
  const imageMapping = {};
  let imageCount = 0;

  for (let pageNum = fromPage; pageNum <= toPage; pageNum += 1) {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = extractPageText(textContent);
    textBuffer += `\n\n[PAGE ${pageNum}]\n${pageText}`;

    try {
      const operatorList = await page.getOperatorList();
      const imageOps = [];
      for (let i = 0; i < operatorList.fnArray.length; i += 1) {
        const fn = operatorList.fnArray[i];
        const args = operatorList.argsArray[i];
        if ((fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintJpegXObject) && args?.[0]) {
          imageOps.push(args[0]);
        }
      }

      for (let idx = 0; idx < imageOps.length; idx += 1) {
        const objId = imageOps[idx];
        const imageObj = await getImageObject(page, objId);
        const normalized = normalizeRgba(imageObj);
        if (!normalized) continue;

        const png = new PNG({ width: normalized.width, height: normalized.height });
        png.data = Buffer.from(normalized.data);
        const pngBuffer = PNG.sync.write(png);

        const ref = `p${pad(pageNum, 3)}_i${pad(idx + 1, 2)}`;
        const fileName = `${ref}.png`;
        const fullPath = `${pathPrefix}/images/${fileName}`;
        const url = await uploadImage(supabase, "medstudy-images", fullPath, pngBuffer);

        const textItems = textContent.items || [];
        const above = textItems.slice(Math.max(0, idx * 2), Math.max(0, idx * 2) + 1).map(x => x.str || "").join(" ").trim();
        const below = textItems.slice(Math.max(0, idx * 2) + 1, Math.max(0, idx * 2) + 2).map(x => x.str || "").join(" ").trim();

        imageMapping[ref] = { url, above_text: above, below_text: below };
        imageCount += 1;
      }
    } catch {
      // 이미지 추출 실패 페이지는 건너뜀
    }
  }

  return { textBuffer, imageMapping, imageCount };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_KEY;
    if (!supabaseUrl || !serviceKey) {
      return res.status(500).json({ error: "SUPABASE_URL / SUPABASE_SERVICE_KEY is required" });
    }

    const { fields, files } = await parseMultipart(req);
    const file = files.file?.[0] || files.file;
    if (!file) return res.status(400).json({ error: "file is required" });

    const subject = String(fields.subject || "general");
    const examUnit = String(fields.exam_unit || "unknown_exam");
    const sourceType = String(fields.source_type || "manual");
    const sourceDetail = String(fields.source_detail || "").trim();

    const fileBuffer = await fs.readFile(file.filepath);
    const parsed = await pdf(fileBuffer);

  const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(fileBuffer) }).promise;
    const totalPages = pdfDoc.numPages;

    const supabase = createClient(supabaseUrl, serviceKey);
    const pathPrefix = [subject, examUnit, sourceType, sourceDetail, ""].filter(Boolean).join("/");

    let finalText = "";
    const imageMapping = {};
    let imageCount = 0;

    for (let start = 1; start <= totalPages; start += CHUNK_SIZE) {
      const end = Math.min(totalPages, start + CHUNK_SIZE - 1);
      const chunk = await processChunk(pdfDoc, start, end, supabase, pathPrefix);
      finalText += chunk.textBuffer;
      Object.assign(imageMapping, chunk.imageMapping);
      imageCount += chunk.imageCount;
    }

    return res.status(200).json({
      text: (finalText || parsed.text || "").trim(),
      imageMapping,
      pageCount: totalPages,
      imageCount,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || "Unknown error" });
  }
}
