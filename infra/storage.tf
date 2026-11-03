# ---------------------------------------------------------------------------
# S3: one bucket for the static site (served only through CloudFront) and one
# private bucket for files: task attachments and Elastic Beanstalk bundles.
# ---------------------------------------------------------------------------
resource "aws_s3_bucket" "site" {
  bucket        = "${local.name}-site"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "CloudFrontRead"
      Effect    = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.site.arn}/*"
      Condition = { StringEquals = { "AWS:SourceArn" = aws_cloudfront_distribution.cdn.arn } }
    }]
  })
}

# The frontend files themselves are deployed by GitHub Actions
# (.github/workflows/deploy-frontend.yml), not by Terraform. Terraform used to
# upload them; this block hands them over without deleting the live copies.
removed {
  from = aws_s3_object.site
  lifecycle {
    destroy = false
  }
}

resource "aws_s3_bucket" "files" {
  bucket        = "${local.name}-files"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "files" {
  bucket                  = aws_s3_bucket.files.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

# Browsers upload attachments straight to S3 with presigned POSTs.
resource "aws_s3_bucket_cors_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  cors_rule {
    allowed_methods = ["POST", "GET"]
    allowed_origins = ["https://${aws_cloudfront_distribution.cdn.domain_name}"]
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "files" {
  bucket = aws_s3_bucket.files.id
  rule {
    id     = "abandoned-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}
