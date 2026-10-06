output "app_url" {
  description = "Public URL of the deployed Orbit app"
  value       = "https://${azurerm_container_app.orbit.latest_revision_fqdn}"
}

output "resource_group" {
  description = "Resource group name (for az CLI commands)"
  value       = azurerm_resource_group.orbit.name
}
