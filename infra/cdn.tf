# ---------------------------------------------------------------------------
# CloudFront: HTTPS front door. Static site from S3; /api/* to Elastic Beanstalk.
# ---------------------------------------------------------------------------
resource "aws_cloudfront_origin_access_control" "site" {
  name                              = "${local.name}-site"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

locals {
  caching_optimized_policy = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  caching_disabled_policy  = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
  all_viewer_no_host       = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  security_headers_policy  = "67f7725c-6f97-4210-82d7-5512b31e9d03"
}

resource "aws_cloudfront_distribution" "cdn" {
  enabled             = true
  comment             = local.name
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  http_version        = "http2and3"

  origin {
    origin_id                = "site"
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  origin {
    origin_id   = "api"
    domain_name = aws_elastic_beanstalk_environment.api.cname
    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
    custom_header {
      name  = "X-Origin-Secret"
      value = random_password.origin_secret.result
    }
  }

  default_cache_behavior {
    target_origin_id           = "site"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.caching_optimized_policy
    response_headers_policy_id = local.security_headers_policy
  }

  ordered_cache_behavior {
    path_pattern             = "/api/*"
    target_origin_id         = "api"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    compress                 = true
    cache_policy_id          = local.caching_disabled_policy
    origin_request_policy_id = local.all_viewer_no_host
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# Cache invalidation after a frontend change is done by the GitHub Actions workflow.
removed {
  from = terraform_data.invalidate
  lifecycle {
    destroy = false
  }
}

output "site_url" {
  value = "https://${aws_cloudfront_distribution.cdn.domain_name}"
}

output "eb_environment" {
  value = aws_elastic_beanstalk_environment.api.name
}

output "files_bucket" {
  value = aws_s3_bucket.files.id
}

output "db_endpoint" {
  value = aws_db_instance.db.address
}
