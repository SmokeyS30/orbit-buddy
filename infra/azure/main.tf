# Orbit Buddy on Azure Container Apps
# One `terraform apply` deploys everything. Run `terraform destroy` to tear it down.

terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
}

locals {
  app_name              = "orbit-buddy"
  azure_public_base_url = "https://orbitbuddy.app"
}

# --- Resource group: everything lives here, one bill, one place ---
resource "azurerm_resource_group" "orbit" {
  name     = var.resource_group_name
  location = var.location
}

# --- Storage: Azure Files share for SQLite backups ---
# SQLite runs on local container storage for reliable file locking. Consistent
# online backups are written here and restored whenever a new replica starts.
resource "azurerm_storage_account" "orbit" {
  name                     = var.storage_account_name
  resource_group_name      = azurerm_resource_group.orbit.name
  location                 = azurerm_resource_group.orbit.location
  account_tier             = "Standard"
  account_replication_type = "LRS"
}

resource "azurerm_storage_share" "orbit_data" {
  name                 = "orbit-data"
  storage_account_name = azurerm_storage_account.orbit.name
  quota                = 5 # GB
}

# --- Container Apps Environment: the shared networking/scaling layer ---
resource "azurerm_container_app_environment" "orbit" {
  name                       = "orbit-env"
  location                   = azurerm_resource_group.orbit.location
  resource_group_name        = azurerm_resource_group.orbit.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.orbit.id
}

resource "azurerm_log_analytics_workspace" "orbit" {
  name                = "orbit-logs"
  location            = azurerm_resource_group.orbit.location
  resource_group_name = azurerm_resource_group.orbit.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

# --- Azure OpenAI: Orbit's private model endpoint ---
# Model deployments are added only after Azure reports which model versions are
# available to this subscription and region. Keys stay in Container Apps secrets
# and are never written to Terraform state or source control.
resource "azurerm_cognitive_account" "orbit_openai" {
  name                          = var.azure_openai_account_name
  location                      = azurerm_resource_group.orbit.location
  resource_group_name           = azurerm_resource_group.orbit.name
  kind                          = "OpenAI"
  sku_name                      = "S0"
  custom_subdomain_name         = var.azure_openai_account_name
  local_auth_enabled            = true
  public_network_access_enabled = true

  tags = {
    application = "orbit-buddy"
    managed_by  = "terraform"
  }
}

resource "azurerm_cognitive_deployment" "orbit_openai_primary" {
  # Newest online model with nonzero quota in this subscription today.
  # Upgrade this to gpt-6.1-sol after Azure grants GlobalStandard quota.
  name                 = "gpt-5.4-mini"
  cognitive_account_id = azurerm_cognitive_account.orbit_openai.id
  rai_policy_name      = "Microsoft.DefaultV2"

  model {
    format  = "OpenAI"
    name    = "gpt-5.4-mini"
    version = "2026-03-17"
  }

  scale {
    type     = "DataZoneStandard"
    capacity = 10
  }

  version_upgrade_option = "OnceNewDefaultVersionAvailable"
}

resource "azurerm_cognitive_deployment" "orbit_openai_fallback" {
  name                 = "gpt-5-mini"
  cognitive_account_id = azurerm_cognitive_account.orbit_openai.id
  rai_policy_name      = "Microsoft.DefaultV2"

  model {
    format  = "OpenAI"
    name    = "gpt-5-mini"
    version = "2025-08-07"
  }

  scale {
    type     = "GlobalStandard"
    capacity = 10
  }

  version_upgrade_option = "OnceNewDefaultVersionAvailable"
}

# Storage mount so the container can reach Azure Files
resource "azurerm_container_app_environment_storage" "orbit_data" {
  name                         = "orbit-data"
  container_app_environment_id = azurerm_container_app_environment.orbit.id
  account_name                 = azurerm_storage_account.orbit.name
  share_name                   = azurerm_storage_share.orbit_data.name
  access_key                   = azurerm_storage_account.orbit.primary_access_key
  access_mode                  = "ReadWrite"
}

# --- The app itself ---
resource "azurerm_container_app" "orbit" {
  name                         = local.app_name
  container_app_environment_id = azurerm_container_app_environment.orbit.id
  resource_group_name          = azurerm_resource_group.orbit.name
  revision_mode                = "Single" # one active version at a time
  workload_profile_name        = "Consumption"

  # A local SQLite primary requires exactly one always-on replica. The Azure
  # Files backup survives revision replacements and container restarts.
  template {
    min_replicas = 1
    max_replicas = 1

    container {
      name   = "orbit-buddy"
      image  = var.container_image
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "PORT"
        value = "3000"
      }
      env {
        name  = "DATA_DIR"
        value = "/var/data/orbit"
      }
      env {
        name  = "PUBLIC_BASE_URL"
        value = local.azure_public_base_url
      }
      env {
        name        = "OPENAI_API_KEY"
        secret_name = "openai-api-key"
      }
      env {
        name  = "OPENAI_MODEL"
        value = "gpt-6-astra"
      }
      env {
        name  = "OPENAI_FALLBACK_MODELS"
        value = "gpt-6.1-sol,gpt-6-luna"
      }
      env {
        name        = "BRAVE_SEARCH_API_KEY"
        secret_name = "brave-search-api-key"
      }
      env {
        name        = "DATA_ENCRYPTION_KEY"
        secret_name = "data-encryption-key"
      }
      env {
        name        = "BACKUP_ENCRYPTION_KEY"
        secret_name = "backup-encryption-key"
      }
      env {
        name        = "GMAIL_CLIENT_ID"
        secret_name = "gmail-client-id"
      }
      env {
        name        = "GMAIL_CLIENT_SECRET"
        secret_name = "gmail-client-secret"
      }

      volume_mounts {
        name = "orbit-data"
        path = "/backup"
      }

      liveness_probe {
        path      = "/healthz"
        port      = 3000
        transport = "HTTP"
      }
    }

    volume {
      name         = "orbit-data"
      storage_name = azurerm_container_app_environment_storage.orbit_data.name
      storage_type = "AzureFile"
    }

    # Scale up on concurrent HTTP requests
    http_scale_rule {
      name                = "http-load"
      concurrent_requests = 10
    }
  }

  ingress {
    external_enabled = true
    target_port      = 3000
    transport        = "http"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  # Secrets are entered with Azure CLI or the portal and must never be stored in
  # Terraform state or source control. The managed certificate is intentionally
  # bound out of band so Azure can validate and renew it without putting
  # certificate material in this repository.
  lifecycle {
    ignore_changes = [secret, ingress[0].custom_domain]
  }
}
