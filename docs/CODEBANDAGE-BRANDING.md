# CodeBandage branding

The product display name is **CodeBandage**, with the optional tagline **AI Website Security & Repair**.
The current source is the user-supplied blue/navy `CodeBandageLogoEmblem.png`.
The built-in image editor removed its white background and arranged the emblem
left / CodeBandage wordmark right. This is an edited derivative, not a pixel-identical
copy. The original and edited-input checksums are recorded in
`apps/web/public/brand/provenance.json`; original inputs are retained outside the
server checkout under `/opt/codebandage/branding-inputs`.

`apps/web/public/brand/codebandage-source.webp` is the lossless, alpha-preserving
2172×724 source. Run `node scripts/generate-brand-assets.mjs` to regenerate
transparent horizontal PNG/WebP, wordmark, marks, favicons, PWA/Apple icons, email
attachment and the 1200×630 social card. The generator validates its checksum and
dimensions and records fixed crop coordinates. Logo files and shared components
have no black/white backplate. Only the social card has a light canvas. On dark
auth/footer surfaces, CSS makes the wordmark white while keeping emblem colors.
The full/auth variant is horizontal too; icon-only contexts use just the emblem.
The social-card generator uses the checksum-pinned, SIL-OFL-licensed Liberation
Sans font bundled under `scripts/brand-fonts`, not unverified host font fallback.

## Coverage

Shared header/footer branding covers customer, specialist, agency, affiliate, Owner, account and chat surfaces. Auth screens show the complete horizontal edited logo. Home/Owner decorative lettermarks use the new symbol. Current copy, metadata, structured data, manifest, notification subjects, gateway identity and new MFA enrollment labels use CodeBandage. New report documents have optional signed publisher metadata; existing signed reports are not rewritten. SMTP sends an embedded logo, escaped HTML and the original text fallback; configured sender addresses stay unchanged.

## Preserved technical and historical references

The repository `nithudev-com/zerochack`, `@zerochack/*` packages, import aliases, existing environment variable names, database/volume names, cookie/session/local-storage keys, metrics and Redis namespaces, protocol user agents, SFTP lock filenames, and `@zerochack.delivery` message IDs remain unchanged for compatibility. No repository/domain migration or production deployment is performed by this rebrand.

Already-applied migration files, signed customer reports, queued/delivered messages, screenshots of earlier releases, audit records and custom customer/tenant names are historical data and must not be globally rewritten. The additive branding migration disables exact unmodified enabled system email defaults and adds a new version; customized templates and historical template versions are retained. Existing authenticator entries can keep their old display label without resetting secrets; new enrollments show CodeBandage.

Manually authored Owner email templates and configured verified sender domains require explicit review, not bulk editing. Public new pages and generated outputs must not present the former product name as the current brand. This task does not certify the unfinished platform capabilities or override dependency-audit release gates.
