# CodeBandage branding

The product display name is **CodeBandage**, with the optional tagline **AI Website Security & Repair**.
The user-supplied bandage/code-brackets artwork is the only logo source. The optimized source retains the original colors, bandage, AI lettering and wordmark, on a dark backplate for contrast. It is not a new generated design.

`apps/web/public/brand/codebandage-source.webp` is the checked 512-pixel optimized source.
Run `node scripts/generate-brand-assets.mjs` to regenerate the cropped web logo/wordmark, marks, PWA icons, favicon, Apple touch icon, trusted email attachment, and 1200x630 social card. The generator rejects an unexpected source SHA-256.

## Coverage

Shared header/footer branding covers customer, specialist, agency, affiliate, Owner, account and chat surfaces. Auth screens show the complete supplied logo. Home/Owner decorative lettermarks use the new symbol. Current copy, metadata, structured data, manifest, notification subjects, gateway identity and new MFA enrollment labels use CodeBandage. New report documents have optional signed publisher metadata; existing signed reports are not rewritten. SMTP sends an embedded logo, escaped HTML and the original text fallback; configured sender addresses stay unchanged.

## Preserved technical and historical references

The repository `nithudev-com/zerochack`, `@zerochack/*` packages, import aliases, existing environment variable names, database/volume names, cookie/session/local-storage keys, metrics and Redis namespaces, protocol user agents, SFTP lock filenames, and `@zerochack.delivery` message IDs remain unchanged for compatibility. No repository/domain migration or production deployment is performed by this rebrand.

Already-applied migration files, signed customer reports, queued/delivered messages, screenshots of earlier releases, audit records and custom customer/tenant names are historical data and must not be globally rewritten. The additive branding migration disables exact unmodified enabled system email defaults and adds a new version; customized templates and historical template versions are retained. Existing authenticator entries can keep their old display label without resetting secrets; new enrollments show CodeBandage.

Manually authored Owner email templates and configured verified sender domains require explicit review, not bulk editing. Public new pages and generated outputs must not present the former product name as the current brand. This task does not certify the unfinished platform capabilities or override dependency-audit release gates.
