# Customer workspace

The authenticated Customer shell uses a compact blue/navy layout that matches the existing CodeBandage artwork. Authentication, public signup, API permissions, and other role dashboards are unchanged.

## Navigation and accessibility

- Desktop: labelled sidebar with all seven Customer destinations, workspace switching, session management, and sign-out.
- Below 1024px: Overview, Websites, Help, and More in a bottom navigation bar. Space is reserved for the bar and device safe area; the Care composer sits above it.
- More opens a native modal dialog. Escape/Close returns focus, Tab wraps within its controls, route changes dismiss it, and resizing to desktop closes it.
- Controls have at least 44px mobile targets. The shell includes a skip link, visible focus, active-page labels, readable contrast, and reduced-motion support.
- Sign-out errors remain actionable; the client query cache is cleared only after successful logout.

## Data meaning

The overview still uses the existing tenant-authorized `/customer/overview` endpoint. It does not add requests to paid providers or create sample production data.

- **Verified websites** is the existing `protectedWebsites` count of ownership-verified connections, not a claim that websites are vulnerability-free.
- Monitoring and backups show the returned active/total counts, not percentages or backup-restoration guarantees.
- Unknown posture is **Not assessed**, and an empty workspace is **Setup needed**. Critical findings take priority over a returned healthy posture.
- Scan status and request date, subscription, tickets, and notification counts come from the API. Empty and error states do not imply monitoring is active.

## Checks

Development, with isolated API fixtures:

```sh
npx playwright test --config playwright.care.config.ts customer-workspace.spec.ts branding.spec.ts signup.spec.ts smtp.spec.ts
```

For production-image testing, start the exact candidate web image on loopback port 3510 with production URL build arguments, then use `playwright.image.config.ts`. Also run the Care chat/navigation tests after shell changes. These browser fixtures verify presentation and interaction, not actual account authentication, provider results, payments, or email delivery.

The dedicated Customer suite covers 320/390/768/1440px layouts, overflow, actual data mapping, empty/unknown/attention states, refresh/retry, authenticated-route redirects, logout recovery, menu keyboard behavior, form access, reduced motion, and automated WCAG checks. Screenshot output contains synthetic test data only.

No database migrations, secrets, provider activation, or public-release gate changes are required for this UI update. Keep the existing restricted-preview boundary until independent production release blockers are resolved.
