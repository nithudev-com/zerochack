'use client';
import { useQuery } from '@tanstack/react-query';
import { Card, EmptyState, ErrorState, LoadingState, Table } from '@zerochack/ui';
import { api } from '../lib/api';
import { MfaSettings } from './mfa-settings';
import { RoleDashboard } from './role-dashboard';
const pretty = (value: string) => value.replaceAll('_',' ').replaceAll('-',' ').toLowerCase();
const money = (minor: number, currency = 'USD') => new Intl.NumberFormat(undefined,{style:'currency',currency}).format(minor/100);
type View = 'overview'|'referral-link'|'referrals'|'attribution'|'commissions'|'transactions'|'payouts'|'notifications'|'profile';
export function AffiliatePortal({ view }: { view: View }) { const path = view === 'profile' ? '/auth/me' : `/affiliate/${view}`; const query = useQuery<Record<string, unknown>>({ queryKey:['affiliate',view], queryFn:()=>api(path) }); if(query.isLoading)return <LoadingState label={`Loading ${pretty(view)}`} />; if(query.isError)return <ErrorState description={query.error.message} retry={()=>void query.refetch()} />; const data=query.data ?? {}; if(view==='overview')return <RoleDashboard role="affiliate" data={data}/>; return <div className="portal-stack"><header className="portal-heading"><div><span className="eyebrow">Affiliate workspace</span><h1>{view.split('-').map((word)=>word[0]!.toUpperCase()+word.slice(1)).join(' ')}</h1><p>Attributed and financial data is calculated from verified platform records.</p></div></header>{view==='referral-link'?<Card><dl className="data-list"><div><dt>Affiliate code</dt><dd>{String(data.code??'')}</dd></div><div><dt>Referral URL</dt><dd><a href={String(data.url??'#')}>{String(data.url??'')}</a></dd></div></dl></Card>:<Lists data={data}/>} {view === 'profile' && <MfaSettings />}</div>; }
function Lists({data}:{data:Record<string,unknown>}) {
  const entries=Object.entries(data);
  const arrays=entries.filter(([,value])=>Array.isArray(value)&&value.every((item)=>item!==null&&typeof item==='object'&&!Array.isArray(item))) as Array<[string,Array<Record<string,unknown>>]>;
  const scalars=entries.filter(([,value])=>!Array.isArray(value)&&typeof value!=='object');
  const scalarArrays=entries.filter(([,value])=>Array.isArray(value)&&!value.every((item)=>item!==null&&typeof item==='object'&&!Array.isArray(item))) as Array<[string,unknown[]]>;
  if(!arrays.length&&!scalarArrays.length)return <Card><dl className="data-list">{scalars.map(([key,value])=><div key={key}><dt>{pretty(key)}</dt><dd>{String(value)}</dd></div>)}</dl></Card>;
  return <>{scalarArrays.map(([key,values])=><Card key={key}><strong>{pretty(key)}</strong><p>{values.map(String).join(', ')||'None'}</p></Card>)}{arrays.map(([key,rows])=><section key={key}><h2>{pretty(key)}</h2>{rows.length?<Table caption={pretty(key)} rows={rows} rowKey={(row,index)=>String(row.id??index)} columns={[{key:'record',header:'Record',render:(row)=><div>{Object.entries(row).filter(([,value])=>typeof value!=='object').slice(0,6).map(([name,value])=><div key={name}><strong>{pretty(name)}:</strong> {name.toLowerCase().includes('amountminor')?money(Number(value),String(row.currency??'USD')):String(value)}</div>)}</div>}]} />:<EmptyState title={`No ${pretty(key)}`} description="No verified records exist yet." />}</section>)}</>;
}
