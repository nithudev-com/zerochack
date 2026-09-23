import type {Metadata} from 'next';import type {ReactNode} from 'react';import {OwnerNav} from '../../components/owner-nav';import {PortalGuard} from '../../components/portal-guard';
export const metadata:Metadata={title:'Owner Portal',robots:{index:false,follow:false}};
export default function OwnerLayout({children}:{children:ReactNode}){return <PortalGuard portal="owner" role="Owner" navigation={<OwnerNav/>} className="owner-layout">{children}</PortalGuard>;}
