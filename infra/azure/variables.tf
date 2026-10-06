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
  default     = "ghcr.io/smokeys30/orbit-buddy@sha256:6c9b49ccb1f18acae1e724251f163124367934359c5e8f7606608a2084cb120b"
}
