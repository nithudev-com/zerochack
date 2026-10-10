import {OwnerControl} from '../../../components/owner-control';
import Link from 'next/link';
export default function Page(){return <><p><Link className="text-link" href="/owner/smtp-settings">Manage application SMTP settings →</Link></p><OwnerControl view="email-automation"/></>;}
