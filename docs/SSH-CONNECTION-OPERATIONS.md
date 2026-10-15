# Encrypted SSH connection checks

Base capture (`CARE_ENABLED`) is separate from assessment, review, repair and
release. Enable it on the verified VPS only after building the reviewed commit,
testing its immutable images, and recording passing acceptance evidence:

```sh
python3 scripts/deploy/enable-ssh-capture.py /opt/codebandage/releases/current.env /opt/codebandage/state/ssh-acceptance.json
```

The root-owned mode-600 acceptance JSON identifies `commit`, `images` (API,
WORKER, WEB, TOOLS immutable daemon-local IDs) and `checks`, with PASS for
`ssh_protocol`, `authenticated_capture`, `credential_replacement`, `expiry`,
`browser_production`, and `production_readiness`. These must describe executed
tests, not anticipated results. Synthetic SSH and browser fixtures are not proof
of a customer's actual hosting connection. All advanced Care flags remain false.
The wrapper preserves keys, snapshots the protected environment, validates
Compose, restarts only the required services and restores the old flag on failure.
Existing enabled capture is safely revalidated on rerun. This does not approve a
public production launch or satisfy outstanding vulnerability/recovery gates.

Both SSH forms store credentials in the tenant/site/environment-bound encrypted
vault. Customers enter secrets only into the protected HTTPS form, never chat.
Use a dedicated restricted server account. Password and unencrypted dedicated
private-key authentication are supported; encrypted key passphrases, interactive
keyboard authentication and SSH certificates are not currently supported.

Enter the SSH hostname/public IP and port supplied by the hosting provider. A
website hostname may resolve to Cloudflare or another CDN, which cannot accept
SSH for the origin. Public target validation rejects private/loopback and mixed
public/private DNS answers. The normal form has host/IP, port, username and
password, with a private-key alternative. It does not ask customers to type a
fingerprint. Its consent explicitly authorizes **trust on first connection**.
Before sending authentication, the backend records the first observed server key
in a tenant/site/host/port-scoped append-only audit anchor. Later connections must
match that identity, including after password rotation, expiry, revocation or
switching away from and back to a target. Failed password authentication does not
erase the already accepted server identity.

This is an explicit usability/security trade-off: an attacker intercepting the
very first connection could become the initially trusted server. It is not
independent hosting-provider identity verification. Existing preverified pins are
preserved and adopted into the same anchors; old API clients without a pin or
explicit first-connection consent fail closed. No new database schema is needed.

When investigating an identity-change warning, support must independently check
the hosting console. On that trusted console, a provider-supported command is:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

Use the fingerprint of the host key actually negotiated by the SSH server. Never
disable host verification or replace a changed pin without investigating. When
the provider rotates its host key, confirm it through the trusted console and
request a separately approved identity-recovery operation. There is no automatic
replacement or customer bypass of a changed key; simply resubmitting a password
or checking first-connection consent cannot overwrite an existing anchor. An
identity-reset workflow is not implemented by this change.

A check authenticates, records the observed pinned identity, then disconnects;
it executes no commands and cannot promise a permanent session or availability.
DNS is bounded to 5 seconds and the complete connection attempt to 15 seconds,
with at most three validated addresses. Only transport failures may try another
address; identity/authentication rejection is terminal. Four concurrent checks
are allowed per API process and only one per tenant/site. This is a single-VPS
bound, not a distributed high-availability guarantee.

Credential authorization lasts 24 hours under the current capture policy. After
expiry, re-enter access and give fresh consent; neither a stored receipt nor an
old successful check extends authorization. Revocation/rotation preserves audit
history and invalidates old vault grants. In-flight checks cannot mark a replaced,
revoked or expired credential ready. No secret appears in connection errors,
chat history, AI prompts or metadata responses. Forms clear secrets after submit
and do not silently retry a failed credential submission.

Check errors distinguish missing/changed identity, rejected authentication,
expired authorization and bounded transport/DNS failure. Confirm provider SSH
enablement, firewall/source restrictions, correct port/user and current key before
retrying. Do not open the production Docker API or mount its socket into workers.
Preserve the original vault key in encrypted off-server recovery storage; never
regenerate it to solve an error with existing encrypted data.
