# ---------------------------------------------------------------------------
# CI/CD: GitHub Actions deploys frontend/ to the site bucket on every push to
# main. It signs in to AWS with OIDC (short-lived credentials, no stored keys)
# and can only touch the site bucket and this distribution's invalidations.
# ---------------------------------------------------------------------------
variable "github_repo" {
  description = "GitHub repository (owner/name) allowed to deploy the frontend."
  type        = string
  default     = "KangyuX/task-app-aws"
}

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
}

data "aws_iam_policy_document" "github_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # Only workflows running on the main branch of this one repository.
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_repo}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github_frontend" {
  name                 = "${local.name}-github-frontend"
  assume_role_policy   = data.aws_iam_policy_document.github_assume.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "github_frontend" {
  name = "deploy-frontend"
  role = aws_iam_role.github_frontend.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ListSite"
        Effect   = "Allow"
        Action   = "s3:ListBucket"
        Resource = aws_s3_bucket.site.arn
      },
      {
        Sid      = "WriteSite"
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.site.arn}/*"
      },
      {
        Sid      = "Invalidate"
        Effect   = "Allow"
        Action   = ["cloudfront:CreateInvalidation", "cloudfront:GetInvalidation", "cloudfront:GetDistribution"]
        Resource = aws_cloudfront_distribution.cdn.arn
      },
    ]
  })
}

# Values to paste into GitHub: Settings → Secrets and variables → Actions → Variables.
output "github_actions_variables" {
  value = {
    AWS_ROLE_ARN               = aws_iam_role.github_frontend.arn
    SITE_BUCKET                = aws_s3_bucket.site.id
    CLOUDFRONT_DISTRIBUTION_ID = aws_cloudfront_distribution.cdn.id
  }
}
