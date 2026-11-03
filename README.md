# Pitch In — task marketplace on AWS

Users sign up, post tasks (title, details, reward, due date, location, file attachments) and accept tasks other people have posted.

## Architecture

```
Browser ──HTTPS──▶ CloudFront ──/*──────▶ S3 site bucket (index.html, app.js, styles.css)
                        │
                        └──/api/*──▶ Elastic Beanstalk (Node.js 22, single instance)
                                          │            │
                                          ▼            ▼
                                   RDS PostgreSQL   S3 files bucket
                                   (users, tasks,   (task attachments,
                                    attachments)     app bundles)
```

| Service | Role |
|---|---|
| **S3** | `*-site` bucket holds the static frontend (private, read only by CloudFront via OAC). `*-files` bucket stores task attachments (uploaded straight from the browser with presigned POSTs, downloaded via 5-minute presigned GETs) and the Beanstalk app bundles. |
| **CloudFront** | One HTTPS URL for everything. Default behavior serves the site from S3; `/api/*` goes to Beanstalk uncached. Adds a secret `X-Origin-Secret` header the API requires, so the instance can't be used directly. |
| **RDS** | PostgreSQL 17 (`db.t4g.micro`), private, encrypted, TLS verified against the RDS CA. Only the Beanstalk security group can reach port 5432. |
| **Elastic Beanstalk** | Express API (`backend/`). Accounts (bcrypt + JWT), task lifecycle, attachment URLs. Schema is created on startup. |

Task lifecycle: `open` → (someone else accepts) → `accepted` → (poster marks complete) → `completed`. The accepter can drop an accepted task (back to `open`); the poster can cancel an open task. Accepting is a single conditional `UPDATE`, so two people can never accept the same task.

## Layout

- `infra/` — Terraform (`main.tf` network/SGs, `storage.tf` S3, `database.tf` RDS, `beanstalk.tf` EB + IAM, `cdn.tf` CloudFront + outputs)
- `backend/` — Node.js API deployed to Elastic Beanstalk (Terraform zips and uploads it)
- `frontend/` — static single-page app uploaded to S3 by Terraform

## Deploy / update

```bash
cd infra
terraform init
terraform apply
```

Changing anything in `backend/` and re-running `terraform apply` ships a new Elastic Beanstalk version. `terraform output site_url` prints the link.

## Frontend CI/CD (GitHub Actions)

`.github/workflows/deploy-frontend.yml` runs on every push to `main` that touches `frontend/` (or by hand from the Actions tab). It:

1. checks the repository variables are set and `app.js` parses,
2. signs in to AWS with OIDC: a short-lived token, no AWS keys stored in GitHub,
3. uploads `frontend/` to the site bucket with correct content types and deletes files that were removed,
4. clears the CloudFront cache and waits until the new version is live.

Terraform (`infra/github.tf`) creates the GitHub OIDC provider and an IAM role that only workflows on `main` of `KangyuX/task-app-aws` can assume (matched by GitHub's immutable owner and repo IDs, see `var.github_repo`). The role can write only the site bucket and invalidate only this distribution. Terraform no longer uploads the frontend files; the workflow owns them.

One-time setup after `terraform apply`: copy the three values from

```bash
terraform output github_actions_variables
```

into GitHub → **Settings → Secrets and variables → Actions → Variables** as `AWS_ROLE_ARN`, `SITE_BUCKET` and `CLOUDFRONT_DISTRIBUTION_ID`.

## Run the API locally

```bash
docker run -d --name pitchin-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=pitchin -p 55432:5432 postgres:17-alpine
cd backend && npm install
DB_PORT=55432 DB_SSL=false JWT_SECRET=dev node src/server.js
```

## Tear down

```bash
cd infra && terraform destroy
```

RDS is created with `skip_final_snapshot = true`, so destroying deletes the data.
