output "app_url" {
  description = "Public URL of the deployed Orbit app"
  value       = local.azure_public_base_url
}

output "resource_group" {
  description = "Resource group name (for az CLI commands)"
  value       = azurerm_resource_group.orbit.name
}
