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

# --- Resource group: everything lives here, one bill, one place ---
resource "azurerm_resource_group" "orbit" {
  name     = var.resource_group_name
  location = var.location
}

# --- Storage: Azure Files share for the SQLite database ---
# This is Orbit's persistent disk. Survives redeploys and scaling events.
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
  name                         = "orbit-buddy"
  container_app_environment_id = azurerm_container_app_environment.orbit.id
  resource_group_name          = azurerm_resource_group.orbit.name
  revision_mode                = "Single" # one active version at a time

  # --- Auto-scaling: 0 when idle, up to 3 under load ---
  template {
    min_replicas = 0
    max_replicas = 3

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
        value = var.public_base_url
      }
      # Secrets are set after first apply — see README.
      # OPENAI_API_KEY, BRAVE_SEARCH_API_KEY, DATA_ENCRYPTION_KEY,
      # GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET

      volume_mounts {
        name = "orbit-data"
        path = "/var/data"
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
}
