# Guided security chat: implemented boundary

The security workspace is a conversation-first interface. The scrollable
transcript keeps its composer visible, renders readable Markdown, collapses
routine system notices without deleting them, and does not repeat onboarding
once a conversation exists. Saved SSH state is distinct from inspection or fix
authorization. Old signed/history messages are not rewritten cosmetically.

## Explicit inspection

After a usable SSH check, **Inspect website** invokes the existing authenticated
`POST /v1/websites/:websiteId/assessment` route directly. It does not rely on a
model understanding "yes" or choosing a tool. The button states that it authorizes
bounded SSH/public web inspection only, not file changes. It performs no paid
model call. Existing host-key pinning, credential broker expiry, tenant isolation,
rate/concurrency limits and scan uniqueness remain required. Progress and results
are persisted in the existing chat/scan records. Network failure does not cause
automatic retries: customers should review saved progress before retrying.

A duplicate active assessment returns `SCAN_ALREADY_ACTIVE` before any new SSH
connection. Missing/expired access fails closed. The existing assessment has
bounded network/SSH operations; this change does not introduce a general shell
or run customer code on the control-plane host.

Short ambiguous confirmations following an inspection question receive one
concrete action instead of another model-generated questionnaire. Other task
confirmations, explicit refusals and actual issue descriptions are not rerouted
into a security scan. Model guidance asks one focused question at a time, uses
the saved URL/details and keeps responses short. This is a prompt contract, not
a guarantee about every live provider response. Inspection results must still
report measured coverage and limitations honestly.

## Live security repairs are BLOCKED

The security chat has no validated live SSH malware-cleanup, WordPress repair or
server-configuration mutation adapter. Its assessment tools do not implement
those changes. Changing finding status is not a website repair. No credential
capture or connection-check consent grants generic write permission.

The separate Care workflow supports only approved static HTML candidate work
and tightly scoped single-file SFTP releases when their independently validated
capabilities are enabled. These do not provide general security repair; the
existing deployment leaves these unvalidated capabilities disabled.

Before enabling a new live security-repair capability, implement and test its
specific supported change contract, canonical target binding and stale-source
checks, customer-visible diff/plan and separate approval, verified restore point,
bounded execution, cancellation/reconciliation, post-change verification and
recovery. Test it on a disposable target first. Do not substitute a prompt change,
root shell access, a Docker socket, or a status update for this work. No production
write/repair flag is enabled by this chat-interface update.

## Verification

Use gateway unit tests, `conversation-guidance.test.ts`, disposable auth
integration tests and `security-chat.spec.ts` in development and production-image
modes. Browser assessment responses and model outputs are fixtures, not evidence
that a customer's live website was scanned or repaired. Never launch an inspection
against a live customer's stored SSH credentials just to validate the UI.
