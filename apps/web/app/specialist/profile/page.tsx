import { SpecialistPortal } from '../../../components/specialist-portal';
import { MfaSettings } from '../../../components/mfa-settings';
export default function Page() { return <div className="portal-stack"><SpecialistPortal section="profile"/><p>Authenticator MFA is required before you can reveal customer-approved credentials.</p><MfaSettings/></div>; }
