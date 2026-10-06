output "app_url" {
  description = "Public URL of the deployed Orbit app"
  value       = local.azure_public_base_url
}

output "resource_group" {
  description = "Resource group name (for az CLI commands)"
  value       = azurerm_resource_group.orbit.name
}

output "azure_openai_account_name" {
  description = "Azure OpenAI resource name"
  value       = azurerm_cognitive_account.orbit_openai.name
}

output "azure_openai_endpoint" {
  description = "Azure OpenAI endpoint (not a credential)"
  value       = azurerm_cognitive_account.orbit_openai.endpoint
}

output "azure_openai_primary_deployment" {
  description = "Primary Azure OpenAI deployment"
  value       = azurerm_cognitive_deployment.orbit_openai_primary.name
}

output "azure_openai_fallback_deployment" {
  description = "Fallback Azure OpenAI deployment"
  value       = azurerm_cognitive_deployment.orbit_openai_fallback.name
}
