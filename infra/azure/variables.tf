variable "resource_group_name" {
  description = "Name of the Azure resource group (everything lives here)"
  type        = string
  default     = "orbit-buddy-rg"
}

variable "location" {
  description = "Azure region"
  type        = string
  default     = "eastus"
}

variable "storage_account_name" {
  description = "Globally unique storage account name (lowercase, no dashes, 3-24 chars)"
  type        = string
  default     = "orbitbuddystorage"
}

variable "container_image" {
  description = "Docker image for Orbit. Build and push yours, then set this."
  type        = string
  default     = "ghcr.io/smokeys30/orbit-buddy@sha256:e3407c062ebd7c63de73f05af492569ccb570d7253c654d3d59cb3120bc9506f"
}
