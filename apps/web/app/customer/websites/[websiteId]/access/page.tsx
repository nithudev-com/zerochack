import { WorkspacePage } from '../../../../../components/workspace';
import Link from 'next/link';

export default async function AccessPage({ params }: { params: Promise<{ websiteId: string }> }) {
  const { websiteId } = await params;
  return <><p><Link href={`/customer/websites/${websiteId}/connectors`}>Looking for WordPress, WooCommerce, Ghost or Directus? Open platform connectors.</Link></p><WorkspacePage section="access" /></>;
}
