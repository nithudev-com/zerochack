import { implementedReviewTools } from './tool-ids';
// Role descriptions preserve the wider roadmap; implemented execution modes are explicit below.
const agentDefinitions = [
  {
    "id": "A01",
    "name": "Coordinator",
    "knowledge": "Task dependencies, scope, uncertainty, budgets, escalation.",
    "inputs": "Sanitized case, authorizations, capability map.",
    "output": "Task graph and assignments.",
    "boundary": "Plan/status tools only; no production or secrets.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A02",
    "name": "Customer Liaison",
    "knowledge": "Plain language, issue intake, Tamil/English communication, approval UX.",
    "inputs": "Customer messages, verified case state.",
    "output": "Questions, understandable summaries, approval explanations.",
    "boundary": "Cannot approve on behalf of a user.",
    "version": 1,
    "enabled": true,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A03",
    "name": "Environment Mapper",
    "knowledge": "Runtime/framework inventory, deployment structure, versions.",
    "inputs": "Approved manifests and source snapshot.",
    "output": "Versioned environment/capability map with unknowns.",
    "boundary": "No network expansion beyond bound resources.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A04",
    "name": "Incident Triage",
    "knowledge": "Evidence preservation, known-good comparisons, recovery planning.",
    "inputs": "Approved evidence and observed symptoms.",
    "output": "Human-assisted incident assessment and recovery proposal.",
    "boundary": "No destructive cleanup, exploitation, or malware execution.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A05",
    "name": "Application Security Reviewer",
    "knowledge": "Secure coding, authentication, authorization, validation, configuration.",
    "inputs": "Provided source/configuration and applicable rules.",
    "output": "Evidence-linked findings and bounded repair advice.",
    "boundary": "Source/configuration review; no live exploit reproduction.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A06",
    "name": "Dependency and Supply-Chain Reviewer",
    "knowledge": "Lockfiles, advisory relevance, compatibility, provenance.",
    "inputs": "Manifest, lockfile, inventory, approved advisory data.",
    "output": "Minimal update proposal with affected-component evidence.",
    "boundary": "Cannot install arbitrary packages or auto-approve updates.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A07",
    "name": "API and Backend Engineer",
    "knowledge": "API contracts, data validation, business logic, error behavior.",
    "inputs": "Approved issue, source, synthetic fixtures.",
    "output": "Scoped patch and functional regression evidence.",
    "boundary": "Isolated workspace only; no arbitrary live API mutation.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A08",
    "name": "Frontend Repair Engineer",
    "knowledge": "Static HTML, inline CSS, responsive layout.",
    "inputs": "Approved issue and validated standalone HTML.",
    "output": "Focused interface repair and preview.",
    "boundary": "Data-only candidate generation. No scripts, backend, tools, source execution, or production access.",
    "version": 1,
    "enabled": true,
    "maxAttempts": 1,
    "maxToolCalls": 0,
    "maxConcurrentPerWebsite": 1
  },
  {
    "id": "A09",
    "name": "Accessibility Reviewer",
    "knowledge": "Semantics, focus, keyboard behavior, labels, contrast.",
    "inputs": "Preview and component structure.",
    "output": "Automated findings plus required manual checks.",
    "boundary": "Cannot claim full conformance from automation alone.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A10",
    "name": "Performance Engineer",
    "knowledge": "Rendering, bundles, caching, queries, profiles.",
    "inputs": "Controlled baseline and candidate measurements.",
    "output": "Measured optimization with comparable evidence.",
    "boundary": "No unscheduled production load generation.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A11",
    "name": "Data Integrity Engineer",
    "knowledge": "Schema compatibility, transactions, migrations, data preservation.",
    "inputs": "Sanitized schema and synthetic/test data.",
    "output": "Migration assessment and tested data-change proposal.",
    "boundary": "No automatic production deletion or arbitrary queries.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A12",
    "name": "Infrastructure Reviewer",
    "knowledge": "Deployment manifests, TLS, service health, least privilege.",
    "inputs": "Approved configuration and narrow health observations.",
    "output": "Configuration diagnosis and proposed patch.",
    "boundary": "No generic root shell, firewall disablement, or target discovery.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A13",
    "name": "Test Author",
    "knowledge": "Acceptance criteria, fixtures, regression design, user journeys.",
    "inputs": "Requirements and baseline functional behavior.",
    "output": "Independent test additions and expected outcomes.",
    "boundary": "Cannot weaken existing tests to conceal a regression.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A14",
    "name": "Independent QA Verifier",
    "knowledge": "Test execution, coverage interpretation, failure analysis.",
    "inputs": "Exact candidate artifact and registered checks.",
    "output": "Actual results tied to commit, image, and environment.",
    "boundary": "Cannot fabricate tests or silently mark skipped checks passed.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A15",
    "name": "Visual Regression Reviewer",
    "knowledge": "Stable screenshots, viewports, brand tokens, layout differences.",
    "inputs": "Baseline, candidate screenshots, intended changes.",
    "output": "Labeled before/after evidence and regression assessment.",
    "boundary": "Baseline updates require explicit review.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A16",
    "name": "Independent Change Reviewer",
    "knowledge": "Diff analysis, requirement fit, change impact, secure implementation.",
    "inputs": "Patch, test results, approval scope.",
    "output": "Accept/reject recommendation with reasons and evidence.",
    "boundary": "No self-approval and no override of release gates.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A17",
    "name": "Release and Recovery Coordinator",
    "knowledge": "Artifacts, rollout conditions, restore readiness, compatibility.",
    "inputs": "Candidate manifest, approvals, backup evidence.",
    "output": "Release/recovery proposal for the deterministic service.",
    "boundary": "No general deployment privileges in model tools.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A18",
    "name": "Evidence and Follow-Up Agent",
    "knowledge": "Case history, limitations, artifacts, customer feedback.",
    "inputs": "Verified events and user response.",
    "output": "Final report, unresolved items, or reopened issue.",
    "boundary": "No unsupported assurance or credential disclosure.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A19",
    "name": "CMS and Commerce Engineer",
    "knowledge": "WordPress/WooCommerce or approved CMS, themes, plugins, checkout.",
    "inputs": "Supported CMS snapshot and sandbox commerce fixtures.",
    "output": "Scoped CMS repair/update candidate and test evidence.",
    "boundary": "No real orders, refunds, bulk content rewrites, or root access.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A20",
    "name": "Integration Engineer",
    "knowledge": "Webhooks, third-party API contracts, timeouts, idempotency.",
    "inputs": "Redacted config and provider test fixtures.",
    "output": "Integration patch and sandbox contract evidence.",
    "boundary": "No real customer messages or live financial side effects.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A21",
    "name": "Content and Technical SEO Reviewer",
    "knowledge": "Metadata, links, canonical structure, accidental content regressions.",
    "inputs": "Approved pages and customer content constraints.",
    "output": "Content-regression findings and scoped corrections.",
    "boundary": "No unrequested marketing rewrite or public publication.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A22",
    "name": "Observability Analyst",
    "knowledge": "Redacted logs, metrics, traces, release comparison.",
    "inputs": "Scoped operational telemetry.",
    "output": "Evidence of recovery or a renewed incident alert.",
    "boundary": "Cannot disable monitoring or expose personal data.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A23",
    "name": "Knowledge Curator",
    "knowledge": "Source quality, framework versions, playbook maintenance, evaluation.",
    "inputs": "Reviewed public sources and approved generalized lessons.",
    "output": "Versioned knowledge-pack change proposal.",
    "boundary": "No automatic cross-customer learning or secret indexing.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  },
  {
    "id": "A24",
    "name": "Localization and Usability Reviewer",
    "knowledge": "Tamil/English layouts, translation, input behavior, dates, usability.",
    "inputs": "Approved UI strings and preview flows.",
    "output": "Localization and usability corrections with evidence.",
    "boundary": "Preserve technical identifiers, legal text, and customer meaning.",
    "version": 1,
    "enabled": false,
    "maxAttempts": 3,
    "maxToolCalls": 24,
    "maxConcurrentPerWebsite": 3
  }
] as const;
export const agentCatalogue = agentDefinitions.map((role) => ({
  ...role,
  enabled: true,
  sourceReview: true,
  sourceReviewLimits: { modelCallsPerStep: 1, modelSelectedToolCalls: 0, concurrentStepsPerWebsite: 1 },
  implementation: role.id === 'A02' ? 'CHAT_AND_SOURCE_REVIEW' : role.id === 'A08' ? 'STATIC_HTML_REPAIR_AND_SOURCE_REVIEW' : 'SOURCE_REVIEW',
  executionBoundary: 'Source review uses approved uploaded text only. No shell, network, credentials, source execution or production changes. Wider role capabilities remain unimplemented.'
}));
const toolDefinitions = [
  {
    "id": "T01",
    "name": "case_get_summary",
    "executionClass": "C",
    "purpose": "Read the sanitized current case and unresolved questions.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T02",
    "name": "environment_get_manifest",
    "executionClass": "C",
    "purpose": "Read the bound environment, source revision, and supported capabilities.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T03",
    "name": "access_get_capabilities",
    "executionClass": "C",
    "purpose": "Return available credential types and allowed actions, never secret values.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T04",
    "name": "case_get_authorizations",
    "executionClass": "C",
    "purpose": "Read applicable grants and their expiry without modifying them.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T05",
    "name": "findings_list_evidence",
    "executionClass": "C",
    "purpose": "Retrieve persisted findings and supporting evidence references.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T06",
    "name": "knowledge_search_reviewed",
    "executionClass": "C",
    "purpose": "Search authorized, version-matched knowledge sources.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T07",
    "name": "knowledge_get_versioned_doc",
    "executionClass": "C",
    "purpose": "Read one approved document revision with provenance.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T08",
    "name": "case_propose_plan",
    "executionClass": "C",
    "purpose": "Create a candidate plan; customer approval is still required.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T09",
    "name": "source_list_files",
    "executionClass": "R",
    "purpose": "List permitted paths in the sanitized source snapshot.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T10",
    "name": "source_read_sanitized",
    "executionClass": "R",
    "purpose": "Read bounded source ranges while excluding secret-bearing files.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T11",
    "name": "source_search_symbols",
    "executionClass": "R",
    "purpose": "Search approved source paths and return bounded matches.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T12",
    "name": "source_diff_snapshot",
    "executionClass": "R",
    "purpose": "Compare two authorized revisions and report changed paths.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T13",
    "name": "workspace_create",
    "executionClass": "W",
    "purpose": "Create an isolated workspace from an approved sanitized snapshot.",
    "version": 1,
    "enabled": false,
    "environments": [
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T14",
    "name": "workspace_apply_patch",
    "executionClass": "W",
    "purpose": "Apply a scoped candidate patch subject to path and size limits.",
    "version": 1,
    "enabled": false,
    "environments": [
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T15",
    "name": "workspace_create_candidate",
    "executionClass": "W",
    "purpose": "Package a candidate commit/artifact without touching protected branches.",
    "version": 1,
    "enabled": false,
    "environments": [
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T16",
    "name": "workspace_check_conflicts",
    "executionClass": "R",
    "purpose": "Detect changed base revisions and conflicting file ownership.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T17",
    "name": "security_review_source",
    "executionClass": "R",
    "purpose": "Run reviewed static rules on provided source, not live exploits.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T18",
    "name": "security_review_config",
    "executionClass": "R",
    "purpose": "Check approved configuration against versioned defensive rules.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T19",
    "name": "dependencies_inventory",
    "executionClass": "R",
    "purpose": "Read manifests and lockfiles into a normalized package inventory.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T20",
    "name": "dependencies_match_advisories",
    "executionClass": "R",
    "purpose": "Match known advisories and report applicability uncertainty.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T21",
    "name": "secrets_scan_local",
    "executionClass": "R",
    "purpose": "Check authorized source for secrets; return redacted locations only.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T22",
    "name": "supplychain_inventory_image",
    "executionClass": "R",
    "purpose": "Inspect an approved image/SBOM for known package/configuration risks.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T23",
    "name": "http_check_configuration",
    "executionClass": "R",
    "purpose": "Observe headers/status at approved bound URLs with strict limits.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T24",
    "name": "tls_get_summary",
    "executionClass": "R",
    "purpose": "Read certificate/TLS configuration through a fixed scoped check.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T25",
    "name": "preview_open_bound",
    "executionClass": "W",
    "purpose": "Open only the job preview in a clean restricted browser context.",
    "version": 1,
    "enabled": false,
    "environments": [
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T26",
    "name": "browser_get_accessibility_snapshot",
    "executionClass": "R",
    "purpose": "Return a sanitized preview accessibility tree.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T27",
    "name": "browser_capture_sanitized_screenshot",
    "executionClass": "R",
    "purpose": "Capture an approved viewport while masking private regions.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T28",
    "name": "browser_run_registered_journey",
    "executionClass": "W",
    "purpose": "Execute a registered functional journey against isolated test data.",
    "version": 1,
    "enabled": false,
    "environments": [
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T29",
    "name": "design_compare_viewports",
    "executionClass": "R",
    "purpose": "Compare approved screenshots across stable viewport configurations.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T30",
    "name": "design_compare_tokens",
    "executionClass": "R",
    "purpose": "Identify divergence from approved design-token/component baselines.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T31",
    "name": "accessibility_run_checks",
    "executionClass": "R",
    "purpose": "Check static HTML language, alt, iframe title and ID references; browser accessibility assessment is separate.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T32",
    "name": "content_check_links",
    "executionClass": "R",
    "purpose": "Check local fragment links against IDs in supplied HTML; no fetching or route validation.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T33",
    "name": "quality_run_lint",
    "executionClass": "W",
    "purpose": "Execute the registered lint profile in an isolated worker.",
    "version": 1,
    "enabled": false,
    "environments": [
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T34",
    "name": "quality_run_typecheck",
    "executionClass": "W",
    "purpose": "Execute a supported static type-check profile.",
    "version": 1,
    "enabled": false,
    "environments": [
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T35",
    "name": "quality_run_unit_tests",
    "executionClass": "W",
    "purpose": "Run registered unit tests using synthetic fixtures.",
    "version": 1,
    "enabled": false,
    "environments": [
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T36",
    "name": "quality_run_integration_tests",
    "executionClass": "W",
    "purpose": "Run controlled integration tests with test-only dependencies.",
    "version": 1,
    "enabled": false,
    "environments": [
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T37",
    "name": "quality_run_build",
    "executionClass": "W",
    "purpose": "Build the candidate using pinned, approved dependencies.",
    "version": 1,
    "enabled": false,
    "environments": [
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T38",
    "name": "api_validate_contract",
    "executionClass": "R",
    "purpose": "Validate declared API schemas and compatibility changes offline.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T39",
    "name": "api_run_fixture_checks",
    "executionClass": "W",
    "purpose": "Test expected API behavior in an isolated fixture environment.",
    "version": 1,
    "enabled": false,
    "environments": [
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T40",
    "name": "performance_compare_runs",
    "executionClass": "W",
    "purpose": "Compare controlled baseline/candidate profiles, not production stress.",
    "version": 1,
    "enabled": false,
    "environments": [
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T41",
    "name": "cms_get_inventory",
    "executionClass": "R",
    "purpose": "Read permitted CMS/theme/plugin versions through a supported connector.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T42",
    "name": "cms_compare_trusted_files",
    "executionClass": "R",
    "purpose": "Compare approved CMS snapshot files with trusted package artifacts.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T43",
    "name": "cms_prepare_approved_update",
    "executionClass": "W",
    "purpose": "Prepare an approved CMS update in staging with compatibility checks.",
    "version": 1,
    "enabled": false,
    "environments": [
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T44",
    "name": "commerce_run_test_checkout",
    "executionClass": "W",
    "purpose": "Exercise sandbox checkout; no real orders, payments, or messages.",
    "version": 1,
    "enabled": false,
    "environments": [
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T45",
    "name": "database_get_schema",
    "executionClass": "R",
    "purpose": "Read sanitized structural schema metadata, not customer rows.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T46",
    "name": "database_check_migration_compatibility",
    "executionClass": "W",
    "purpose": "Validate migration behavior using test databases and recovery constraints.",
    "version": 1,
    "enabled": false,
    "environments": [
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T47",
    "name": "infra_review_manifest",
    "executionClass": "R",
    "purpose": "Review provided deployment configuration without modifying infrastructure.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T48",
    "name": "integration_test_fixture",
    "executionClass": "W",
    "purpose": "Validate integrations against mocks or approved provider test accounts.",
    "version": 1,
    "enabled": false,
    "environments": [
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T49",
    "name": "evidence_record_candidate",
    "executionClass": "C",
    "purpose": "Register candidate artifacts with hashes and provenance.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T50",
    "name": "evidence_get_artifact",
    "executionClass": "C",
    "purpose": "Retrieve an authorized sanitized artifact or short-lived preview reference.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T51",
    "name": "review_get_change_summary",
    "executionClass": "C",
    "purpose": "Summarize the exact patch and attached verification results.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T52",
    "name": "preview_publish_candidate",
    "executionClass": "W",
    "purpose": "Publish a private isolated preview with no production credentials.",
    "version": 1,
    "enabled": false,
    "environments": [
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T53",
    "name": "recovery_get_readiness",
    "executionClass": "C",
    "purpose": "Read actual backup/restore readiness; never fabricate a restore point.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T54",
    "name": "release_prepare_manifest",
    "executionClass": "C",
    "purpose": "Prepare a release proposal bound to candidate, target, and verification.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T55",
    "name": "release_request_approval",
    "executionClass": "C",
    "purpose": "Publish a real customer approval card, without granting approval.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T56",
    "name": "release_get_status",
    "executionClass": "C",
    "purpose": "Read authoritative release and post-deployment health state.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T57",
    "name": "observability_get_redacted_errors",
    "executionClass": "R",
    "purpose": "Read bounded sanitized operational errors for the approved website.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T58",
    "name": "observability_get_health",
    "executionClass": "R",
    "purpose": "Read registered health signals with timestamps and coverage.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T59",
    "name": "workflow_get_status",
    "executionClass": "C",
    "purpose": "Read persisted workflow state, blockers, and active tasks.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T60",
    "name": "workflow_request_pause",
    "executionClass": "C",
    "purpose": "Request a safe pause and report any in-flight uncertainty.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T61",
    "name": "specialist_request_handoff",
    "executionClass": "C",
    "purpose": "Create a human-help request with sanitized context; no automatic secret grant.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T62",
    "name": "report_prepare_summary",
    "executionClass": "C",
    "purpose": "Prepare a report using actual findings, verification, and limitations.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T63",
    "name": "feedback_attach_issue",
    "executionClass": "C",
    "purpose": "Attach customer feedback to a case and propose a reopened work item.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  {
    "id": "T64",
    "name": "monitoring_propose_plan",
    "executionClass": "C",
    "purpose": "Propose a scoped monitoring schedule requiring customer approval.",
    "version": 1,
    "enabled": false,
    "environments": [
      "PRODUCTION",
      "STAGING"
    ],
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "unavailableReason": "Implementation and capability evaluation required"
  },
  { id: 'T65', name: 'source_check_syntax', executionClass: 'R', purpose: 'Parse approved JSON and JS/TS/JSX/TSX text in memory; no imports, type checking or execution.', version: 1, enabled: false, environments: ['PRODUCTION','STAGING'], timeoutMs: 30000, maxOutputBytes: 65536, unavailableReason: 'Implementation and capability evaluation required' },
  { id: 'T66', name: 'design_check_css', executionClass: 'R', purpose: 'Parse standalone CSS without plugins, source maps or rendering.', version: 1, enabled: false, environments: ['PRODUCTION','STAGING'], timeoutMs: 30000, maxOutputBytes: 65536, unavailableReason: 'Implementation and capability evaluation required' },
  { id: 'T67', name: 'source_check_yaml', executionClass: 'R', purpose: 'Parse supplied YAML documents with duplicate-key diagnostics; no alias expansion, custom tag resolution, schema validation or execution.', version: 1, enabled: false, environments: ['PRODUCTION','STAGING'], timeoutMs: 30000, maxOutputBytes: 65536, unavailableReason: 'Implementation and capability evaluation required' }
] as const;

export const toolCatalogue = toolDefinitions.map((tool) => {
  const enabled = (implementedReviewTools as readonly string[]).includes(tool.id);
  return { ...tool, version: ['T31','T32','T53'].includes(tool.id) ? 2 : tool.version, enabled, maxOutputBytes: tool.id === 'T10' ? 250000 : tool.maxOutputBytes, implementation: enabled ? tool.id === 'T53' ? 'SCOPED_RECOVERY_METADATA' : 'OFFLINE_SOURCE_REVIEW' : 'UNIMPLEMENTED', unavailableReason: enabled ? null : tool.unavailableReason };
});
