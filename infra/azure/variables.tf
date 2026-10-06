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
  default     = "ghcr.io/smokeys30/orbit-buddy@sha256:5d6621c6700e92c3d154762759d550d37b834a1b2cc16c6d81f272248fc8ce77"
}
