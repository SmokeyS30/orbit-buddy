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

variable "azure_openai_account_name" {
  description = "Globally unique Azure OpenAI account and endpoint name"
  type        = string
  default     = "orbit-buddy-openai"
}

variable "container_image" {
  description = "Docker image for Orbit. Build and push yours, then set this."
  type        = string
  default     = "ghcr.io/smokeys30/orbit-buddy@sha256:1b5838bcf60df7f75b42fe543bee937483e1d3feadf3debe425c44a416b2d653"
}
