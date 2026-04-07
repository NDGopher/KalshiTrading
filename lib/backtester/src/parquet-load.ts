import { compressors } from "hyparquet-compressors";
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
import type { AsyncBuffer } from "hyparquet";

function bufferToAsyncBuffer(buf: Buffer): AsyncBuffer {
  return {
    byteLength: buf.byteLength,
    slice(start: number, end?: number): ArrayBuffer {
      const sub = buf.subarray(start, end);
      const u = new Uint8Array(sub.length);
      u.set(sub);
      return u.buffer;
    },
  };
}

export type ParquetRow = Record<string, unknown>;

export async function readParquetFile(filePath: string, opts?: { rowStart?: number; rowEnd?: number }): Promise<ParquetRow[]> {
  const file = await asyncBufferFromFile(filePath);
  return parquetReadObjects({
    file,
    compressors,
    rowStart: opts?.rowStart,
    rowEnd: opts?.rowEnd,
  });
}

/** Read from an in-memory parquet (tests / custom pipelines). */
export async function readParquetBuffer(buf: Buffer, opts?: { rowStart?: number; rowEnd?: number }): Promise<ParquetRow[]> {
  return parquetReadObjects({
    file: bufferToAsyncBuffer(buf),
    compressors,
    rowStart: opts?.rowStart,
    rowEnd: opts?.rowEnd,
  });
}
