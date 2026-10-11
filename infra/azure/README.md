# Orbit Buddy on Azure (Terraform)

Deploys Orbit to Azure Container Apps as one always-on replica backed by Azure
PostgreSQL Flexible Server. Orbit writes daily encrypted per-user backups to
persistent Azure Files storage and retains the latest seven per user. Keep a
separate portable backup and periodically test restoration; the Azure Files
share is recovery storage, not an independent off-site backup.

The stack also keeps an Azure OpenAI account with primary and fallback model
deployments available for a future provider switch. Orbit currently uses the
standard OpenAI API key from Container Apps secrets, with Astra first and an
ordered model fallback configured in `main.tf`.

## One-time setup (on your Mac)

```bash
# Install Terraform and Azure CLI
brew install terraform azure-cli

# Log into Azure
az login
```

## Build and push the Docker image

```bash
cd /path/to/orbit-buddy
docker build -t ghcr.io/smokeys30/orbit-buddy:latest .
docker push ghcr.io/smokeys30/orbit-buddy:latest
```

(Or use any registry. For repeatable deployments, update `container_image` in
`variables.tf` to the pushed image digest rather than a mutable `latest` tag.)

## Deploy

```bash
cd ~/workspace/orbit-azure
terraform init
terraform apply
```

First apply takes ~5–10 minutes. The production app is available at
`https://orbitbuddy.app`; Azure's generated hostname remains available for
health checks and disaster recovery.

## Add your secrets (after first deploy)

```bash
RG="orbit-buddy-rg"
az containerapp secret set -g $RG -n orbit-buddy \
  --secrets \
    openai-api-key="YOUR_KEY" \
    brave-search-api-key="YOUR_KEY" \
    data-encryption-key="$(openssl rand -hex 32)" \
    backup-encryption-key="$(openssl rand -hex 32)" \
    gmail-client-id="YOUR_ID" \
    gmail-client-secret="YOUR_SECRET"
```

Terraform already wires these secret names to the container environment. Secret
values stay outside source control and Terraform state.

**Important:** production data is stored in the externally managed PostgreSQL
server referenced by the `database-url` Container App secret. Migrate and verify
that database before changing production traffic. Generate a new
`data-encryption-key` only when starting fresh; migrations must retain the
existing key so encrypted connector data remains readable.

The `orbitbuddy.app` managed-certificate binding is maintained by Azure CLI and
protected from removal by Terraform's lifecycle rule in `main.tf`. Keep the
Cloudflare apex A record DNS-only and pointed at the Container Apps environment
static IP so Azure can continue to validate and renew the managed certificate.

## Updating

```bash
docker build -t ghcr.io/smokeys30/orbit-buddy:latest .
docker push ghcr.io/smokeys30/orbit-buddy:latest
az containerapp update -g orbit-buddy-rg -n orbit-buddy \
  --image ghcr.io/smokeys30/orbit-buddy:latest
```

No Terraform needed for image updates.

## Tear down

```bash
terraform destroy
```

## Cost estimate

The exact price varies by Azure region and usage. This configuration keeps one
Consumption replica running so scheduled and proactive work continues after
clients disconnect. Check Azure Cost Management for the current measured cost.
