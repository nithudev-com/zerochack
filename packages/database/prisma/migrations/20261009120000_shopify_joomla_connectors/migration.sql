-- Expand the adapter allowlist without changing or re-encrypting existing rows.
BEGIN;
ALTER TABLE website_connectors DROP CONSTRAINT website_connectors_provider_check;
ALTER TABLE website_connectors ADD CONSTRAINT website_connectors_provider_check
  CHECK (provider IN ('wordpress', 'woocommerce', 'ghost', 'directus', 'shopify', 'joomla'));
COMMIT;
