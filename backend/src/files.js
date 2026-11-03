import { S3Client, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const s3 = new S3Client({ region: process.env.AWS_REGION || "us-east-1" });
const Bucket = process.env.FILES_BUCKET;

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function uploadForm(key, contentType) {
  return createPresignedPost(s3, {
    Bucket,
    Key: key,
    Conditions: [
      ["content-length-range", 1, MAX_UPLOAD_BYTES],
      ["eq", "$Content-Type", contentType],
    ],
    Fields: { "Content-Type": contentType },
    Expires: 300,
  });
}

export async function objectSize(key) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket, Key: key }));
    return head.ContentLength;
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404 || err.name === "NotFound") return null;
    throw err;
  }
}

export function downloadUrl(key, filename) {
  const safe = filename.replace(/["\\\r\n]/g, "_");
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${safe}"`,
    }),
    { expiresIn: 300 },
  );
}

export function deleteObject(key) {
  return s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
}
