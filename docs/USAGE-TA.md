# Zerochack பயன்பாட்டு வழிகாட்டி

இந்த வழிகாட்டி `codex/zeroroot-chat-care-upgrade` branch-ல் உள்ள செயல்பாடுகளை விளக்குகிறது. GitHub-ல் code இருப்பதும் உங்கள் live application-ல் அது deploy செய்யப்பட்டிருப்பதும் வெவ்வேறு நிலைகள். முழு 100-item திட்டமும் இன்னும் முடிவடையவில்லை. தற்போதைய ஆதாரங்கள் [implementation record](CARE-IMPLEMENTATION.md), மீதமுள்ள வேலைகள் [requirement ledger](upgrade-ledger.json) ஆகியவற்றில் உள்ளன.

## யார் எந்தப் பகுதியைப் பயன்படுத்துவது?

| பயனர் | பயன்பாடு |
| --- | --- |
| Customer | சொந்த websites, website chat, source review, access approval, subscription, billing, notifications |
| Agency | அனுமதி வழங்கப்பட்ட clients, websites, quotes, subscription மற்றும் billing தகவல்கள் |
| Affiliate | Referral link, attribution, commissions, transactions, payout நிலைகள் |
| Specialist | ஒதுக்கப்பட்ட support tickets; வாடிக்கையாளர் அனுமதியுடன் குறிப்பிட்ட account access |
| Owner | Users/approvals, tenants, specialists, packages/pricing, AI Gateway, integrations, system health, audit logs; MFA தேவை |

இந்த user roles-ம் கீழே உள்ள 24 AI roles-ம் வேறு. Agency அல்லது Specialist account வைத்திருப்பதால் எல்லா வாடிக்கையாளர் தரவையும் பார்க்க முடியாது; நடப்பு permission மற்றும் assignment சரிபார்க்கப்படும்.

## வாடிக்கையாளரின் வழக்கமான பயணம்

1. Customer login வழியாக உள்நுழையுங்கள். புதிய account என்றால் verification மற்றும் account approval நிலைகளை முடிக்கவும்.
2. **My Websites** பகுதியில் website-ஐச் சேர்க்கவும். Ownership verification கேட்டால் application காட்டும் முறையைப் பின்பற்றவும். சேர்த்தவுடன் website பாதுகாப்பானது என்று கருத வேண்டாம்; உண்மையான check முடிவுக்குப் பிறகே நிலை தெரியும்.
3. Website workspace-ஐத் திறந்து chat-ல் பிரச்சினையையும் எதிர்பார்க்கும் முடிவையும் சொல்லுங்கள். உதாரணம்: “Mobile-ல் contact form button திரைக்கு வெளியே செல்கிறது; 390px அகலத்தில் முழுவதும் தெரிய வேண்டும்.”
4. **Production / Staging** தேர்வு சரியாக உள்ளதா பாருங்கள். Chat, approval, review பதிவுகள் அந்தத் தேர்வுக்குள் பிரிக்கப்படும். Source review-ல் Production தேர்ந்தெடுத்தாலும் அது உங்கள் live server-ஐ அணுகாது.
5. தேவைக்கேற்ப source review, supported HTML repair அல்லது மனித specialist உதவியைத் தேர்ந்தெடுக்கவும். Pricing, access, findings, tickets, settings ஆகியவை website navigation-ல் கிடைக்கும்; mobile-ல் **Website options** வழியாகத் திறக்கலாம்.
6. செய்தி, report அல்லது job நிலையைப் பாருங்கள். `QUEUED` என்பது காத்திருக்கிறது; `RUNNING` என்பது வேலை நடக்கிறது; `COMPLETED` என்பது அந்தக் குறிப்பிட்ட வேலை முடிந்தது. ஒரு review complete ஆனதால் website fix அல்லது deploy ஆகியதாக அர்த்தமில்லை.

## 24 AI roles-ஐப் பயன்படுத்துவது

Website conversation-ல் **Review source with AI team** தேர்ந்தெடுக்கவும். தேவையான roles அல்லது all 24 தேர்வு செய்து report மொழியை **Tamil** ஆக அமைக்கவும். அதிக roles என்றால் அதிக model calls மற்றும் செலவு ஏற்படலாம்; எல்லா பிரச்சினைக்கும் எல்லா roles-மும் தேவையில்லை.

1–30 UTF-8 text-source files upload செய்யலாம். மொத்த snapshot metadata உட்பட 200 KB-க்குள் இருக்க வேண்டும். File paths தொடர்புடைய relative paths ஆக இருக்க வேண்டும். Passwords, tokens, private keys, தனிப்பட்ட customer data ஆகியவற்றை முதலில் நீக்குங்கள். Secret screening சில patterns மட்டுமே கண்டறியும்; எல்லா secrets-ஐயும் கண்டறியும் உறுதி கிடையாது.

Issue, expected outcome மற்றும் model allowance-ஐ உள்ளிட்டு privacy review உறுதிப்படுத்திய பின் **Prepare team review plan** தேர்ந்தெடுக்கவும். இந்தப் படி source-ஐ encrypted storage-ல் வைக்கும்; AI model call இன்னும் தொடங்காது.

Plan-ல் source fingerprint, roles, model, மொழி, allowance ஆகியவற்றைப் பார்த்து **Approve source review** தேர்ந்தெடுக்கவும். இந்த exact plan-க்கு ஒரு மணி நேர அனுமதி வழங்கப்படும். Worker ஒவ்வொரு role-ஐயும் வரிசையாகச் செயல்படுத்தி அதன் முடிவை database-ல் பதிவு செய்யும். **Your AI team** பகுதியில் நடப்பு நிலையும் reports-ம் கிடைக்கும். 24 roles எல்லாம் ஒரே நேரத்தில் ஓடுவதில்லை; ஒரே website-க்கு ஒரு review step மட்டுமே இயங்கும்.

| ID | Role | இந்த source-review mode-ல் செய்யும் வேலை |
| --- | --- | --- |
| A01 | Coordinator | கொடுக்கப்பட்ட scope, சார்புகள், விடுபட்ட தகவல், வேலைத் திட்டம் |
| A02 | Customer Liaison | பிரச்சினை விளக்கம், தமிழ்/ஆங்கில தொடர்பு, தெளிவுபடுத்தும் கேள்விகள் |
| A03 | Environment Mapper | Source-ல் தெரியும் technologies மற்றும் declared versions |
| A04 | Incident Triage | கொடுக்கப்பட்ட அறிகுறிகளின் மதிப்பீடு, மனித உதவி தேவைப்படும் இடங்கள் |
| A05 | Application Security Reviewer | Authentication, permissions, input validation, data handling பற்றிய பாதுகாப்பு review |
| A06 | Dependency Reviewer | கொடுக்கப்பட்ட dependency declarations; current CVE feed இங்கு இல்லை |
| A07 | API and Backend Engineer | Backend/API source logic பற்றிய observations மற்றும் பரிந்துரைகள் |
| A08 | Frontend Repair Engineer | Frontend/layout source review; HTML repair தனி workflow |
| A09 | Accessibility Reviewer | Labels, semantics, keyboard intent; உண்மையான browser சோதனை இல்லை |
| A10 | Performance Engineer | Source-ல் தெரியும் performance சந்தேகங்கள் மற்றும் அளவீட்டுத் திட்டம் |
| A11 | Data Integrity Engineer | கொடுக்கப்பட்ட schema/migration text மற்றும் data-preservation கவனிப்புகள் |
| A12 | Infrastructure Reviewer | கொடுக்கப்பட்ட deployment manifests/configuration |
| A13 | Test Author | தேவைக்கேற்ற test cases மற்றும் acceptance criteria பரிந்துரை |
| A14 | Independent QA Verifier | முந்தைய source claims-ஐ original source-உடன் மீண்டும் ஒப்பிடுதல் |
| A15 | Visual Regression Reviewer | Source அடிப்படையிலான layout risks; screenshot comparison இல்லை |
| A16 | Independent Change Reviewer | முந்தைய பரிந்துரைகள் scope/source-க்கு பொருந்துகிறதா என மீளாய்வு |
| A17 | Release and Recovery Coordinator | Release prerequisites, backup/restore குறித்து சரிபார்க்க வேண்டிய கேள்விகள் |
| A18 | Evidence and Follow-Up Agent | ஆதாரமுள்ள findings, விடுபட்ட தகவல்கள், அடுத்த முடிவுகள் |
| A19 | CMS and Commerce Engineer | கொடுக்கப்பட்ட CMS/commerce source மற்றும் manifests |
| A20 | Integration Engineer | Integration contracts, error handling, timeout/idempotency logic |
| A21 | Content and Technical SEO Reviewer | கொடுக்கப்பட்ட metadata, headings மற்றும் உள்ளடக்க ஒற்றுமை |
| A22 | Observability Analyst | கொடுக்கப்பட்ட sanitized logs மற்றும் logging configuration |
| A23 | Knowledge Curator | கொடுக்கப்பட்ட technical documentation; பிற customers-ன் தகவலைப் பயன்படுத்தாது |
| A24 | Localization and Usability Reviewer | தமிழ்/ஆங்கில UI text, input மற்றும் date-handling assumptions |

இந்த mode-ல் எல்லா roles-மும் uploaded source-ஐ ஆய்வு செய்து ஆலோசனை வழங்குகின்றன. Code execution, automatic patch, runtime test, browser rendering, live infrastructure access அல்லது deployment செய்யாது. Role பெயரில் “Engineer”, “QA” அல்லது “Release” இருப்பது அந்த விரிவான திறன்கள் அனைத்தும் செயல்படுத்தப்பட்டுள்ளன என்று பொருள் அல்ல.

## Report-ஐ எப்படி புரிந்துகொள்வது?

ஒவ்வொரு finding-லும் file path, line range, source quote, காரணம், பரிந்துரை இருக்கும். Quote அந்த source-ல் உள்ளதா என்பதை server சரிபார்க்கும். Quote சரியாக இருப்பது model-ன் முடிவு சரி என்பதற்கான உத்தரவாதம் அல்ல; அதன் விளக்கத்தையும் நீங்கள் ஆய்வு செய்ய வேண்டும்.

| Report நிலை | அர்த்தம் |
| --- | --- |
| `REVIEWED` | கொடுக்கப்பட்ட source மீது review report வந்துள்ளது |
| `NEEDS_INPUT` | தேவையான தகவல் இல்லை; கூடுதல் context தேவை |
| `NOT_APPLICABLE` | அந்த role-க்கு கொடுக்கப்பட்ட scope பொருந்தவில்லை |

Review-ஐ நிறுத்தலாம். ஏற்கெனவே provider-க்கு அனுப்பப்பட்ட request-க்கு செலவு ஏற்படலாம்; cancellation-க்குப் பின் அந்த முடிவு publish செய்யப்படாது. Worker தொலைந்தாலோ provider முடிவு தெரியாவிட்டாலோ தானாக மீண்டும் model call செய்யாது. Scope மாற்ற அல்லது நிறுத்திய review-ஐ மீண்டும் செய்ய புதிய plan மற்றும் approval தேவை. Source/report artifacts-க்கு தற்போதைய retention ஏழு நாட்கள்.

## Chat, HTML repair, release — தனித்தனி செயல்கள்

A02 வழக்கமான customer chat-லும் இயங்கும். Supported repair workflow-ல் A08 ஒரு standalone HTML + inline CSS file-க்கு மட்டும் candidate மாற்றத்தை உருவாக்கலாம். JavaScript app, பல-file project, backend அல்லது database repair தற்போது இதில் அடங்காது.

Repair-க்கு issue பதிவு, source upload, exact plan approval தேவை. Candidate வந்ததும் before/after preview-ஐ நீங்கள் பார்த்து எதிர்பார்த்த மாற்றம் உள்ளதா முடிவு செய்ய வேண்டும். Structural checks மட்டும் design, behavior அல்லது முழு accessibility-ஐ நிரூபிக்காது.

Release தனி அனுமதி கொண்ட செயலாகும். அது enable செய்யப்பட்ட deployment-ல் மட்டுமே, supported single-file SFTP target, trusted host fingerprint, fresh MFA, exact candidate/path approval ஆகியவற்றுடன் செயல்படும். Code merge, live server deployment மற்றும் AI review completion ஒன்றல்ல. இந்த branch-க்கு real-host publish/restore drill இன்னும் செய்யப்படவில்லை.

## Credentials மற்றும் மனித specialist

Password/private key போன்றவற்றை சாதாரண chat-ல் பதிவிடாதீர்கள். **Secure connection** intake அல்லது dedicated access form பயன்படுத்தவும். சேமிப்பு receipt கிடைத்தால் credential encrypted storage-ல் சேமிக்கப்பட்டது என்று மட்டும் பொருள்; connection வெற்றியடைந்தது என்று பொருள் அல்ல.

SSH, SFTP, CMS, database, repository, API, hosting account வடிவங்களைச் சேமிக்கலாம். தற்போது vault reference-ஐ பயன்படுத்தும் connector existing production SSH connector மட்டுமே. மற்ற account வகைகளைச் சேமிக்க முடிவது அவற்றுடன் connect செய்யும் implementation முடிந்துவிட்டது என்று அர்த்தமில்லை.

Assigned Specialist account access கேட்டால் காரணம், exact account மற்றும் expiry-ஐப் பார்த்து அனுமதி கொடுக்கவும். Specialist-க்கு current assignment, unexpired grant, MFA மற்றும் சமீபத்திய identity verification தேவை. Owner role இருப்பதால் இந்த அனுமதி தானாகக் கிடைக்காது. வெளியில் copy செய்யப்பட்ட credential-ஐ UI மூலம் மீட்டெடுக்க முடியாது; தேவைப்பட்டால் provider-ல் rotate செய்ய வேண்டும்.

## Owner: rollout மற்றும் health

API, web, worker ஆகியவற்றை ஒரே version-ல் deploy செய்து migrations apply செய்ய வேண்டும். AI Gateway-ல் provider credential, அந்த account-க்கு கிடைக்கும் model, சரியான input/output prices, tenant AI policy அமைக்கவும். Credentials-ஐ secret manager அல்லது dedicated configuration வழியாகவே அமைக்கவும்.

Source review-க்கு `CARE_ENABLED=true`, `CARE_REVIEW_ENABLED=true`, தனித்த `CARE_VAULT_KEY` மற்றும் `CARE_ARTIFACT_KEY` தேவை. Repair/release flags தனித்தனியானவை. Enable செய்வதற்கு முன் [operations guide](CARE-OPERATIONS.md) மற்றும் [source-review rollout](CARE-SOURCE-REVIEWS.md) படிக்கவும்.

Deployment configuration loaded ஆன சூழலில் `npm run care:preflight -- TENANT_UUID` database columns, Redis, worker heartbeat, provider/model setup மற்றும் flags-ஐப் பார்க்கும். இது model call செய்யாது; live provider accuracy அல்லது production readiness certificate வழங்காது. Owner **System Health**-ல் `NOT_CONFIGURED` அல்லது `FAILED` தெரிந்தால் அந்த dependency-ஐ அமைத்து சரிபார்க்க வேண்டும்.

## இன்னும் என்ன தேவை?

இந்த bounded source-review flow-க்கு கூடுதல் agent framework அல்லது vector database சேர்க்கப்படவில்லை. தற்போதைய stack போதுமானது. Accuracy/reliability-ஐ உறுதிசெய்ய real provider-ல் representative cases, மனித மதிப்பீடு, failure/recovery drills மற்றும் deployment verification தேவை.

24 review roles செயல்படுத்தப்பட்டுள்ளன; proposed tool catalogue-ல் 44 bounded implementations/workflow bindings உள்ளன; 23 wider tools இன்னும் unavailable. General application repair-க்கு isolated execution/browser workers, supported build/test profiles, target-specific connectors, independent verification மற்றும் operational recovery வேலைகள் மீதமுள்ளன. இவை முடியும் வரை “அனைத்து agents/tools-ம் 100% production working” என்று இந்த project-ஐக் கூற முடியாது.


## Browser மூடிய பிறகு தொடர்வது

அதே account-ல் login செய்து **My Websites → Open workspace** திறக்கவும். Submit செய்த messages, jobs, source files, reports ஆகியவை சேமிக்கப்பட்டிருக்கும். **Load older messages**, **Load older jobs** மூலம் பழைய history-ஐப் பார்க்கலாம். Source/report files ஏழு நாட்களில் தானாக அழியும் பழைய விதி நீக்கப்பட்டுள்ளது. Storage நிரம்பினால் புதிய upload நிறுத்தப்படும்; பழைய history அழிக்கப்படாது. Submit செய்யாத draft மற்றும் credential input browser storage-ல் சேமிக்கப்படாது. Expired credential அல்லது approval-க்கு புதிய அனுமதி தேவை; history இருப்பது அனுமதியை நீட்டிக்காது.

## புதிய code, design, recovery checks

Review report-ல் **Deterministic source checks** திறந்தால் HTML accessibility attributes, local links, JSON/JS/TS syntax மற்றும் CSS parsing முடிவுகள் தெரியும். இவை source-ஐ execute செய்வதில்லை; முழு build/test அல்லது WCAG certification அல்ல. **Recovery readiness** திறந்தால் production backup record, backup schedule, monitoring record, unresolved release ஆகியவற்றின் உண்மையான சேமிக்கப்பட்ட நிலை தெரியும். “Configured” என்பது restore செய்து நிரூபிக்கப்பட்டது என்று அர்த்தமில்லை. Staging-க்கு ஆதாரம் இல்லாவிட்டால் “not observed” எனத் தெரியும்.

தற்போது 24 review roles, 44 bounded tool implementations/workflow bindings உள்ளன; 23 wider tool contracts unavailable. Figma போன்ற ChatGPT connector இணைப்பு உங்கள் application-க்கு MCP server அல்லது account credential தானாக அமைக்காது. Account-specific configuration, live-provider evaluation மற்றும் தனியான restore drill இன்னும் தேவை.


## புதிய “All technologies” பயன்பாடு

Homepage-ல் **All technologies** தேர்ந்தெடுத்து technology பெயர் அல்லது file பெயரைத் தேடுங்கள். 12 பகுதிகளிலும் **Review team & file support** திறந்தால் பரிந்துரைக்கப்படும் agents, ஏற்கப்படும் file எடுத்துக்காட்டுகள், கிடைக்கும் automatic checks தெரியும். மேலே காட்டப்படும் எண்ணிக்கை application registry-இலிருந்து வருகிறது: 24 source-review roles, 44 bounded tool implementations/workflow bindings; 23 விரிவான tools இன்னும் கிடைக்கவில்லை. இந்த எண்ணிக்கை உங்கள் live server இணைக்கப்பட்டுவிட்டது என்பதைக் குறிக்காது.

Website → **Review source with AI team** → **Technology area · suggested team** மூலம் அதே பகுதியைத் தேர்ந்தெடுக்கலாம். கிடைக்கும் roles மட்டும் தேர்வாகும்; தேவையெனில் மாற்றலாம். C#, Razor, Astro, Shopify Liquid, GraphQL, protobuf, Terraform/HCL, server .conf/.service, Caddyfile, Jenkinsfile போன்ற source text-கள் இப்போது ஏற்கப்படும். **Accepted source formats** முழுப் பட்டியலைக் காட்டும். Passwords, private data, .env, secrets, Terraform state, private keys, archives அனுப்ப வேண்டாம்.

YAML கோப்புகளுக்கு T67 syntax/duplicate-key check சேர்க்கப்பட்டுள்ளது. முடிவுகள் saved report-ல் **Deterministic source checks** கீழ் கிடைக்கும். எல்லா language-க்கும் compiler, test runner அல்லது automatic repair கிடைப்பதாக இதைப் பொருள் கொள்ள வேண்டாம். Approved source review-க்கு configured AI provider தேவை; live pipeline/server மாற்றங்கள் இந்த review-ல் நடக்காது.

புதிய review policy v3. முடிவடையாத பழைய v1/v2 plan-க்கு புதிய plan உருவாக்கி approve செய்ய வேண்டும். பழைய saved conversations/reports அழிக்கப்படாது. Tab மூடியபின் அதே account மற்றும் website-ஐத் திறந்து submitted work-ஐத் தொடரலாம்.

Production-ல் பக்கம் “Loading ZeroRoot” நிலையில் நிற்கச் செய்த CSP பிரச்சினையும் சரிசெய்யப்பட்டுள்ளது. ஒவ்வொரு page request-க்கும் தனி script nonce உருவாகிறது. Deploy செய்யும்போது API/web/worker-ஐ ஒன்றாக update செய்யவும்; nonce உள்ள HTML-ஐ CDN shared cache-ல் சேமிக்க வேண்டாம். CI-ல் development மற்றும் production browser checks இரண்டும் ஓடும்.

### புதிய tool வசதிகள்

ஒவ்வொரு repair/review job-லும் **Saved evidence & source tools** திறந்து saved findings, change summary, release status, workflow errors மற்றும் recorded monitoring health-ஐப் படிக்கலாம். CSS comparison-க்கு அதே approved snapshot-ல் உள்ள இரண்டு CSS பாதைகள் மற்றும் காலாவதியாகாத source-review approval தேவை.

Production job-ல் **Propose a monitoring schedule** மூலம் interval கொடுத்து proposal-ஐ சேமிக்கலாம். இது monitoring-ஐ activate செய்யாது. Customer review முடிந்ததும் authorized operator monitoring policy/scheduler-ஐ தனியாக அமைக்க வேண்டும். Proposal history tab மூடியபிறகும் இருக்கும்; cancel செய்தாலும் பதிவை அழிக்காது.

Owner **Care capabilities**-ல் ஒவ்வொரு tool-க்கும் implemented scope, deployment setting, execution route, setup requirements கிடைக்கும். 52-ல் 19 புதிய bounded handlers/proposal implementation, 10 existing workflow bindings சேர்க்கப்பட்டுள்ளன. மீதமுள்ள 23-க்கு isolated workers அல்லது provider-specific connectors தேவை; அவை செயல்படுவதாக காட்டப்படவில்லை. முழு பட்டியல்: [Tool contract matrix](CARE-TOOL-CONTRACTS.md).
