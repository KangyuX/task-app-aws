# ---------------------------------------------------------------------------
# CI/CD: GitHub Actions deploys frontend/ to the site bucket on every push to
# main. It signs in to AWS with OIDC (short-lived credentials, no stored keys)
# and can only touch the site bucket and this distribution's invalidations.
# ---------------------------------------------------------------------------
variable "github_repo" {
  description = <<-EOT
    GitHub repository allowed to deploy the frontend and backend, exactly as it appears in
    the OIDC token's "sub" claim. GitHub includes immutable owner and repo IDs
    (owner@ownerId/repo@repoId), so a deleted-and-recreated repo with the same
    name can't use this role. To find the value for another repo, look up the
    failed AssumeRoleWithWebIdentity event in CloudTrail (userName field).
  EOT
  type        = string
  default     = "KangyuX@155896620/task-app-aws@1444903346"
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
    AWS_BACKEND_ROLE_ARN       = aws_iam_role.github_backend.arn
    EB_BUCKET                  = local.eb_bucket
    EB_APPLICATION             = aws_elastic_beanstalk_application.app.name
    EB_ENVIRONMENT             = aws_elastic_beanstalk_environment.api.name
    SITE_URL                   = "https://${aws_cloudfront_distribution.cdn.domain_name}"
  }
}

# ---------------------------------------------------------------------------
# Backend CI/CD: deploy-backend.yml uploads backend/ to the bucket Elastic
# Beanstalk created for this account and region, registers it as a new
# application version and switches the environment to it. Same trust policy
# (main branch of this repo only), separate role and permissions.
# ---------------------------------------------------------------------------
data "aws_caller_identity" "me" {}

locals {
  # Elastic Beanstalk's own storage bucket (one per account and region).
  eb_bucket     = "elasticbeanstalk-${var.region}-${data.aws_caller_identity.me.account_id}"
  eb_bucket_arn = "arn:aws:s3:::${local.eb_bucket}"
  eb_arn_prefix = "arn:aws:elasticbeanstalk:${var.region}:${data.aws_caller_identity.me.account_id}"
}

resource "aws_iam_role" "github_backend" {
  name                 = "${local.name}-github-backend"
  assume_role_policy   = data.aws_iam_policy_document.github_assume.json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "github_backend" {
  name = "deploy-backend"
  role = aws_iam_role.github_backend.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Bundles go under <app name>/ in Beanstalk's bucket. Beanstalk also
        # reads and writes its own files there during a deploy, using the
        # caller's credentials, so objects are allowed bucket-wide.
        Sid      = "BeanstalkBucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket", "s3:GetBucketLocation", "s3:GetBucketPolicy"]
        Resource = local.eb_bucket_arn
      },
      {
        Sid      = "BeanstalkBucketObjects"
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion", "s3:GetObjectAcl", "s3:PutObject", "s3:PutObjectAcl"]
        Resource = "${local.eb_bucket_arn}/*"
      },
      {
        # After a deploy Beanstalk deletes its working copies of the old and
        # new bundle here; without this the deploy is marked as aborted.
        Sid      = "BeanstalkRuntimeCleanup"
        Effect   = "Allow"
        Action   = "s3:DeleteObject"
        Resource = "${local.eb_bucket_arn}/resources/environments/${aws_elastic_beanstalk_environment.api.id}/*"
      },
      {
        Sid    = "CreateVersionAndDeploy"
        Effect = "Allow"
        Action = ["elasticbeanstalk:CreateApplicationVersion", "elasticbeanstalk:UpdateEnvironment"]
        Resource = [
          aws_elastic_beanstalk_application.app.arn,
          "${local.eb_arn_prefix}:applicationversion/${aws_elastic_beanstalk_application.app.name}/*",
          "${local.eb_arn_prefix}:environment/${aws_elastic_beanstalk_application.app.name}/${aws_elastic_beanstalk_environment.api.name}",
          # UpdateEnvironment also checks the platform the environment runs.
          "arn:aws:elasticbeanstalk:${var.region}::platform/*",
          "arn:aws:elasticbeanstalk:${var.region}::solutionstack/*",
        ]
      },
      {
        Sid      = "ReadBeanstalk"
        Effect   = "Allow"
        Action   = ["elasticbeanstalk:Describe*", "elasticbeanstalk:List*", "elasticbeanstalk:Check*"]
        Resource = "*"
      },
      {
        # Beanstalk applies a deploy through the environment's CloudFormation stack.
        Sid      = "EnvironmentStack"
        Effect   = "Allow"
        Action   = ["cloudformation:Describe*", "cloudformation:GetTemplate", "cloudformation:List*", "cloudformation:UpdateStack", "cloudformation:CancelUpdateStack"]
        Resource = "arn:aws:cloudformation:${var.region}:${data.aws_caller_identity.me.account_id}:stack/awseb-${aws_elastic_beanstalk_environment.api.id}-stack/*"
      },
      {
        # Pauses instance replacement while new code installs; only this
        # environment's Auto Scaling group (matched by Beanstalk's tag).
        Sid      = "PauseScaling"
        Effect   = "Allow"
        Action   = ["autoscaling:SuspendProcesses", "autoscaling:ResumeProcesses"]
        Resource = "*"
        Condition = {
          StringEquals = { "aws:ResourceTag/elasticbeanstalk:environment-name" = aws_elastic_beanstalk_environment.api.name }
        }
      },
      {
        Sid      = "ReadInfra"
        Effect   = "Allow"
        Action   = ["autoscaling:Describe*", "ec2:Describe*", "cloudwatch:Describe*", "cloudwatch:GetMetricStatistics", "logs:DescribeLogGroups"]
        Resource = "*"
      },
    ]
  })
}
