import fs from "node:fs/promises";

/** Tee-Object on Windows often writes UTF-16 LE with BOM. */
export async function readTextFileAutoEncoding(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString("utf16le");
  }
  const asUtf8 = buf.toString("utf8");
  if (asUtf8.includes("Partial rankings") || asUtf8.includes("PnL $")) {
    return asUtf8;
  }
  const asUtf16 = buf.toString("utf16le");
  if (asUtf16.includes("Partial rankings")) {
    return asUtf16;
  }
  return asUtf8;
}
