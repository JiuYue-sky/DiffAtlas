import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  BoundedConcurrencyQueue,
  DEFAULT_CHUNK_BYTES,
  MAX_APP_CONCURRENT_REQUESTS,
  MAX_CHUNK_BYTES,
} from './concurrency-queue.js';
import { PathGuard, PathGuardOptions } from './path-guard.js';
import { ChunkEncoding, ChunkSliceRequest, ChunkSliceResponse, PathGuardError } from './types.js';

export {
  BoundedConcurrencyQueue,
  DEFAULT_CHUNK_BYTES,
  MAX_APP_CONCURRENT_REQUESTS,
  MAX_CHUNK_BYTES,
};

/**
 * Reads a bounded byte range of a workspace file validated by `PathGuard`.
 * Supports both UTF-8 text slices (`encoding: 'utf8'` for diffs/source) and
 * binary slices (`encoding: 'base64'` for large `.glb`/`.stl`/`.ply` binary assets in companion plugins).
 */
export function readSafeFileChunk(
  guard: PathGuard,
  req: ChunkSliceRequest,
  guardOptions: PathGuardOptions = {},
): ChunkSliceResponse {
  const resolved = guard.resolvePath(req.targetPath, guardOptions);
  if (!resolved.exists) {
    throw new PathGuardError('ERR_OUTSIDE_WORKSPACE', `File does not exist: ${resolved.relativePath}`, req.targetPath);
  }

  const stat = fs.statSync(resolved.absolutePath);
  if (!stat.isFile()) {
    throw new PathGuardError('ERR_OUTSIDE_WORKSPACE', `Target is not a regular file: ${resolved.relativePath}`, req.targetPath);
  }

  const totalBytes = stat.size;
  const byteOffset = Math.max(0, Math.min(totalBytes, Math.floor(req.byteOffset ?? 0)));
  const requestedLen = Math.max(1, Math.min(MAX_CHUNK_BYTES, Math.floor(req.byteLength ?? DEFAULT_CHUNK_BYTES)));
  const bytesToRead = Math.max(0, Math.min(requestedLen, totalBytes - byteOffset));
  const encoding: ChunkEncoding = req.encoding === 'base64' ? 'base64' : 'utf8';

  const buffer = Buffer.alloc(bytesToRead);
  let actualRead = 0;
  if (bytesToRead > 0) {
    const fd = fs.openSync(resolved.absolutePath, 'r');
    try {
      actualRead = fs.readSync(fd, buffer, 0, bytesToRead, byteOffset);
    } finally {
      fs.closeSync(fd);
    }
  }

  const slice = actualRead === bytesToRead ? buffer : buffer.subarray(0, actualRead);
  const sliceHash = crypto.createHash('sha256').update(slice).digest('hex');
  const data = encoding === 'base64' ? slice.toString('base64') : slice.toString('utf8');
  const eof = actualRead === 0 || byteOffset + actualRead >= totalBytes;

  return {
    targetPath: resolved.absolutePath,
    relativePath: resolved.relativePath,
    totalBytes,
    byteOffset,
    byteLength: actualRead,
    eof,
    encoding,
    data,
    sha256: sliceHash,
  };
}
