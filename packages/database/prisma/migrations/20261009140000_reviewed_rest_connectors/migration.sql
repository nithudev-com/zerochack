-- Additive allowlist expansion; no encrypted rows, keys or website grants change.
BEGIN;
ALTER TABLE website_connectors DROP CONSTRAINT website_connectors_provider_check;
ALTER TABLE website_connectors ADD CONSTRAINT website_connectors_provider_check
  CHECK (provider IN ('wordpress', 'woocommerce', 'ghost', 'directus', 'shopify', 'joomla',
    'payload', 'strapi', 'prestashop', 'cscart', 'medusa', 'contentful', 'datocms', 'webflow'));
COMMIT;
