const IMAGE_SIGNATURES: ReadonlyArray<{
  mime: string;
  bytes: readonly number[];
}> = [
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
];

/** Magic-byte check. Client Content-Type is not trusted. */
export function imageMime(buffer: Buffer): string | null {
  const match = IMAGE_SIGNATURES.find((sig) =>
    sig.bytes.every((byte, i) => buffer[i] === byte),
  );
  if (!match) return null;
  if (match.mime === 'image/webp') {
    const webp = buffer.subarray(8, 12).toString('ascii');
    if (webp !== 'WEBP') return null;
  }
  return match.mime;
}

function cloudFolder(): string {
  return (process.env.CLOUDINARY_FOLDER?.trim() || 'OMS_VCB').replace(
    /^\/+|\/+$/g,
    '',
  );
}

/**
 * Lấy public id từ URL Cloudinary.
 */
export function cloudinaryPublicId(url: string): string | null {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const folder = cloudFolder();
  if (!cloud || !folder) return null;

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.hostname !== 'res.cloudinary.com') return null;

  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 4 || parts[0] !== cloud || parts[2] !== 'upload') {
    return null;
  }

  const folderParts = folder.split('/');
  const rest = parts.slice(3);
  const start = rest.findIndex((_, i) =>
    folderParts.every((seg, j) => rest[i + j] === seg),
  );
  if (start < 0) return null;

  const idParts = rest.slice(start);
  const last = idParts[idParts.length - 1] ?? '';
  const dot = last.lastIndexOf('.');
  if (dot > 0) idParts[idParts.length - 1] = last.slice(0, dot);

  const publicId = idParts.join('/');
  if (publicId !== folder && !publicId.startsWith(`${folder}/`)) return null;
  return publicId;
}
