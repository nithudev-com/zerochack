# Finite security repair capabilities

Current activation: **none of the new security mutation tracks**. This matrix
records real implementation gaps, not a completed list of disabled tool names.
Existing six read-only inspection/handoff tools and67Care bindings remain separate.

Every supported slice needs a versioned exact manifest, authoritative payment/
entitlement and actor/session/MFA/grant checks, encrypted verified recovery,
exclusive resource guarantees, deterministic mutation, independent post-checks
and separately scoped recovery. No universal shell/SQL/recursivechmod fallback.

| Track | Intended first supported operation | Existing code / unfinished local work | External/deployment gate |
| --- | --- | --- | --- |
| A permissions | One eligible regular non-secret website file; remove world-write only | Unwired SFTP primitive; needs trusted helper, journal, exact approval, recovery and end-to-end UI | Independently enforced writer/rename exclusion and single-link identity; ordinary shared SFTP is insufficient |
| B quarantine | One exactly identified approved malicious file, preserving bytes/metadata outside executable root | No security quarantine executor/approval/verifier yet | Safe hosting primitive, vetted diagnosis and quarantine/recovery location |
| C WP core | Exact known version+locale from trusted provenance; exclude wp-config/content | Existing T42/T43 are offline subset comparison/preparation only; no live restoration | Reviewed official package/checksum, custom-core refusal and isolated PHP/WP regression runtime |
| D plugin/theme | Trusted authorized integrity restoration/security update | No connected security repair slice | Exact source/license, customization preservation and compatibility evidence |
| E redirects/injection | Precisely scoped malicious content/config patch | No production cleanup playbook; static HTML workflow is not this capability | Trusted deployment/file adapter, legitimate redirect regression evidence |
| F source/dependencies | Reproducible PHP/Node snapshot patch addressing scoped security finding | No connected executable candidate loop | Local isolated runtime, authorized package sources, lockfile/provenance and meaningful regressions |
| G config/headers | One typed hosting-supported setting | Public header checks observe only; no safe apply adapter | Real connector/provider transaction/validation and recovery |
| H persistence | Exact WP option/account/task or supported server artifact | No typed security DB/task mutation adapter | Transactions/preimage/recovery and explicit resource-specific authority |
| I external actions | Separate typed credential/DNS/WAF provider operation | No security provider mutation adapter; provide accurate handoff meanwhile | Narrow approved provider access; never request broad credentials or bypass licensing |

Full-server discovery is not part of a selected-website repair. Root mapping and
every resource remain bound to that website; shared hosting account access is not
authorization for sibling websites. Preserve suspect originals as evidence;
forensic copies are not assumed clean restore sources. Model judgments/heuristics
alone cannot authorize quarantine or certify malware-free status.

Unsupported/customized stacks receive a specific limitation and requested human
handoff. New capability status must distinguish implemented, configured, enabled
and independently live-verified. There is no enable-all switch.
