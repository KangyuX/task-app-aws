# ---------------------------------------------------------------------------
# Elastic Beanstalk: the Node.js API. Single-instance environment (no load
# balancer) reached only through CloudFront at /api/*.
# ---------------------------------------------------------------------------
resource "random_password" "jwt" {
  length  = 48
  special = false
}

# CloudFront adds this header to every /api request; the app rejects requests
# without it, so the instance can't be used directly over plain HTTP.
resource "random_password" "origin_secret" {
  length  = 40
  special = false
}

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "instance" {
  name               = "${local.name}-eb-instance"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "instance_web" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AWSElasticBeanstalkWebTier"
}

resource "aws_iam_role_policy" "instance_files" {
  name = "attachments"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
      Resource = "${aws_s3_bucket.files.arn}/attachments/*"
    }]
  })
}

resource "aws_iam_instance_profile" "instance" {
  name = "${local.name}-eb-instance"
  role = aws_iam_role.instance.name
}

data "aws_iam_policy_document" "eb_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["elasticbeanstalk.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = ["elasticbeanstalk"]
    }
  }
}

resource "aws_iam_role" "service" {
  name               = "${local.name}-eb-service"
  assume_role_policy = data.aws_iam_policy_document.eb_assume.json
}

resource "aws_iam_role_policy_attachment" "service_health" {
  role       = aws_iam_role.service.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSElasticBeanstalkEnhancedHealth"
}

resource "aws_iam_role_policy_attachment" "service_managed" {
  role       = aws_iam_role.service.name
  policy_arn = "arn:aws:iam::aws:policy/AWSElasticBeanstalkManagedUpdatesCustomerRolePolicy"
}

# The backend code is NOT deployed by Terraform. GitHub Actions
# (.github/workflows/deploy-backend.yml) zips backend/, uploads it to the
# bucket Elastic Beanstalk owns (elasticbeanstalk-<region>-<account>) and
# deploys it as a new application version. A brand-new environment runs the
# Beanstalk sample app until that workflow runs once.
resource "aws_elastic_beanstalk_application" "app" {
  name = local.name

  # Keep the 30 newest versions; older ones and their zips are deleted.
  appversion_lifecycle {
    service_role          = aws_iam_role.service.arn
    max_count             = 30
    delete_source_from_s3 = true
  }
}

data "aws_elastic_beanstalk_solution_stack" "node" {
  most_recent = true
  name_regex  = "^64bit Amazon Linux 2023 (.*) running Node.js 22$"
}

locals {
  eb_settings = [
    { ns = "aws:ec2:vpc", name = "VPCId", value = aws_vpc.main.id },
    { ns = "aws:ec2:vpc", name = "Subnets", value = join(",", aws_subnet.public[*].id) },
    { ns = "aws:ec2:vpc", name = "AssociatePublicIpAddress", value = "true" },
    { ns = "aws:elasticbeanstalk:environment", name = "EnvironmentType", value = "SingleInstance" },
    { ns = "aws:elasticbeanstalk:environment", name = "ServiceRole", value = aws_iam_role.service.arn },
    { ns = "aws:elasticbeanstalk:healthreporting:system", name = "SystemType", value = "enhanced" },
    { ns = "aws:autoscaling:launchconfiguration", name = "IamInstanceProfile", value = aws_iam_instance_profile.instance.name },
    { ns = "aws:autoscaling:launchconfiguration", name = "InstanceType", value = var.instance_type },
    { ns = "aws:autoscaling:launchconfiguration", name = "SecurityGroups", value = aws_security_group.app.id },
    { ns = "aws:autoscaling:launchconfiguration", name = "DisableIMDSv1", value = "true" },
    { ns = "aws:elasticbeanstalk:cloudwatch:logs", name = "StreamLogs", value = "true" },
    { ns = "aws:elasticbeanstalk:cloudwatch:logs", name = "RetentionInDays", value = "14" },
    { ns = "aws:elasticbeanstalk:application:environment", name = "NODE_ENV", value = "production" },
    { ns = "aws:elasticbeanstalk:application:environment", name = "AWS_REGION", value = var.region },
    { ns = "aws:elasticbeanstalk:application:environment", name = "DB_HOST", value = aws_db_instance.db.address },
    { ns = "aws:elasticbeanstalk:application:environment", name = "DB_PORT", value = tostring(aws_db_instance.db.port) },
    { ns = "aws:elasticbeanstalk:application:environment", name = "DB_NAME", value = aws_db_instance.db.db_name },
    { ns = "aws:elasticbeanstalk:application:environment", name = "DB_USER", value = aws_db_instance.db.username },
    { ns = "aws:elasticbeanstalk:application:environment", name = "DB_PASSWORD", value = random_password.db.result },
    { ns = "aws:elasticbeanstalk:application:environment", name = "JWT_SECRET", value = random_password.jwt.result },
    { ns = "aws:elasticbeanstalk:application:environment", name = "ORIGIN_SECRET", value = random_password.origin_secret.result },
    { ns = "aws:elasticbeanstalk:application:environment", name = "FILES_BUCKET", value = aws_s3_bucket.files.id },
  ]
}

resource "aws_elastic_beanstalk_environment" "api" {
  name                   = "${local.name}-api"
  application            = aws_elastic_beanstalk_application.app.name
  solution_stack_name    = data.aws_elastic_beanstalk_solution_stack.node.name
  wait_for_ready_timeout = "30m"

  # The deploy workflow owns which version is running; don't roll it back.
  lifecycle {
    ignore_changes = [version_label]
  }

  dynamic "setting" {
    for_each = local.eb_settings
    content {
      namespace = setting.value.ns
      name      = setting.value.name
      value     = setting.value.value
    }
  }

  depends_on = [
    aws_iam_role_policy_attachment.instance_web,
    aws_iam_role_policy_attachment.service_health,
    aws_route_table_association.public,
  ]
}
